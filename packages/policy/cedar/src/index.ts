// @euroclaw/policy-cedar — a Cedar PDP behind the @euroclaw/contracts PolicyEngine port.
// ./contracts holds the config/context types, ./engine the PDP (deny-by-default, forbid-overrides,
// the needs-approval probe), ./plugin the cedar() factory that wires it into the chokepoint
// (model-rendered schema, action-hierarchy entities, projected-args mapCall).

export type { PolicyPlugin } from "@euroclaw/authz";
export { createPolicyPlugin } from "@euroclaw/authz";
export type {
	EntityRef,
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
export type {
	CedarContext,
	CedarEngineConfig,
	CedarEntitiesInput,
	CedarPluginConfig,
} from "./contracts";
export { cedarEngine } from "./engine";
export { cedar } from "./plugin";
