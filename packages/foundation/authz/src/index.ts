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
export type { FactsOverlayEntry } from "./overlay";
export { actionInputsFromRegisteredTools, mergeFactsOverlay } from "./overlay";
export type { PolicyPlugin, PolicyPluginConfig } from "./plugin";
export { createPolicyPlugin } from "./plugin";
export type { PolicyBundle, PolicySliceLike } from "./policy-bundle";
export { authzBundleKey, loadPolicyBundle } from "./policy-bundle";
export type { ArgsProjection, ProjectedShape } from "./projection";
export { projectArgs, renderCedarType } from "./projection";
export { createOrgPolicyRouter } from "./router";
export type { ShadowDivergence } from "./shadow-engine";
export { createShadowPolicyEngine } from "./shadow-engine";
export { SYSTEM_POSTURE } from "./system-posture";
