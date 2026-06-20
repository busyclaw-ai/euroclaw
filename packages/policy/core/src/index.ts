// @euroclaw/policy-core — the policy-engine PORT, plus the scaffolding that turns any engine
// into a euroclaw plugin. Engine-neutral: it speaks principal/action/resource/context (the
// universal ABAC vocabulary), never Cedar/OPA/better-auth. Each engine package implements
// `PolicyEngine`; this package wires it into core's gate pipeline as a cross-cutting,
// deny-by-default before-gate.
//
// Each policy plugin declares the REQUEST CONTEXT it needs (its `Ctx`) — Cedar wants a
// `principal`, better-auth wants `headers`. That `Ctx` is folded onto the claw's `run(prompt, ctx)`
// (the better-auth $InferContext pattern), so euroclaw invents no identity of its own: you pass
// exactly what the installed engines ask for, and each reads its own thing.

import type {
	EuroclawPlugin,
	GateDecision,
	ToolCall,
	TurnContext,
} from "@euroclaw/core";
import { validationError } from "@euroclaw/errors";
import { type } from "arktype";

export const EntityRef = type({ type: "string", id: "string" });

/** A reference to an entity in the policy model. Each engine formats it natively. */
export type EntityRef = typeof EntityRef.infer;

export const PolicyRequest = type({
	principal: EntityRef,
	action: EntityRef,
	resource: EntityRef,
	context: type.Record("string", "unknown"),
});

/** The universal authorization request (PARC — principal/action/resource/context). */
export type PolicyRequest = typeof PolicyRequest.infer;

export const PolicyResult = type({
	decision: "'permit' | 'deny' | 'needs-approval'",
	"reason?": "string | undefined",
	"policies?": type("string").array().or("undefined"),
});

/** What an engine returns. `policies` is the determining-policy trail (for the audit). */
export type PolicyResult = typeof PolicyResult.infer;

/** The port every policy engine implements (Cedar local-WASM, better-auth, SAP remote, …). */
export type PolicyEngine = {
	authorize: (req: PolicyRequest) => PolicyResult | Promise<PolicyResult>;
};

/**
 * A policy plugin that declares the per-request context (`Ctx`) it needs — folded onto the
 * claw's `run(prompt, ctx)`. The `& { $InferContext }` is what surfaces (and requires) that ctx.
 */
export type PolicyPlugin<
	Ctx extends Record<string, unknown> = Record<string, never>,
> = EuroclawPlugin & {
	$InferContext: Ctx;
};

export type PolicyPluginConfig<Ctx extends Record<string, unknown>> = {
	engine: PolicyEngine;
	/** Turn a governed tool call + the request context into a policy request — engine-specific. */
	mapCall: (call: ToolCall, ctx: Ctx) => PolicyRequest;
	/** Which calls this engine governs. Default: every call (deny-by-default allowlist). */
	matcher?: (call: ToolCall, ctx: Ctx) => boolean;
	/** Gate id (and plugin id). Default "policy". */
	id?: string;
	/** Seal the gate so it can't be removed or redefined — the unremovable org floor. */
	sealed?: boolean;
};

/**
 * Adapt any `PolicyEngine` into a euroclaw plugin: a cross-cutting before-gate that runs
 * `mapCall → engine.authorize → GateDecision` on every matched call. Engines are deny-by-default,
 * so installing this turns the agent into an allowlist; `Ctx` (inferred from `mapCall`) becomes
 * the context the caller must supply at `run`.
 */
export function createPolicyPlugin<Ctx extends Record<string, unknown>>(
	config: PolicyPluginConfig<Ctx>,
): PolicyPlugin<Ctx> {
	const id = config.id ?? "policy";
	const baseMatcher = config.matcher ?? (() => true);
	const validateRequest = (value: unknown): PolicyRequest => {
		const valid = PolicyRequest(value);
		if (valid instanceof type.errors) {
			throw validationError(`policy "${id}" request invalid`, valid.summary, {
				policyId: id,
			});
		}
		return valid;
	};
	const validateResult = (value: unknown): PolicyResult => {
		const valid = PolicyResult(value);
		if (valid instanceof type.errors) {
			throw validationError(`policy "${id}" result invalid`, valid.summary, {
				policyId: id,
			});
		}
		return valid;
	};
	return {
		id,
		// Phantom (types only): the request context this engine reads, folded onto `run`'s ctx.
		$InferContext: {} as Ctx,
		gates: [
			{
				id,
				sealed: config.sealed,
				matcher: (call: ToolCall, ctx: TurnContext) =>
					baseMatcher(call, ctx as Ctx),
				handler: async (call: ToolCall, ctx: TurnContext) => {
					const req = validateRequest(config.mapCall(call, ctx as Ctx));
					return decide(validateResult(await config.engine.authorize(req)));
				},
			},
		],
	};
}

/** Map an engine result onto core's GateDecision (deny requires a reason; carry the trail). */
function decide(result: PolicyResult): GateDecision {
	const trail = result.policies?.length
		? ` [${result.policies.join(", ")}]`
		: "";
	if (result.decision === "permit") return { decision: "permit" };
	if (result.decision === "needs-approval") {
		return {
			decision: "needs-approval",
			reason: (result.reason ?? "approval required") + trail,
		};
	}
	return {
		decision: "deny",
		reason: (result.reason ?? "no policy permits this action") + trail,
	};
}
