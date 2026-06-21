// The data contracts are arktype schemas: each one validates at a trust boundary
// AND infers its static type (single source of truth). The ports — behaviour, not
// data — stay function/object types. See docs/architecture/12-conventions.md.

import { type } from "arktype";
import type { JsonObject } from "../common";
import { jsonObject as jsonObjectSchema } from "../common";

// ── Data contracts (validate + infer) ───────────────────────────────────────

/** A tool the agent wants to call. Validated at ingress — the LLM is untrusted. */
export const toolCall = type({
	name: "string",
	args: jsonObjectSchema,
});
export type ToolCall = typeof toolCall.infer;

/** One normalized model message. Provider-specific prompt objects are normalized by adapters. */
export const modelMessage = type({
	role: "string",
	content: "string",
});
export type ModelMessage = typeof modelMessage.infer;

/** A model (LLM) request. The messages are redacted at the edge, like tool args. */
export const modelCall = type({
	"provider?": "string | undefined",
	"model?": "string | undefined",
	"parameters?": jsonObjectSchema.or("undefined"),
	"estimatedInputTokens?": "number | undefined",
	"estimatedOutputTokens?": "number | undefined",
	messages: modelMessage.array(),
});
export type ModelCall = typeof modelCall.infer;

export type ToolBoundaryCall = {
	boundary: "tool";
	name: string;
	payload: JsonObject;
	toolCall: ToolCall;
};

export type ModelBoundaryCall = {
	boundary: "model";
	name: "model";
	payload: JsonObject;
	modelCall: ModelCall;
};

/** What after-gates observe. Before-gates are still tool-only today. */
export type BoundaryCall = ToolBoundaryCall | ModelBoundaryCall;

/**
 * What a gate's handler returns. Validated — plugin gates are third-party code. On a deny/
 * needs-approval the gate may attach a `reasonCode` — a stable key into the plugin's
 * `$REASON_CODES`; governance fills the human `reason` from the catalog when the gate gives a
 * reason code but no reason. `reason` is optional here; governance guarantees it on the way out.
 */
export const gateDecision = type({ decision: "'permit'" })
	.or({ decision: "'deny'", "reason?": "string", "reasonCode?": "string" })
	.or({
		decision: "'needs-approval'",
		"reason?": "string",
		"reasonCode?": "string",
	});
export type GateDecision = typeof gateDecision.infer;

/** The outcome of handling one tool call — the SDK/wire contract. `reason` is always present on the
 * way out; `reasonCode` is the stable machine-readable key (when the deciding gate supplied one). */
export const handleResult = type({ status: "'ok'", output: "unknown" })
	.or({
		status: "'denied'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
	})
	.or({
		status: "'needs-approval'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
	});
export type HandleResult = typeof handleResult.infer;

/** What an after-gate observes: the final result, or an error if the call threw. */
export type Outcome = HandleResult | { status: "error"; reason: string };

// ── Ports (function/object types — no runtime shape to validate) ─────────────

/** Per-turn context bag. Plugins read/write here; identity & reserved keys are folded in by plugins. */
export type TurnContext = Record<string, unknown>;

// The well-known reserved context keys (the `euroclaw__` namespace). Governance OWNS the namespace and
// records the `actor`; the claw's identity/membership wiring populates these. Plugins read them.
export const ACTOR_CONTEXT_KEY = "euroclaw__actor";
export const TEAM_CONTEXT_KEY = "euroclaw__team";
export const ROLE_CONTEXT_KEY = "euroclaw__role";
export const CLAW_ID_CONTEXT_KEY = "euroclaw__clawId";
export const THREAD_ID_CONTEXT_KEY = "euroclaw__threadId";
export const RUN_ID_CONTEXT_KEY = "euroclaw__runId";
export const SUBJECT_CONTEXT_KEY = "euroclaw__subjectId";
export const TENANT_CONTEXT_KEY = "euroclaw__tenantId";
export const MEMORY_NAMESPACE_CONTEXT_KEY = "euroclaw__memoryNamespace";

/**
 * A trusted hook to enrich the (already reserved-key-stripped) context before gates run — the seam
 * where the claw stamps the resolved actor/team/role. Governance stays NEUTRAL: it runs this once per call
 * with the right ordering (after strip, before gates); it does not know what identity or membership
 * *are*. That resolution is claw-level wiring composed into this one hook.
 */
export type ContextResolver = (
	ctx: TurnContext,
) => TurnContext | Promise<TurnContext>;

/**
 * One check in the pipeline. The governance ships NONE — you register them.
 * The handler sees the REDACTED call (placeholders, not raw PII).
 */
export type Gate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: ToolCall, ctx: Ctx) => boolean;
	handler: (call: ToolCall, ctx: Ctx) => GateDecision | Promise<GateDecision>;
	/** A sealed gate cannot be removed, replaced, or disabled once registered. */
	sealed?: boolean;
};

/** A boundary-level decision gate. Current use: model/tool; future use: memory/channel/etc. */
export type BoundaryGate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: BoundaryCall, ctx: Ctx) => boolean;
	handler: (
		call: BoundaryCall,
		ctx: Ctx,
	) => GateDecision | Promise<GateDecision>;
	sealed?: boolean;
};

/**
 * An after-gate observes a finished call (the canonical one is audit). It runs in a
 * finally — even when a before-gate denied or the tool threw — so a sealed after-gate
 * is a guaranteed record. It observes; it does not decide.
 */
export type AfterGate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: BoundaryCall, ctx: Ctx) => boolean;
	handler: (
		call: BoundaryCall,
		ctx: Ctx,
		outcome: Outcome,
	) => void | Promise<void>;
	sealed?: boolean;
};

/** Handed to the tool runner so it can rehydrate PII *inside* its own boundary. */
export type ToolBoundary = {
	rehydrate: <T>(value: T) => Promise<T>;
};

/** Executes a permitted tool. Receives the REDACTED call; rehydrate only what you need. */
export type ToolRunner = (
	call: ToolCall,
	ctx: TurnContext,
	boundary: ToolBoundary,
) => unknown | Promise<unknown>;

/** Invokes the model. Receives the REDACTED call; returns the opaque model result. */
export type ModelRunner = (
	call: ModelCall,
	ctx: TurnContext,
) => unknown | Promise<unknown>;
