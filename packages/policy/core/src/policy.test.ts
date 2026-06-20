import type { ToolCall } from "@euroclaw/core";
import { createGovernance } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import {
	createPolicyPlugin,
	type PolicyEngine,
	type PolicyRequest,
	type PolicyResult,
} from "./index";

// A fake engine that decides by the action id — keeps these tests free of any real engine.
const fakeEngine = (
	decide: (action: string) => PolicyResult,
): PolicyEngine => ({
	authorize: (req) => decide(req.action.id),
});

// This fake engine reads no request context, so Ctx is empty and no ctx is needed at the call.
const mapCall = (
	call: ToolCall,
	_ctx: Record<string, never>,
): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: call.name },
	resource: { type: "Tool", id: call.name },
	context: { args: call.args },
});

describe("@euroclaw/policy-core — createPolicyPlugin", () => {
	it("permit → the tool runs", async () => {
		let ran = false;
		const core = createGovernance({
			plugins: [
				createPolicyPlugin({
					engine: fakeEngine(() => ({ decision: "permit" })),
					mapCall,
				}),
			],
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});
		const r = await core.handleToolCall({ name: "pay", args: {} });
		expect(r.status).toBe("ok");
		expect(ran).toBe(true);
	});

	it("deny → blocked, with the determining-policy trail folded into the reason", async () => {
		let ran = false;
		const core = createGovernance({
			plugins: [
				createPolicyPlugin({
					engine: fakeEngine(() => ({
						decision: "deny",
						reason: "over limit",
						policies: ["p7"],
					})),
					mapCall,
				}),
			],
			runTool: () => {
				ran = true;
			},
		});
		const r = await core.handleToolCall({ name: "pay", args: {} });
		expect(r.status).toBe("denied");
		if (r.status === "denied") {
			expect(r.reason).toContain("over limit");
			expect(r.reason).toContain("p7");
			expect(r.gateId).toBe("policy");
		}
		expect(ran).toBe(false);
	});

	it("needs-approval → blocked, surfaced as needs-approval", async () => {
		const core = createGovernance({
			plugins: [
				createPolicyPlugin({
					engine: fakeEngine(() => ({ decision: "needs-approval" })),
					mapCall,
				}),
			],
		});
		const r = await core.handleToolCall({ name: "pay", args: {} });
		expect(r.status).toBe("needs-approval");
	});

	it("matcher scopes which calls the engine governs — unmatched calls run free", async () => {
		let evaluated = 0;
		const core = createGovernance({
			plugins: [
				createPolicyPlugin({
					engine: {
						authorize: () => {
							evaluated++;
							return { decision: "deny", reason: "no" };
						},
					},
					mapCall,
					matcher: (call) => call.name === "pay", // only `pay` is governed
				}),
			],
			runTool: () => ({ ok: true }),
		});

		const free = await core.handleToolCall({ name: "lookup", args: {} });
		expect(free.status).toBe("ok");
		expect(evaluated).toBe(0);

		const governed = await core.handleToolCall({ name: "pay", args: {} });
		expect(governed.status).toBe("denied");
		expect(evaluated).toBe(1);
	});
});
