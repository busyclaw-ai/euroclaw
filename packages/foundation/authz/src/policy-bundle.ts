// The per-organization policy BUNDLE — slice 6b. A pure merge of the code-owned system posture with a
// customer's stored policy slices. Engine-agnostic: this produces the policy-set TEXT (the cedar
// engine takes ONE policy-set string); the host compiles it into a PolicyEngine. A settled ruling
// lives here: `shadow` is a REAL second evaluation, not an include/exclude flag — the bundle carries
// a `shadow` CANDIDATE set only when shadow slices exist, and the host wraps two engines with
// createShadowPolicyEngine. No shadow slices ⇒ no candidate ⇒ the live engine is used directly.

export type PolicySliceLike = {
	name: string;
	cedar: string;
	mode: "enforce" | "shadow" | "off";
};

export type PolicyBundle = {
	/** The enforced policy text — system posture + every enforce slice. The REAL decision. */
	live: string;
	/** The candidate policy text — live + every shadow slice — or undefined when no shadow slice
	 *  exists (so the caller skips the second engine entirely). */
	shadow?: string;
};

/**
 * Merge the system posture with a customer's slices into the policy-set text the engine compiles.
 * `enforce` slices join `live`; `shadow` slices produce a distinct `candidate` (only when at least one
 * exists); `off` slices are dropped. Pure — the input is stored rows (already parsed) or host config.
 */
export function loadPolicyBundle(input: {
	system: string;
	slices: readonly PolicySliceLike[];
}): PolicyBundle {
	const enforce: string[] = [];
	const shadow: string[] = [];
	for (const slice of input.slices) {
		if (slice.mode === "enforce") enforce.push(slice.cedar);
		else if (slice.mode === "shadow") shadow.push(slice.cedar);
		// `off` — dropped entirely.
	}
	const live = [input.system, ...enforce].join("\n");
	if (shadow.length === 0) return { live };
	return { live, shadow: [live, ...shadow].join("\n") };
}
