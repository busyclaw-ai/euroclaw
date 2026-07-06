// The Cedar governance plugin — cedar(config) wires the engine into euroclaw's chokepoint.
//
// The AUTHORIZATION MODEL drives the plugin when provided: `cedar({ model, policies })` renders
// the Cedar schema from the model (@euroclaw/authz modelToCedarSchema), merges the model's action
// hierarchy into the entities (so `action in Action::"writes"` works at evaluation time), and
// maps calls model-aware — action id = the action's id, resource type from the model, and
// `context.args` filtered to the PROJECTED subset (the same walker that rendered the schema, so
// request validation and reality never disagree).

import type { Entities } from "@cedar-policy/cedar-wasm/nodejs";
import {
	type ArgsProjection,
	actionEntitiesFromModel,
	createPolicyPlugin,
	modelToCedarSchema,
	type PolicyPlugin,
	projectArgs,
} from "@euroclaw/authz";
import type { AuthzModel, PolicyRequest, ToolCall } from "@euroclaw/contracts";
import {
	configurationError,
	stampedFacts,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type {
	CedarContext,
	CedarEntitiesInput,
	CedarPluginConfig,
} from "./contracts";
import { cedarEngine } from "./engine";

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
			// The runtime-stamped facts (role/team from membership, clawId/runMode/organizationId
			// from the runtime — spoof-proof: caller euroclaw__ keys are stripped upstream), read
			// through the ONE typed contracts reader. A garbage stamp is a host config bug: fail
			// loud here, never silently unstamped.
			const facts = stampedFacts(ctx);
			if (facts instanceof type.errors) {
				throw validationError("cedar context invalid", facts.summary);
			}
			const indexed = modelIndex?.get(call.name);
			// Model-aware args: only the PROJECTED subset crosses (Cedar records are closed — an
			// undeclared attr fails request validation; the projection dropped it from the schema).
			const args = indexed
				? indexed.projection
					? { args: indexed.projection.filter(call.args) }
					: {}
				: { args: call.args };
			// The egress origin comes from the model/binding side provider, NOT ctx — a caller/model
			// cannot forge context.server, and a tool cannot target a server it did not declare.
			const server = config.serverForAction?.(call.name);
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
					...facts,
					...(server !== undefined ? { server } : {}),
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
