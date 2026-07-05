// The per-tool governance CONTRACT (a port). Generic and runtime-free: `govern` just stamps
// a gate onto a tool-like object — it never runs a tool or imports a framework. Each adapter
// (the AI SDK claw, a future LangChain adapter, …) provides the IMPLEMENTATION: it reads the
// stamped `euroclaw` field and wires the gate into the pipeline. Contract here, impl there.
//
// The stamp's data shape is an arktype schema, not a plain type, because adapters read it
// back through type-ERASING framework types (the AI-SDK ToolSet drops `euroclaw` entirely),
// so the compiler cannot check what a host attached. A typo'd effect policy would fail OPEN
// (e.g. idempotency "nonee" ≠ "none" → the effect gets auto-retried); schema validation at
// the read boundary fails loud instead.

import { type } from "arktype";
import { effectCompensation } from "./effects";
import type {
	GateDecision,
	ToolCall,
	TurnContext,
} from "./governance/boundary";

export const toolEffectPolicy = type({
	"kind?": "'internal' | 'external'",
	"idempotency?": "'none' | 'optional' | 'required'",
	// What durable effect tracking may persist for retries. Default: redacted;
	// idempotency "none" defaults to none.
	"output?": "'none' | 'redacted' | 'full'",
	"compensation?": effectCompensation,
	"risk?": "'low' | 'medium' | 'high'",
});
export type ToolEffectPolicy = typeof toolEffectPolicy.infer;

/** A before-gate scoped to one tool: permit / deny / needs-approval. The signature is
 *  TS-only (params/returns are uncheckable at runtime); governance validates the gate's
 *  RESULT (`gateDecision`) every time it runs. */
export type ToolGate = (
	call: ToolCall,
	ctx: TurnContext,
) => GateDecision | Promise<GateDecision>;

/** Governance attached to a single tool — the contract an adapter reads back. Besides the gate
 *  and effect policy, the stamp carries the authorization-model FACTS (`ActionDef` fields) for
 *  hand-authored tools — what the OpenAPI/MCP generators derive from specs, an author declares
 *  here. Facts, never posture: "may the agent do this" is policy, not a tool attribute. */
export const toolGovernance = type({
	// Runtime checks callable-ness; the precise signature is the TS-level ToolGate.
	"gate?": type("Function").as<ToolGate>(),
	"effect?": toolEffectPolicy,
	// This tool's execute receives a `subInvoke` for governed nested tool calls
	// (capability tools: sandboxes, delegate). Least-authority: absent = no invoker.
	"invoker?": "true",
	// ── authz-model facts (see src/authz/model.ts) ──
	// Does this tool mutate state? Absent = "write" in the model (fail-closed under seeded
	// policies). Named `access`, not `risk` — `effect.risk` is a different axis.
	"access?": "'read' | 'write'",
	// Action groups the model places this tool's action in (`action in Action::"<group>"`).
	"groups?": "string[]",
	// The resource entity type this tool acts on (Cedar `resource` type). Default "Tool".
	"resource?": "string",
	// Force an audit record even when the action's verb isn't otherwise audited.
	"audit?": "boolean",
});
export type ToolGovernance = typeof toolGovernance.infer;

/**
 * Attach governance to a tool: `govern(tool, { gate })`. Generic — it only stamps metadata;
 * an adapter applies it by running the gate whenever that tool is called. The stamp-WRITE
 * side is compiler-checked (this signature); the read-back side validates with the schema.
 */
export function govern<T extends object>(
	tool: T,
	governance: ToolGovernance,
): T & { euroclaw: ToolGovernance } {
	return { ...tool, euroclaw: governance };
}
