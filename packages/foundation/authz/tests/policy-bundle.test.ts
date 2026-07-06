import { describe, expect, it } from "vitest";
import { loadPolicyBundle } from "../src/index";

const SYSTEM = `permit(principal, action in Action::"reads", resource);`;

describe("loadPolicyBundle", () => {
	it("enforce slices merge into live; no shadow slice ⇒ shadow undefined", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [{ name: "a", cedar: "ENFORCE_A", mode: "enforce" }],
		});
		expect(bundle.live).toContain(SYSTEM);
		expect(bundle.live).toContain("ENFORCE_A");
		expect(bundle.shadow).toBeUndefined(); // no candidate ⇒ the host skips the second engine
	});

	it("no slices ⇒ live is exactly the system posture", () => {
		const bundle = loadPolicyBundle({ system: SYSTEM, slices: [] });
		expect(bundle.live).toBe(SYSTEM);
		expect(bundle.shadow).toBeUndefined();
	});

	it("a shadow slice yields a distinct candidate (live + shadow); live EXCLUDES it", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [
				{ name: "enf", cedar: "ENFORCE_E", mode: "enforce" },
				{ name: "shd", cedar: "SHADOW_S", mode: "shadow" },
			],
		});
		expect(bundle.live).toContain("ENFORCE_E");
		expect(bundle.live).not.toContain("SHADOW_S"); // shadow is a candidate, never live
		expect(bundle.shadow).toContain("ENFORCE_E"); // candidate = live …
		expect(bundle.shadow).toContain("SHADOW_S"); // … plus the shadow slice
	});

	it("off slices are dropped from both live and the candidate", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [{ name: "off1", cedar: "OFF_O", mode: "off" }],
		});
		expect(bundle.live).toBe(SYSTEM);
		expect(bundle.live).not.toContain("OFF_O");
		expect(bundle.shadow).toBeUndefined();
	});

	it("off + shadow together: off dropped, the shadow candidate still forms", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [
				{ name: "off", cedar: "OFF_O", mode: "off" },
				{ name: "shd", cedar: "SHADOW_S", mode: "shadow" },
			],
		});
		expect(bundle.live).toBe(SYSTEM); // both off and shadow are excluded from live
		expect(bundle.shadow).toContain("SHADOW_S");
		expect(bundle.shadow).not.toContain("OFF_O");
	});
});
