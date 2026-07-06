// The code-owned system posture — slice 6b. The seeded Cedar text ALWAYS present in `live` (merged
// UNDER every customer slice by loadPolicyBundle): customers narrow or extend it with their own
// slices but can never remove it — forbid overrides permit, so the floor is sealed. Keep it small;
// this is the editable seed.
//
//   - reads run;
//   - writes need confirmation: a write is FORBIDDEN unless it was confirmed. The forbid overrides
//     any customer `permit`, and the needs-approval probe (re-evaluate as-if-confirmed) turns it into
//     a human gate rather than a hard deny. So an unconfirmed write — even one a customer slice tried
//     to permit outright — surfaces as needs-approval, NEVER a silent run.
//
// The floor conditions ONLY on `confirmationUsed`, which the engine injects into every request
// (mapCall hardcodes it; the probe flips it), so the clause can never touch an absent attribute.
// A previous draft keyed the floor on `context.runMode` to let interactive runs through — but
// `runMode` is an OPTIONAL fact that NO production run path stamps yet, and cedar-wasm ERRORS on the
// absent access (even under a `has` guard, verified 4.11.1) → the erroring forbid is SILENTLY
// SKIPPED → a customer `permit writes` escalates an unattended write. Fail-closed wins: require
// confirmation for EVERY write. FOLLOW-UP: once the runtime stamps `euroclaw__runMode`, the floor can
// relax to permit KNOWN-interactive writes without a per-call confirmation.
export const SYSTEM_POSTURE = `permit(principal, action in Action::"reads", resource);
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };
forbid(principal, action in Action::"writes", resource) unless { context.confirmationUsed };`;
