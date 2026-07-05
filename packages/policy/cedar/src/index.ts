// @euroclaw/policy-cedar — a Cedar PDP behind the @euroclaw/contracts PolicyEngine port.
//
// Every governed tool call is evaluated against Cedar policies, DENY-BY-DEFAULT: nothing runs
// unless a `permit` matches (an allowlist), and `forbid` overrides `permit`. Conditional
// `permit ... when { context.confirmationUsed }` policies surface as NEEDS-APPROVAL via a probe:
// on a deny, the engine re-evaluates the call as-if-confirmed; if that flips to allow, the action
// isn't forbidden — it just needs sign-off. ABAC works through principal/resource attributes and
// tags carried on the synced entity directory.
//
// The AUTHORIZATION MODEL drives the engine when provided: `cedar({ model, policies })` renders
// the Cedar schema from the model (@euroclaw/authz modelToCedarSchema), merges the model's action
// hierarchy into the entities (so `action in Action::"writes"` works at evaluation time), and
// maps calls model-aware — action id = the action's id, resource type from the model, and
// `context.args` filtered to the PROJECTED subset (the same walker that rendered the schema, so
// request validation and reality never disagree).
//
// Entities may be a static array or a PROVIDER (sync/async) — the reload seam: catalog sync and
// external-directory syncers swap what the provider returns; the engine re-reads per decision.
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
import {
	type ArgsProjection,
	actionEntitiesFromModel,
	createPolicyPlugin,
	modelToCedarSchema,
	type PolicyPlugin,
	projectArgs,
} from "@euroclaw/authz";
import {
	type AuthzModel,
	CLAW_ID_CONTEXT_KEY,
	configurationError,
	type EntityRef,
	ORGANIZATION_CONTEXT_KEY,
	type PolicyEngine,
	type PolicyRequest,
	ROLE_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type ToolCall,
	validationError,
} from "@euroclaw/contracts";

/** Cedar's request context: who is acting. Approval state is derived server-side. */
export type CedarContext = { principal: string };

/** Entities: a static array, or a PROVIDER the engine re-reads per decision (the reload seam). */
export type CedarEntitiesInput =
	| Entities
	| (() => Entities | Promise<Entities>);

