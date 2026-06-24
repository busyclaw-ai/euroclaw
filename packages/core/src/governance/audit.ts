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

// ── Chain verification ─────────────────────────────────────────────────────

/**
 * A snapshot of a log's tip: the seq/hash an external witness pins. This is the ~tiny thing you
 * publish (RFC-3161, Rekor, a replica) — not the whole log. Validated on the way back in (an
 * anchor row is read from durable storage at verify time). See docs/architecture/14.
 */
export const auditHead = type({
	seq: "number",
	hash: "string",
	ts: "string",
	count: "number",
});
export type AuditHead = typeof auditHead.infer;

/**
 * A receipt that a head was published to an external witness. `kind`/`proof` are the witness's;
 * core treats `proof` as opaque — cryptographically validating it against the witness is the
 * anchor adapter's job (`@euroclaw/anchor-rfc3161` etc.), not core's. Validated as untrusted input
 * (it is read back from the `audit_anchor` store at verify time).
 */
export const anchorProof = type({
	head: auditHead,
	kind: "'rfc3161' | 'rekor' | 'replica' | 'kms'",
	proof: "string",
	signedAt: "string",
});
export type AnchorProof = typeof anchorProof.infer;

/** The current tip of a log — what you hand an anchor to pin. `null` for an empty log. */
export function headOf(entries: readonly AuditEntry[]): AuditHead | null {
	const last = entries.at(-1);
	if (!last) return null;
	return { seq: last.seq, hash: last.hash, ts: last.ts, count: entries.length };
}

/** One integrity problem found while walking the chain. */
export type AuditChainProblem =
	| {
			kind: "broken_link";
			seq: number;
			expectedPrevHash: string;
			actualPrevHash: string;
	  }
	| {
			kind: "hash_mismatch";
			seq: number;
			expected: string;
			actual: string;
	  }
	| {
			kind: "seq_gap";
			seq: number;
			expected: number;
			actual: number;
	  }
	// The chain diverges from what was externally published — catches a full-store rewrite.
	| {
			kind: "anchor_mismatch";
			seq: number;
			expected: string;
			actual: string;
	  }
	// An anchored seq is gone from the log — catches tail truncation below an anchor.
	| {
			kind: "anchor_missing";
			seq: number;
			anchoredHash: string;
	  }
	// An anchor row failed validation — a malformed/corrupt anchor is a problem, not a silent pass.
	| {
			kind: "anchor_invalid";
			reason: string;
	  };

/** The result of walking an audit log: an intact chain, or every problem found. */
export type AuditChainVerification =
	| { ok: true; entries: number }
	| { ok: false; entries: number; problems: readonly AuditChainProblem[] };

/**
 * Walk an audit log and verify its hash chain. For each record it checks the LINK (the record's
 * `prevHash` must equal the previous record's `hash` — GENESIS for the first), recomputes the
 * record's SHA-256 from its content and confirms it matches the stored `hash`, and flags any
 * sequence gap. It collects EVERY problem rather than stopping at the first, so an audit can see
 * the full extent of the damage.
 *
 * Without `anchors` this makes the chain's tamper-EVIDENCE operational, but it is not tamper-PROOF:
 * it catches partial tampering (a record edited, deleted, reordered, or inserted — including an
 * attacker who fixes a record's own hash, which snaps the following link) but CANNOT catch a
 * full-store rewrite (the whole log re-chained consistently) or tail truncation.
 *
 * Pass `anchors` — heads previously published to an external witness — to close that gap. Each
 * anchored head must still appear verbatim at its seq: a rewrite makes the chain diverge from
 * published history (`anchor_mismatch`), and truncating below an anchor drops the anchored seq
 * (`anchor_missing`). Core checks structural agreement only; an anchor adapter separately validates
 * each `proof` against its witness. See docs/architecture/14-audit-tamper-evidence.md.
 */
export function verifyAuditChain(
	entries: readonly AuditEntry[],
	anchors: readonly AnchorProof[] = [],
): AuditChainVerification {
	const problems: AuditChainProblem[] = [];
	const hashBySeq = new Map<number, string>();
	let expectedPrevHash = GENESIS;
	let index = 0;
	for (const entry of entries) {
		if (entry.prevHash !== expectedPrevHash) {
			problems.push({
				kind: "broken_link",
				seq: entry.seq,
				expectedPrevHash,
				actualPrevHash: entry.prevHash,
			});
		}
		// Recompute over the record minus its `hash` field — the same snapshot shape + key
		// order the writer used, so any edit after the fact changes the recomputed hash.
		const { hash, ...snapshot } = entry;
		const recomputed = hashEntry(JSON.stringify(snapshot));
		if (recomputed !== hash) {
			problems.push({
				kind: "hash_mismatch",
				seq: entry.seq,
				expected: recomputed,
				actual: hash,
			});
		}
		if (entry.seq !== index) {
			problems.push({
				kind: "seq_gap",
				seq: entry.seq,
				expected: index,
				actual: entry.seq,
			});
		}
		hashBySeq.set(entry.seq, hash);
		// The next record committed to THIS record's stored hash (not the recomputed one), so
		// "tamper content + fix own hash" still snaps the following link.
		expectedPrevHash = hash;
		index++;
	}
	// Anchors pin seq→hash in un-retractable external history. The local chain must still agree.
	// They are read back from durable storage, so validate the shape before trusting it — a
	// corrupt anchor row must surface as a problem, never pass silently.
	for (const anchor of anchors) {
		const valid = anchorProof(anchor);
		if (valid instanceof type.errors) {
			problems.push({ kind: "anchor_invalid", reason: valid.summary });
			continue;
		}
		const { seq, hash } = valid.head;
		const present = hashBySeq.get(seq);
		if (present === undefined) {
			problems.push({ kind: "anchor_missing", seq, anchoredHash: hash });
		} else if (present !== hash) {
			problems.push({
				kind: "anchor_mismatch",
				seq,
				expected: hash,
				actual: present,
			});
		}
	}
	return problems.length === 0
		? { ok: true, entries: entries.length }
		: { ok: false, entries: entries.length, problems };
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
