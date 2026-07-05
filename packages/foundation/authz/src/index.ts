// @euroclaw/authz — the authz toolkit: the policy-plugin scaffolding and the authorization-model
// builder. The protocol (PolicyEngine port, PARC contracts, model types) lives in
// @euroclaw/contracts; hot-path enforcement lives in @euroclaw/core; engines in @euroclaw/policy-*.

export type { AuthzActionInput, BuildAuthzModelOptions } from "./build";
export { buildAuthzModel } from "./build";
export type { PolicyPlugin, PolicyPluginConfig } from "./plugin";
export { createPolicyPlugin } from "./plugin";
