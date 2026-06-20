// An append-only, hash-chained audit log. Every governed call lands here — with
// REDACTED args, so PII never reaches persistence (the claim-check rule, doc 08).
// See docs/architecture/07-approval-and-audit.md.

import { validationError } from "@euroclaw/errors";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import type { JsonObject, JsonValue } from "../common";
import { jsonObject } from "../common";
import {
	ACTOR_CONTEXT_KEY,
	type AfterGate,
	type BoundaryCall,
} from "./boundary";

const OptionalString = type("string | undefined");

const AuditInputShape = {
	ts: "string",
	/** Which boundary produced this record — one log covers both. */
	boundary: "'tool' | 'model'",
	/** The tool name, or "model" for an LLM call. */
	name: "string",
	status: "'ok' | 'denied' | 'needs-approval' | 'error'",
	"gateId?": OptionalString,
	"reason?": OptionalString,
	/** The stable machine-readable governance reason code, when the deciding gate set one. */
	"reasonCode?": OptionalString,
	/** The accountable operator (the `actor`), when an IdentityResolver stamped one. */
	"actor?": OptionalString,
	/** The REDACTED details (tool args, or { messages }) — tokens only, never raw PII. */
	payload: jsonObject,
} as const;

export const auditInput = type(AuditInputShape);
export type AuditInput = typeof auditInput.infer;

export const auditEntry = type({
	...AuditInputShape,
	seq: "number",
	prevHash: "string",
	hash: "string",
});
export type AuditEntry = typeof auditEntry.infer;

export type AuditSink = {
	append: (input: AuditInput) => AuditEntry | Promise<AuditEntry>;
	entries: () => readonly AuditEntry[];
};

/**
 * SHA-256 over each chain link, via @noble/hashes — cryptographic, synchronous, and
 * runtime-agnostic (Node, Bun, Deno, Workers, browser run the same pure-JS code).
 * Deliberately NOT configurable: sha256 is the universal standard for a tamper-evident
 * chain and nobody swaps it, and the `AuditSink` is already the swap point — if you need
 * different hashing or storage, implement your own sink.
 */
const hashEntry = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

// A fixed sentinel for the first link's prevHash.
const GENESIS = "genesis";

function cloneJson<T extends JsonValue>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

export function createMemoryAudit(): AuditSink {
	const log: AuditEntry[] = [];
	return {
		append(input) {
			const valid = auditInput(input);
			if (valid instanceof type.errors) {
				throw validationError("invalid audit input", valid.summary);
			}
			const prev = log.at(-1);
			const prevHash = prev ? prev.hash : GENESIS;
			const seq = log.length;
			const snapshot = {
				...valid,
				payload: cloneJson(valid.payload),
				seq,
				prevHash,
			};
			const entry: AuditEntry = deepFreeze({
				...snapshot,
				hash: hashEntry(JSON.stringify(snapshot)),
			});
			log.push(entry);
			return entry;
		},
		entries() {
			return [...log];
		},
	};
}

function auditPayload(call: BoundaryCall): JsonObject {
	return call.payload;
}

/**
 * The audit after-gate: turns every finished call into a record on the AuditSink port.
 * It is a plain after-gate, not a privileged governance step — swap the sink to change
 * storage, seal it (via a plugin) to make the record non-removable.
 */
export function auditGate(sink: AuditSink, now: () => string): AfterGate {
	return {
		id: "audit",
		matcher: () => true,
		handler: async (call, ctx, outcome) => {
			await sink.append({
				ts: now(),
				boundary: call.boundary,
				name: call.name,
				status: outcome.status,
				gateId: "gateId" in outcome ? outcome.gateId : undefined,
				reason: "reason" in outcome ? outcome.reason : undefined,
				reasonCode: "reasonCode" in outcome ? outcome.reasonCode : undefined,
				actor:
					typeof ctx[ACTOR_CONTEXT_KEY] === "string"
						? ctx[ACTOR_CONTEXT_KEY]
						: undefined,
				payload: auditPayload(call), // REDACTED payload — no PII in the log
			});
		},
	};
}