export type CedarEngineConfig = {
	/** Cedar policy text — one or more `permit`/`forbid` statements (the org's policy slice). */
	policies: string;
	/** Cedar schema text. Optional; when set, requests are validated against it. */
	schema?: string;
	/** Known entities — principals (with attrs/tags/groups) and resources: the synced directory.
	 *  Pass a function to re-read per decision (catalog sync, external syncers). */
	entities?: CedarEntitiesInput;
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

	const resolveEntities = async (): Promise<Entities> => {
		if (typeof config.entities === "function") return config.entities();
		return config.entities ?? [];
	};

	// One Cedar evaluation. Never throws: a request that can't be evaluated is fail-CLOSED (deny),
	// with the error surfaced so the audit shows config breakage, not a policy deny.
	const evaluate = (
		req: PolicyRequest,
		context: Record<string, unknown>,
		entities: Entities,
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
		capabilities: { reads: "identity+args", approvals: true },
		async authorize(req) {
			// One entities snapshot per decision — the base evaluation and the probe must agree.
			const entities = await resolveEntities();
			const baseContext = { ...req.context, [approvalFlag]: false };
			const first = evaluate(req, baseContext, entities);
			if (first.error)
				return { decision: "deny", reason: `cedar error: ${first.error}` };
			if (first.allow) return { decision: "permit", policies: first.policies };

			// Probe: would confirmation unblock it? If yes, it's needs-approval, not a hard deny.
			const probed = evaluate(
				req,
				{ ...baseContext, [approvalFlag]: true },
				entities,
			);
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
	/** The authorization model: renders the Cedar schema, merges the action hierarchy into the
	 *  entities, and switches `mapCall` to model-aware (projected-args filtering, resource types
	 *  from the model). Mutually exclusive with `schema`. */
	model?: AuthzModel;
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

type ModelIndexEntry = {
	resourceType: string;
	projection: ArgsProjection | undefined;
};

/** Per-action lookup, projected ONCE at construction (render and filter share the walker). */
function indexModel(model: AuthzModel): Map<string, ModelIndexEntry> {
	const index = new Map<string, ModelIndexEntry>();
	for (const action of model.actions) {
		index.set(action.id, {
			resourceType: action.resourceType,
			projection: action.args ? projectArgs(action.args) : undefined,
		});
	}
	return index;
}

/**
 * The Cedar governance plugin. `euroclaw({ plugins: [cedar({ policies })] })` makes every tool call
 * answer to Cedar (deny-by-default), and `run(prompt, { principal })` supplies who's acting. The
 * default `mapCall` governs by tool name:
 *   principal = `${principalType}::"${ctx.principal}"`, action = `Action::"<tool>"`,
 *   resource  = `${resourceType}::"<tool>"`, context = `{ args, <approvalFlag>, … }`.
 * With `model`, the schema is rendered from the model and `context.args` carries only the
 * PROJECTED subset for the matched action.
 */
export function cedar(config: CedarPluginConfig): PolicyPlugin<CedarContext> {
	if (config.model && config.schema !== undefined) {
		throw configurationError(
			"cedar: provide `model` (schema is rendered from it) or `schema`, not both",
		);
	}
	const principalType = config.principalType ?? "User";
	const resourceType = config.resourceType ?? "Tool";
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const resourceId = (name: string) =>
		config.prefix ? `${config.prefix}:${name}` : name;
	const modelIndex = config.model ? indexModel(config.model) : undefined;

	// With a model: the action hierarchy must exist at EVALUATION time for `action in`, so the
	// model's action entities merge into whatever the host's entities (or provider) supply.
	const schema = config.model
		? modelToCedarSchema(config.model)
		: config.schema;
	const actionEntities = config.model
		? (actionEntitiesFromModel(config.model) as Entities)
		: undefined;
	const entities: CedarEntitiesInput | undefined = actionEntities
		? async () => {
				const base =
					typeof config.entities === "function"
						? await config.entities()
						: (config.entities ?? []);
				return [...base, ...actionEntities] as Entities;
			}
		: config.entities;

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
			// keys are read at runtime (they aren't part of CedarContext's caller-facing surface) —
			// role/team from membership, clawId/runMode stamped by the runtime (spoof-proof).
			const role = Reflect.get(ctx, ROLE_CONTEXT_KEY);
			const team = Reflect.get(ctx, TEAM_CONTEXT_KEY);
			const clawId = Reflect.get(ctx, CLAW_ID_CONTEXT_KEY);
			const runMode = Reflect.get(ctx, RUN_MODE_CONTEXT_KEY);
			const organizationId = Reflect.get(ctx, ORGANIZATION_CONTEXT_KEY);
			const indexed = modelIndex?.get(call.name);
			// Model-aware args: only the PROJECTED subset crosses (Cedar records are closed — an
			// undeclared attr fails request validation; the projection dropped it from the schema).
			const args = indexed
				? indexed.projection
					? { args: indexed.projection.filter(call.args) }
					: {}
				: { args: call.args };
			return {
				principal: { type: principalType, id: ctx.principal },
				action: { type: "Action", id: call.name },
				resource: {
					type: indexed?.resourceType ?? resourceType,
					id: resourceId(call.name),
				},
				context: {
					...args,
					[approvalFlag]: false,
					...(typeof role === "string" ? { role } : {}),
					...(typeof team === "string" ? { team } : {}),
					...(typeof clawId === "string" ? { clawId } : {}),
					// Narrowed to the RunMode contract — a garbage host value doesn't stamp at all
					// (same "stamped when resolution provides it" semantics as the other facts).
					...(runMode === "interactive" || runMode === "autonomous"
						? { runMode }
						: {}),
					...(typeof organizationId === "string" ? { organizationId } : {}),
				},
			};
		});
	return createPolicyPlugin({
		engine: cedarEngine({
			policies: config.policies,
			...(schema !== undefined ? { schema } : {}),
			...(entities !== undefined ? { entities } : {}),
			...(config.validateRequest !== undefined
				? { validateRequest: config.validateRequest }
				: {}),
			...(config.approvalFlag !== undefined
				? { approvalFlag: config.approvalFlag }
				: {}),
		}),
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
