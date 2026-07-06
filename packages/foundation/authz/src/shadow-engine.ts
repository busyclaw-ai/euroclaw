// The shadow policy engine — slice 6b. `shadow` mode is a REAL second evaluation, not a flag: this
// wraps TWO PolicyEngines (live + candidate), evaluates BOTH per decision, and when their decisions
// diverge calls an injected `observe` callback — then returns the LIVE result UNCHANGED. Shadow never
// changes the answer; it only records what the candidate WOULD have decided. Engine-agnostic and the
// contracts are untouched: `observe` is a host callback (routed to audit/telemetry), NOT a new port.
// Installed only when the bundle has a candidate set (loadPolicyBundle → bundle.shadow).

import type {
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";

export type ShadowDivergence = {
	request: PolicyRequest;
	live: PolicyResult["decision"];
	candidate: PolicyResult["decision"];
};

/** Wrap live + candidate engines: evaluate both, observe divergences, return the LIVE result. */
export function createShadowPolicyEngine(config: {
	live: PolicyEngine;
	candidate: PolicyEngine;
	observe: (divergence: ShadowDivergence) => void;
}): PolicyEngine {
	return {
		// The shadow wrapper decides nothing of its own — it speaks with the live engine's capabilities.
		capabilities: config.live.capabilities,
		async authorize(req) {
			// Both run — an org running a shadow slice accepts the doubled eval while testing.
			const [live, candidate] = await Promise.all([
				config.live.authorize(req),
				config.candidate.authorize(req),
			]);
			if (live.decision !== candidate.decision) {
				config.observe({
					request: req,
					live: live.decision,
					candidate: candidate.decision,
				});
			}
			return live;
		},
	};
}
