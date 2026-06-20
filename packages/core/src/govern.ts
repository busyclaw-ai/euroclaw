// The per-tool governance CONTRACT (a port). Generic and runtime-free: `govern` just stamps
// a gate onto a tool-like object — it never runs a tool or imports a framework. Each adapter
// (the AI SDK claw, a future LangChain adapter, …) provides the IMPLEMENTATION: it reads the
// stamped `euroclaw` field and wires the gate into the pipeline. Contract here, impl there.

import type { EffectCompensation } from "./effects";
import type {
	GateDecision,
	ToolCall,
	TurnContext,
} from "./governance/boundary";

export type ToolEffectPolicy = {
	kind?: "internal" | "external";
	idempotency?: "none" | "optional" | "required";
	/** What durable effect tracking may persist for retries. Default: redacted; idempotency "none" defaults to none. */
	output?: "none" | "redacted" | "full";
	compensation?: EffectCompensation;
	risk?: "low" | "medium" | "high";
};

/** Governance attached to a single tool — the contract an adapter reads. */
export type ToolGovernance = {
	/** A before-gate scoped to THIS tool: permit / deny / needs-approval. */
	gate?: (
		call: ToolCall,
		ctx: TurnContext,
	) => GateDecision | Promise<GateDecision>;
	/** Effect semantics for durable execution and compensation tracking. */
	effect?: ToolEffectPolicy;
};

/**
 * Attach governance to a tool: `govern(tool, { gate })`. Generic — it only stamps metadata;
 * an adapter applies it by running the gate whenever that tool is called.
 */
export function govern<T extends object>(
	tool: T,
	governance: ToolGovernance,
): T & { euroclaw: ToolGovernance } {
	return { ...tool, euroclaw: governance };
}
