import type {
	PolicyEngine,
	PolicyEngineCapabilities,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { createShadowPolicyEngine, type ShadowDivergence } from "../src/index";

const req = (action = "x"): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: action },
	resource: { type: "Tool", id: action },
	context: {},
});

const fixed = (
	result: PolicyResult,
	capabilities?: PolicyEngineCapabilities,
): PolicyEngine => ({
	capabilities,
	authorize: () => result,
});

describe("createShadowPolicyEngine", () => {
	it("agreeing decisions → no observe, returns the live result verbatim", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: fixed({ decision: "permit", policies: ["cand"] }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req());
		expect(result).toEqual({ decision: "permit", policies: ["live"] }); // LIVE, not candidate
		expect(seen).toHaveLength(0);
	});

	it("candidate denies what live permits → observe once, still returns LIVE", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: fixed({ decision: "deny" }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req("readDoc"));
		expect(result.decision).toBe("permit"); // shadow NEVER changes the answer
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ live: "permit", candidate: "deny" });
		expect(seen[0]?.request.action.id).toBe("readDoc");
	});

	it("records the divergence the other direction too (live deny / candidate permit)", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "deny" }),
			candidate: fixed({ decision: "permit" }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req());
		expect(result.decision).toBe("deny"); // live stands
		expect(seen[0]).toMatchObject({ live: "deny", candidate: "permit" });
	});

	it("passes through the live engine's capabilities", () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed(
				{ decision: "permit" },
				{ reads: "identity+args", approvals: true },
			),
			candidate: fixed({ decision: "permit" }),
			observe: (d) => seen.push(d),
		});
		expect(engine.capabilities).toEqual({
			reads: "identity+args",
			approvals: true,
		});
	});
});
