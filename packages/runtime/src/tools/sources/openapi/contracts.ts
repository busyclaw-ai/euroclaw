// The OpenAPI source's contracts. An uploaded openapi.json is UNTRUSTED input — the shapes
// euroclaw actually consumes from it are arktype-validated at the point they're read (the deep
// spec walk itself stays structural: OpenAPI's polymorphism and $refs don't fit a closed
// schema). What extraction PRODUCES (tool definitions, bindings, diagnostics) is host-facing
// plain TS — not a boundary.

import type {
	SourceDiagnostic,
	SourceExtraction,
	SourceTool,
} from "@euroclaw/contracts";
import { type } from "arktype";

export const HTTP_METHODS = [
	"get",
	"put",
	"post",
	"delete",
	"patch",
	"head",
	"options",
	"trace",
] as const;
export type OpenApiMethod = (typeof HTTP_METHODS)[number];

// ── consumed spec shapes (boundary — arktype) ────────────────────────────────────────────────

/** Document gate: version + paths presence. Everything deeper validates during the walk. */
export const openApiDocument = type({
	openapi: "string",
	paths: "object",
});

export const openApiParameter = type({
	name: "string",
	in: "'path' | 'query' | 'header' | 'cookie'",
	"required?": "boolean",
	"style?": "string",
	"explode?": "boolean",
	"schema?": "unknown",
});

export const openApiRequestBody = type({
	"required?": "boolean",
	"content?": "object",
});

export const openApiServer = type({
	url: "string",
	"variables?": "object",
});

export const openApiSecurityRequirement = type("Record<string, string[]>");

// ── produced shapes (host-facing — plain TS) ─────────────────────────────────────────────────

export type OpenApiParameterBinding = {
	name: string;
	in: "path" | "query" | "header";
	required: boolean;
	/** OpenAPI serialization hints, captured verbatim for the invoker. */
	style?: string;
	explode?: boolean;
};

/** A security-scheme DEFINITION the invoker needs to PLACE a credential — the counterpart to the
 *  requirement lists in `OpenApiBinding.security`. `apiKey`: material goes into the named header or
 *  query param. `http`/`bearer`|`basic`: material becomes an `Authorization` header. `oauth2`/
 *  `openIdConnect`: only the type is captured — material comes from a token-minting resolver and is
 *  placed as a bearer token (the flow/token endpoint live inside the resolver, not here). */
export type OpenApiAuthScheme =
	| { type: "apiKey"; in: "header" | "query"; name: string }
	| { type: "http"; scheme: "bearer" | "basic" }
	| { type: "oauth2" | "openIdConnect" };

export type OpenApiBinding = {
	method: OpenApiMethod;
	/** Path template as authored, e.g. "/pets/{petId}". */
	path: string;
	/** Nearest servers[0] url (operation > path item > document), variable defaults substituted. */
	server?: string;
	parameters: readonly OpenApiParameterBinding[];
	/** JSON media type of the request body, when one was extracted. */
	bodyContentType?: string;
	bodyRequired?: boolean;
	/** The body did not flatten (non-object schema) — it lives under the single `body` input key. */
	bodyWrapped?: boolean;
	/** The spec's security requirements (operation ?? document), shape-checked but unresolved —
	 *  resolving schemes to secrets is the invoker's concern. `[]` means explicitly public. */
	security?: readonly Record<string, readonly string[]>[];
	/** The scheme DEFINITIONS the `security` requirements reference, denormalized from the document's
	 *  components.securitySchemes so the invoker stays a pure function of the row (no join to the
	 *  spec_registration blob at call time). A referenced-but-unsupported scheme is dropped with a
	 *  warning here; the invoker fails loud at call time if a REQUIRED scheme is missing. */
	authSchemes?: Record<string, OpenApiAuthScheme>;
	deprecated?: boolean;
};

// ── stored-binding boundary (arktype) ─────────────────────────────────────────────────────────
// The extractor PRODUCES OpenApiBinding as host-facing plain TS. Reading it back from a
// registered_tool row is a trust BOUNDARY (an adapter read) — the invoker parses the stored blob
// through this schema (fail loud) before it becomes a request, so a corrupted/hostile stored
// binding can never drive a fetch. Structurally the counterpart of the produced type above.

const openApiAuthSchemeSchema = type({
	type: "'apiKey'",
	in: "'header' | 'query'",
	name: "string",
})
	.or({ type: "'http'", scheme: "'bearer' | 'basic'" })
	.or({ type: "'oauth2' | 'openIdConnect'" });

export const openApiBinding = type({
	method:
		"'get' | 'put' | 'post' | 'delete' | 'patch' | 'head' | 'options' | 'trace'",
	path: "string",
	"server?": "string",
	parameters: type({
		name: "string",
		in: "'path' | 'query' | 'header'",
		required: "boolean",
		"style?": "string",
		"explode?": "boolean",
	}).array(),
	"bodyContentType?": "string",
	"bodyRequired?": "boolean",
	"bodyWrapped?": "boolean",
	"security?": openApiSecurityRequirement.array(),
	"authSchemes?": type({ "[string]": openApiAuthSchemeSchema }),
	"deprecated?": "boolean",
});

/** Input schema: parameters + (flattened) JSON body properties, local $refs inlined.
 *  Governance: verb→access, verb/tag groups (see extractor header). */
export type OpenApiTool = SourceTool<OpenApiBinding>;

/** Uniform subject ("get /pets") for generic rendering + the structured locator. */
export type OpenApiDiagnostic = SourceDiagnostic & {
	method: string;
	path: string;
};

export type OpenApiExtraction = SourceExtraction<
	OpenApiBinding,
	OpenApiDiagnostic
>;
