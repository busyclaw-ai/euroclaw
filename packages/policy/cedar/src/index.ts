// @euroclaw/policy-cedar — a Cedar PDP behind the @euroclaw/policy-core PolicyEngine port.
//
// Every governed tool call is evaluated against Cedar policies, DENY-BY-DEFAULT: nothing runs
// unless a `permit` matches (an allowlist), and `forbid` overrides `permit`. Conditional
// `permit ... when { context.confirmationUsed }` policies surface as NEEDS-APPROVAL via a probe:
// on a deny, the engine re-evaluates the call as-if-confirmed; if that flips to allow, the action
// isn't forbidden — it just needs sign-off. ABAC works through principal/resource attributes and
// tags carried on the synced entity directory.
//
// At request time you pass Cedar's own thing — a `principal`:
//   claw.run(prompt, { principal: "alice" })
//
// Uses cedar-wasm's stateless `isAuthorized` for clarity. When the PDP gets hot, swap to
// `preparsePolicySet` + `statefulIsAuthorized` (parse the policy text once) — same answers.
// The /nodejs build loads the WASM synchronously (fs.readFileSync) — server-side, no async init.

import type {
	AuthorizationCall,
	Entities,
} from "@cedar-policy/cedar-wasm/nodejs";
import {
	checkParsePolicySet,
	checkParseSchema,
	isAuthorized,
} from "@cedar-policy/cedar-wasm/nodejs";
import { createPolicyPlugin, type PolicyPlugin } from "@euroclaw/authz";
import {
	configurationError,
	type EntityRef,
	type PolicyEngine,
	type PolicyRequest,
	ROLE_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type ToolCall,
	validationError,
} from "@euroclaw/contracts";

/** Cedar's request context: who is acting. Approval state is derived server-side. */
export type CedarContext = { principal: string };

export type CedarEngineConfig = {
	/** Cedar policy text — one or more `permit`/`forbid` statements (the org's policy slice). */
	policies: string;
	/** Cedar schema text. Optional; when set, requests are validated against it. */
	schema?: string;
	/** Known entities — principals (with attrs/tags/groups) and resources: the synced directory. */
	entities?: Entities;
	/** Validate each request against the schema (needs `schema`). Default: true when `schema` is set. */
	validateRequest?: boolean;
	/** Context key for "confirmation was used" — the needs-approval probe. Default "confirmationUsed". */
	approvalFlag?: string;
};

const toUid = (e: EntityRef) => ({ type: e.type, id: e.id });

