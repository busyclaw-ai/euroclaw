// The redactor: PII in → scoped opaque placeholders out, and back again. The governance talks only to the
// redact/rehydrate transform; a PiiMappingStore is the re-identification store that maps each
// placeholder back to original PII. Deleting a subject's mappings is the erasure primitive.
// See docs/architecture/03-pii-and-erasure.md.

import { validationError } from "@euroclaw/errors";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import type { EntityRecord } from "../entity";
import { entity, field } from "../entity";
import {
	MEMORY_NAMESPACE_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	TENANT_CONTEXT_KEY,
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
	tenantId: field.string({ index: true }),
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
		ctx?: Pick<RedactionContext, "tenantId">,
	) => void | Promise<void>;
};

export const redactionContext = type({
	"subjectId?": "string | undefined",
	"tenantId?": "string | undefined",
	"memoryNamespace?": "string | undefined",
});
export type RedactionContext = typeof redactionContext.infer;

export const rehydrationContext = redactionContext;
export type RehydrationContext = typeof rehydrationContext.infer;

export function redactionContextFrom(
	ctx: TurnContext,
): RedactionContext | undefined {
	const subjectId = ctx[SUBJECT_CONTEXT_KEY];
	const tenantId = ctx[TENANT_CONTEXT_KEY];
	const memoryNamespace = ctx[MEMORY_NAMESPACE_CONTEXT_KEY];
	const out: RedactionContext = {};
	if (typeof subjectId === "string") out.subjectId = subjectId;
	if (typeof tenantId === "string") out.tenantId = tenantId;
	if (typeof memoryNamespace === "string") {
		out.memoryNamespace = memoryNamespace;
	}
	return out.subjectId === undefined &&
		out.tenantId === undefined &&
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

const PLACEHOLDER = /\{\{pii:[a-z0-9]+\}\}/g;

/**
 * The neutral default: detects nothing, so redaction is a no-op until you opt in.
 * Concrete detectors (email, Presidio, an NER model) are yours to bring — the governance ships
 * only the mechanism, never a policy about what counts as PII.
 */
export const noopDetector: Detector = () => [];

function newPlaceholder(): string {
	return `{{pii:${bytesToHex(randomBytes(16))}}}`;
}

function scopeKey(ctx?: RedactionContext): string {
	return [
		ctx?.tenantId ?? "",
		ctx?.subjectId ?? "",
		ctx?.memoryNamespace ?? "",
	].join(":");
}

export function createMemoryPiiMappingStore(): PiiMappingStore {
	const byKey = new Map<string, PiiMapping>();
	const keyFor = (placeholder: string, ctx?: RedactionContext): string =>
		`${scopeKey(ctx)}:${placeholder}`;
	return {
		durable: false,
		save(mapping) {
			const valid = piiMapping(mapping) as PiiMapping | type.errors;
			if (valid instanceof type.errors) {
				throw validationError("invalid PII mapping", valid.summary);
			}
			byKey.set(keyFor(valid.placeholder, valid), valid);
		},
		resolve(placeholder, ctx) {
			return byKey.get(keyFor(placeholder, ctx))?.original ?? null;
		},
		deleteForSubject(subjectId, ctx) {
			for (const [key, mapping] of byKey) {
				if (
					mapping.subjectId === subjectId &&
					(ctx?.tenantId === undefined || mapping.tenantId === ctx.tenantId)
				) {
					byKey.delete(key);
				}
			}
		},
	};
}

export type StoredRedactorOptions = {
	detector?: Detector;
	mappings: PiiMappingStore;
	now?: () => string;
};

function cleanSpans(spans: PiiSpan[], textLength: number): PiiSpan[] {
	const out: PiiSpan[] = [];
	let lastEnd = 0;
	for (const span of [...spans].sort(
		(a, b) => a.start - b.start || b.end - a.end,
	)) {
		if (span.start < lastEnd) continue;
		if (span.start < 0 || span.end > textLength || span.start >= span.end)
			continue;
		out.push(span);
		lastEnd = span.end;
	}
	return out;
}

function validateRedactionContext(
	ctx: RedactionContext | undefined,
): RedactionContext | undefined {
	if (ctx === undefined) return undefined;
	const valid = redactionContext(ctx);
	if (valid instanceof type.errors) {
		throw validationError("invalid redaction context", valid.summary);
	}
	return valid;
}

function validateRehydrationContext(
	ctx: RehydrationContext | undefined,
): RehydrationContext | undefined {
	if (ctx === undefined) return undefined;
	const valid = rehydrationContext(ctx);
	if (valid instanceof type.errors) {
		throw validationError("invalid rehydration context", valid.summary);
	}
	return valid;
}

/** Build a Redactor backed by a PiiMappingStore. */
export function createStoredRedactor(options: StoredRedactorOptions): Redactor {
	const detect = options.detector ?? noopDetector;
	const now = options.now ?? (() => new Date().toISOString());
	const mappings = options.mappings;

	const redactText = async (
		text: string,
		ctx?: RedactionContext,
	): Promise<string> => {
		const detected = piiSpans(detect(text));
		if (detected instanceof type.errors) {
			throw validationError(
				"detector returned invalid PII spans",
				detected.summary,
			);
		}
		const spans = cleanSpans(detected, text.length);
		if (spans.length === 0) return text;
		let out = "";
		let last = 0;
		for (const span of spans) {
			const placeholder = newPlaceholder();
			await mappings.save({
				placeholder,
				original: span.value,
				kind: span.kind,
				subjectId: ctx?.subjectId,
				tenantId: ctx?.tenantId,
				memoryNamespace: ctx?.memoryNamespace,
				createdAt: now(),
			});
			out += text.slice(last, span.start) + placeholder;
			last = span.end;
		}
		return out + text.slice(last);
	};

	const rehydrateText = async (
		text: string,
		ctx?: RehydrationContext,
	): Promise<string> => {
		let out = "";
		let last = 0;
		for (const match of text.matchAll(PLACEHOLDER)) {
			const placeholder = match[0];
			const start = match.index ?? 0;
			out += text.slice(last, start);
			out += (await mappings.resolve(placeholder, ctx)) ?? placeholder;
			last = start + placeholder.length;
		}
		return out + text.slice(last);
	};

	const isRedactableObject = (v: unknown): v is Record<string, unknown> => {
		if (v === null || typeof v !== "object") return false;
		const proto = Object.getPrototypeOf(v);
		return proto === Object.prototype || proto === null;
	};

	const walk = async (
		value: unknown,
		fn: (s: string) => Promise<string>,
	): Promise<unknown> => {
		if (typeof value === "string") return fn(value);
		if (Array.isArray(value)) return Promise.all(value.map((v) => walk(v, fn)));
		if (isRedactableObject(value)) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = await walk(v, fn);
			return out;
		}
		// Numbers, booleans, null, and non-plain objects (Uint8Array, Date, URL, class
		// instances — e.g. binary parts in a model prompt) pass through untouched.
		return value;
	};

	return {
		durable: mappings.durable === true,
		async redactValue<T>(value: T, ctx?: RedactionContext): Promise<T> {
			const validCtx = validateRedactionContext(ctx);
			return (await walk(value, (text) => redactText(text, validCtx))) as T;
		},
		async rehydrateValue<T>(value: T, ctx?: RehydrationContext): Promise<T> {
			const validCtx = validateRehydrationContext(ctx);
			return (await walk(value, (text) => rehydrateText(text, validCtx))) as T;
		},
	};
}

export function createMemoryRedactor(
	detect: Detector = noopDetector,
): Redactor {
	return createStoredRedactor({
		detector: detect,
		mappings: createMemoryPiiMappingStore(),
	});
}
