// The redaction CONTRACTS: the PII span/mapping schemas, the re-identification store port, and the
// Redactor port the governance pipeline talks to. The redactor IMPLEMENTATIONS (the actual
// redact/rehydrate engine) live in @euroclaw/core — privacy is enforced there, not declared here.
// See docs/architecture/03-pii-and-erasure.md.

import { type } from "arktype";
import type { EntityRecord } from "../entity";
import { entity, field } from "../entity";
import {
	MEMORY_NAMESPACE_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	type TurnContext,
} from "./boundary";

const piiKindValues = [
	"email",
	"phone",
	"name",
	"address",
	"date",
	"id",
	"card",
	"secret",
	"url",
] as const;

export const piiKind = type(
	"'email' | 'phone' | 'name' | 'address' | 'date' | 'id' | 'card' | 'secret' | 'url'",
);
export type PiiKind = (typeof piiKindValues)[number];

export const piiSpanSource = type("'regex' | 'schema' | 'plugin' | 'model'");
export type PiiSpanSource = typeof piiSpanSource.infer;

export const piiSpan = type({
	/** Byte/string offsets into the original JavaScript string. */
	start: "number",
	end: "number",
	value: "string",
	kind: piiKind,
	"confidence?": "number | undefined",
	"source?": piiSpanSource.or("undefined"),
});
export type PiiSpan = typeof piiSpan.infer;

export const piiSpans = piiSpan.array();
export type PiiSpans = typeof piiSpans.infer;

export const piiMappingFields = {
	placeholder: field.string({ required: true, index: true }),
	original: field.string({ required: true, pii: "contains" }),
	kind: field.enum(piiKindValues, { required: true, index: true }),
	subjectId: field.string({ index: true }),
	organizationId: field.string({ index: true }),
	memoryNamespace: field.string({ index: true }),
	createdAt: field.string({ required: true }),
} as const;

export const piiMappingEntity = entity("pii_mapping", piiMappingFields);
export const piiMapping = piiMappingEntity.record;
export type PiiMapping = EntityRecord<typeof piiMappingFields>;

/** The storage schema backing durable PiiMappingStore. */
export const piiMappingSchema = piiMappingEntity.storage;

/** The re-identification store: placeholder → original PII, scoped for erasure. */
export type PiiMappingStore = {
	durable?: boolean;
	save: (mapping: PiiMapping) => void | Promise<void>;
	resolve: (
		placeholder: string,
		ctx?: RehydrationContext,
	) => string | null | Promise<string | null>;
	deleteForSubject: (
		subjectId: string,
		ctx?: Pick<RedactionContext, "organizationId">,
	) => void | Promise<void>;
};

export const redactionContext = type({
	"subjectId?": "string | undefined",
	"organizationId?": "string | undefined",
	"memoryNamespace?": "string | undefined",
});
export type RedactionContext = typeof redactionContext.infer;

export const rehydrationContext = redactionContext;
export type RehydrationContext = typeof rehydrationContext.infer;

export function redactionContextFrom(
	ctx: TurnContext,
): RedactionContext | undefined {
	const subjectId = ctx[SUBJECT_CONTEXT_KEY];
	const organizationId = ctx[ORGANIZATION_CONTEXT_KEY];
	const memoryNamespace = ctx[MEMORY_NAMESPACE_CONTEXT_KEY];
	const out: RedactionContext = {};
	if (typeof subjectId === "string") out.subjectId = subjectId;
	if (typeof organizationId === "string") out.organizationId = organizationId;
	if (typeof memoryNamespace === "string") {
		out.memoryNamespace = memoryNamespace;
	}
	return out.subjectId === undefined &&
		out.organizationId === undefined &&
		out.memoryNamespace === undefined
		? undefined
		: out;
}

/** Finds PII spans in a string. Swap in a model/Presidio detector later. */
export type Detector = (text: string) => PiiSpan[];

/** Redact/rehydrate any value (deep). The governance talks only to this shape. */
export type Redactor = {
	durable?: boolean;
	redactValue: <T>(value: T, ctx?: RedactionContext) => Promise<T>;
	rehydrateValue: <T>(value: T, ctx?: RehydrationContext) => Promise<T>;
};
