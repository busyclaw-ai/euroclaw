// @euroclaw/authz — the authz toolkit: the policy-plugin scaffolding, the authorization-model
// builder, the JSON-Schema→Cedar projection, and the Cedar renderings of the model. The protocol
// (PolicyEngine port, PARC contracts, model types) lives in @euroclaw/contracts; hot-path
// enforcement lives in @euroclaw/core; engines in @euroclaw/policy-* (Cedar VALIDATION included —
// the renderings here are pure string/data generation, no cedar-wasm).

export type { AuthzActionInput, BuildAuthzModelOptions } from "./build";
export { buildAuthzModel } from "./build";
export type { CedarEntityJson, CedarSchemaOptions } from "./cedar";
export {
	actionEntitiesFromModel,
	entitiesToCedarJson,
	modelToCedarSchema,
} from "./cedar";
export type { PolicyPlugin, PolicyPluginConfig } from "./plugin";
export { createPolicyPlugin } from "./plugin";
export type { ArgsProjection, ProjectedShape } from "./projection";
export { projectArgs, renderCedarType } from "./projection";
