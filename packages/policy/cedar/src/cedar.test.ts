import type { ToolCall } from "@euroclaw/core";
import { createGovernance } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { cedar, cedarEngine } from "./index";

const runEcho = (call: ToolCall) => ({ ran: call.name });

const coreWith = (config: Parameters<typeof cedar>[0]) =>
	createGovernance({ plugins: [cedar(config)], runTool: runEcho });

describe("@euroclaw/policy-cedar — Cedar PDP", () => {
	it("permit: a tool with a matching permit policy runs", async () => {
		const core = coreWith({
			policies: `permit(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: { amount: 100 } },
			{ principal: "alice" },
		);
		expect(r.status).toBe("ok");
	});

	it("deny-by-default: a tool with no policy is blocked (allowlist)", async () => {
		const core = coreWith({
			policies: `permit(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "delete_account", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("denied");
	});

	it("forbid overrides permit", async () => {
		const core = coreWith({
			policies: `permit(principal, action, resource);\nforbid(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("denied");
	});

	it("needs-approval: a confirm-gated policy blocks, then permits once confirmed", async () => {
		const policies = `permit(principal, action == Action::"refund", resource) when { context.confirmationUsed };`;
		const core = coreWith({ policies });

		const unconfirmed = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(unconfirmed.status).toBe("needs-approval");

		const confirmed = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice", confirmationUsed: true },
		);
		expect(confirmed.status).toBe("ok");
	});

	it("ABAC: a tag on the principal decides — assign a tag, the policy sorts it out", async () => {
		const policies = `permit(principal, action, resource) when { principal.hasTag("department") && principal.getTag("department") == "finance" };`;
		const entities = [
			{
				uid: { type: "User", id: "alice" },
				attrs: {},
				parents: [],
				tags: { department: "finance" },
			},
			{
				uid: { type: "User", id: "bob" },
				attrs: {},
				parents: [],
				tags: { department: "sales" },
			},
		];
		const core = createGovernance({
			plugins: [cedar({ policies, entities })],
			runTool: runEcho,
		});

		const finance = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(finance.status).toBe("ok");

		const sales = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "bob" },
		);
		expect(sales.status).toBe("denied");
	});

	it("prefix namespaces the resource id as <prefix>:<tool>", async () => {
		const core = coreWith({
			policies: `permit(principal, action, resource == Tool::"agent:refund");`,
			prefix: "agent",
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("ok");
	});

	it("fails loud at construction on an invalid policy set", () => {
		expect(() => cedarEngine({ policies: `this is not cedar` })).toThrow(
			/invalid Cedar policy set/,
		);
	});

	it("membership: a resolved team role flows into the Cedar context and drives the decision", async () => {
		// a policy that only permits when the actor's resolved role is `approver`
		const policies = `permit(principal, action == Action::"send_offer", resource) when { context.role == "approver" };`;
		// resolveContext stamps euroclaw__role exactly as the claw's `membership` resolver would (the role
		// came from roleMembership({ roleOf: teamStore.roleOf }) — connecting team membership → the decision)
		const asRole = (role: string) =>
			createGovernance({
				plugins: [cedar({ policies })],
				resolveContext: (ctx) => ({ ...ctx, euroclaw__role: role }),
				runTool: runEcho,
			});

		const approver = await asRole("approver").handleToolCall(
			{ name: "send_offer", args: {} },
			{ principal: "alice" },
		);
		expect(approver.status).toBe("ok"); // role == approver → permitted

		const operator = await asRole("operator").handleToolCall(
			{ name: "send_offer", args: {} },
			{ principal: "alice" },
		);
		expect(operator.status).toBe("denied"); // role != approver → no permit matches → deny-by-default
	});
});
