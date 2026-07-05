// The OpenAPI source's contracts. An uploaded openapi.json is UNTRUSTED input — the shapes
// euroclaw actually consumes from it are arktype-validated at the point they're read (the deep
// spec walk itself stays structural: OpenAPI's polymorphism and $refs don't fit a closed
// schema). What extraction PRODUCES (tool definitions, bindings, diagnostics) is host-facing
// plain TS — not a boundary.

import { type } from "arktype";
import type {
	SourceDiagnostic,
	SourceExtraction,
	SourceTool,
} from "../contracts";

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
	deprecated?: boolean;
};

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
