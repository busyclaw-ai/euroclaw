// The code-owned system posture — slice 6b. The seeded Cedar text ALWAYS present in `live` (merged
// UNDER every customer slice by loadPolicyBundle): customers narrow or extend it with their own
// slices but can never remove it — deny wins, so the floor is sealed. Keep it small; this is the
// editable seed.
//
//   - reads run;
//   - writes need confirmation (permit only when a human confirmed);
//   - autonomous writes are forbidden unless a human confirmed — the floor a customer `permit` cannot
//     escalate past (forbid overrides permit; the needs-approval probe is the intended human gate).
export const SYSTEM_POSTURE = `permit(principal, action in Action::"reads", resource);
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };
forbid(principal, action in Action::"writes", resource) when { context.runMode == "autonomous" && !context.confirmationUsed };`;
