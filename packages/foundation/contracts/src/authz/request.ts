// The authorization REQUEST contracts — PARC (principal/action/resource/context), the universal
// ABAC vocabulary every policy engine speaks. Engine-neutral: never Cedar/OPA/better-auth shapes;
// each engine package formats these natively. Data contracts are arktype schemas because they
// validate at a trust boundary: `mapCall` results and engine answers are third-party code, and a
// malformed decision must fail LOUD at the gate, not fail open. See docs/architecture/12-conventions.md.

import { type } from "arktype";

export const entityRef = type({ type: "string", id: "string" });

/** A reference to an entity in the policy model. Each engine formats it natively. */
export type EntityRef = typeof entityRef.infer;

export const policyRequest = type({
	principal: entityRef,
	action: entityRef,
	resource: entityRef,
	context: type.Record("string", "unknown"),
});

/** The universal authorization request (PARC — principal/action/resource/context). */
export type PolicyRequest = typeof policyRequest.infer;

export const policyResult = type({
	decision: "'permit' | 'deny' | 'needs-approval'",
	"reason?": "string | undefined",
	"policies?": type("string").array().or("undefined"),
});

/** What an engine returns. `policies` is the determining-policy trail (for the audit). */
export type PolicyResult = typeof policyResult.infer;