/** A Cedar PDP as a PolicyEngine: deny-by-default, forbid-overrides, with a needs-approval probe. */
export function cedarEngine(config: CedarEngineConfig): PolicyEngine {
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const policies = { staticPolicies: config.policies };
	const entities: Entities = config.entities ?? [];
	const validateRequest = config.validateRequest ?? config.schema !== undefined;

	// Fail LOUD at construction for a broken policy set / schema — a config bug, not a runtime deny.
	const parsedPolicies = checkParsePolicySet(policies);
	if (parsedPolicies.type === "failure") {
		throw configurationError(
			`invalid Cedar policy set: ${parsedPolicies.errors.map((e) => e.message).join("; ")}`,
		);
	}
	if (config.schema !== undefined) {
		const parsedSchema = checkParseSchema(config.schema);
		if (parsedSchema.type === "failure") {
			throw configurationError(
				`invalid Cedar schema: ${parsedSchema.errors.map((e) => e.message).join("; ")}`,
			);
		}
	}

	// One Cedar evaluation. Never throws: a request that can't be evaluated is fail-CLOSED (deny),
	// with the error surfaced so the audit shows config breakage, not a policy deny.
	const evaluate = (
		req: PolicyRequest,
		context: Record<string, unknown>,
	): { allow: boolean; policies: string[]; error?: string } => {
		try {
			const call: AuthorizationCall = {
				principal: toUid(req.principal),
				action: toUid(req.action),
				resource: toUid(req.resource),
				context: context as AuthorizationCall["context"],
				policies,
				entities,
				...(config.schema !== undefined
					? { schema: config.schema, validateRequest }
					: {}),
			};
			const answer = isAuthorized(call);
			if (answer.type === "failure") {
				return {
					allow: false,
					policies: [],
					error: answer.errors.map((e) => e.message).join("; "),
				};
			}
			return {
				allow: answer.response.decision === "allow",
				policies: answer.response.diagnostics.reason,
			};
		} catch (err) {
			return {
				allow: false,
				policies: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	};

	return {
		authorize(req) {
			const baseContext = { ...req.context, [approvalFlag]: false };
			const first = evaluate(req, baseContext);
			if (first.error)
				return { decision: "deny", reason: `cedar error: ${first.error}` };
			if (first.allow) return { decision: "permit", policies: first.policies };

			// Probe: would confirmation unblock it? If yes, it's needs-approval, not a hard deny.
			const probed = evaluate(req, { ...baseContext, [approvalFlag]: true });
			if (!probed.error && probed.allow) {
				return {
					decision: "needs-approval",
					reason: "confirmation required",
					policies: probed.policies,
				};
			}
			return { decision: "deny", policies: first.policies };
		},
	};
}

export type CedarPluginConfig = CedarEngineConfig & {
	/** Map a tool call + Cedar context to (principal, action, resource, context). Override for ABAC. */
	mapCall?: (call: ToolCall, ctx: CedarContext) => PolicyRequest;
	/** Which calls Cedar governs. Default: every call (the allowlist). */
	matcher?: (call: ToolCall, ctx: CedarContext) => boolean;
	/** Entity type for the default-mapped principal (from `ctx.principal`). Default "User". */
	principalType?: string;
	/** Entity type for the default-mapped resource (the tool itself). Default "Tool". */
	resourceType?: string;
	/** Namespace the resource id as `<prefix>:<tool>` (default none — the bare tool name). */
	prefix?: string;
	/** Gate/plugin id. Default "policy:cedar". */
	id?: string;
	/** Seal the gate — the org floor can't be removed or redefined. Default false. */
	sealed?: boolean;
};

/**
 * The Cedar governance plugin. `euroclaw({ plugins: [cedar({ policies })] })` makes every tool call
 * answer to Cedar (deny-by-default), and `run(prompt, { principal })` supplies who's acting. The
 * default `mapCall` governs by tool name:
 *   principal = `${principalType}::"${ctx.principal}"`, action = `Action::"<tool>"`,
 *   resource  = `${resourceType}::"<tool>"`, context = `{ args, <approvalFlag> }`.
 */
export function cedar(config: CedarPluginConfig): PolicyPlugin<CedarContext> {
	const principalType = config.principalType ?? "User";
	const resourceType = config.resourceType ?? "Tool";
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const resourceId = (name: string) =>
		config.prefix ? `${config.prefix}:${name}` : name;
	const mapCall =
		config.mapCall ??
		((call: ToolCall, ctx: CedarContext): PolicyRequest => {
			if (typeof ctx.principal !== "string") {
				throw validationError(
					"cedar context invalid",
					"principal must be a string",
				);
			}
			// Membership resolved upstream (the claw's `membership`) flows into the Cedar context, so a
			// team role drives the decision: `permit(...) when { context.role == "approver" }`. Reserved
			// keys are read at runtime (they aren't part of CedarContext's caller-facing surface).
			const role = Reflect.get(ctx, ROLE_CONTEXT_KEY);
			const team = Reflect.get(ctx, TEAM_CONTEXT_KEY);
			return {
				principal: { type: principalType, id: ctx.principal },
				action: { type: "Action", id: call.name },
				resource: { type: resourceType, id: resourceId(call.name) },
				context: {
					args: call.args,
					[approvalFlag]: false,
					...(typeof role === "string" ? { role } : {}),
					...(typeof team === "string" ? { team } : {}),
				},
			};
		});
	return createPolicyPlugin({
		engine: cedarEngine(config),
		mapCall,
		matcher: config.matcher,
		id: config.id ?? "policy:cedar",
		sealed: config.sealed,
	});
}

export type { PolicyPlugin } from "@euroclaw/authz";
export { createPolicyPlugin } from "@euroclaw/authz";
export type {
	EntityRef,
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
