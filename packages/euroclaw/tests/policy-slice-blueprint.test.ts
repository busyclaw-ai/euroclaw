// The composed slice-6b proof: a customer's Cedar policy slices, stored per org (storage) and merged
// over the code-owned system posture (authz loadPolicyBundle + SYSTEM_POSTURE), routed per org by the
// count-keyed change log (authz authzBundleKey + createOrgPolicyRouter) and enforced through the
// governance chokepoint (core + policy-cedar). euroclaw stays ENGINE-AGNOSTIC: it exports the pieces;
// the HOST composes the cedar engineFor here (policy-cedar is a euroclaw devDep only). This
// composition IS euroclaw's public integration contract for customer policy.

import {
	type AuthzActionInput,
	actionEntitiesFromModel,
	authzBundleKey,
	createOrgPolicyRouter,
	createPolicyPlugin,
	createShadowPolicyEngine,
	loadPolicyBundle,
	type ShadowDivergence,
	SYSTEM_POSTURE,
} from "@euroclaw/authz";
import type { AuthzModel, PolicyEngine, ToolCall } from "@euroclaw/contracts";
import {
	ORGANIZATION_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
} from "@euroclaw/contracts";
import { createGovernance } from "@euroclaw/core";
import { cedarEngine } from "@euroclaw/policy-cedar";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createRegistryStores } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import { type ClawContext, createClawApi } from "../src/api";
import { assembleOrgActions } from "../src/index";

// Two code tools the host wrote — a read and a write — the vocabulary the org's slices govern.
const BASE_ACTIONS: AuthzActionInput[] = [
	{ id: "readDoc", source: "tool", governance: { access: "read" } },
	{ id: "writeDoc", source: "tool", governance: { access: "write" } },
];

const FORBID_READ = `forbid(principal, action == Action::"readDoc", resource);`;

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

/** Compile a neutral model + policy text into a Cedar PolicyEngine — the host's engineFor unit. The
 *  system posture conditions on groups + facts (no args), so no projection wrapper is needed. */
function compile(model: AuthzModel, policies: string): PolicyEngine {
	return cedarEngine({
		policies,
		entities: actionEntitiesFromModel(model) as never,
	});
}

function setup() {
	const stores = createRegistryStores(memoryAdapter(), { now: stamps() });
	// No registered tools here — the base vocabulary is the same for every org (only slices differ).
	const model = assembleOrgActions({
		base: BASE_ACTIONS,
		registeredTools: [],
	}).model;
	const divergences: ShadowDivergence[] = [];
	const ran: string[] = [];
	let builds = 0;

	// The HOST composition: route each decision to the org's content-addressed bundle, keyed on the
	// append-only change-log count — an edit or delete bumps the count, the next decision rebuilds.
	const router = createOrgPolicyRouter({
		keyFor: async (org) => {
			if (!org) return "system";
			return authzBundleKey({
				organizationId: org,
				changeCount: await stores.authzChanges.count(org),
			});
		},
		engineFor: async (org) => {
			builds++;
			const slices = await stores.policySlices.listByOrganization(org ?? "");
			const bundle = loadPolicyBundle({ system: SYSTEM_POSTURE, slices });
			const live = compile(model, bundle.live);
			// A candidate set exists ONLY when shadow slices do — then wrap two engines, else use live.
			if (!bundle.shadow) return live;
			return createShadowPolicyEngine({
				live,
				candidate: compile(model, bundle.shadow),
				observe: (d) => divergences.push(d),
			});
		},
	});

	const mapCall = (call: ToolCall, ctx: { principal: string }) => {
		const organizationId = Reflect.get(ctx, ORGANIZATION_CONTEXT_KEY);
		const runMode = Reflect.get(ctx, RUN_MODE_CONTEXT_KEY);
		return {
			principal: { type: "User", id: ctx.principal },
			action: { type: "Action", id: call.name },
			resource: { type: "Tool", id: call.name },
			context: {
				confirmationUsed: false,
				...(typeof organizationId === "string" ? { organizationId } : {}),
				...(typeof runMode === "string" ? { runMode } : {}),
			},
		};
	};

	const coreFor = (
		organizationId: string,
		runMode: "interactive" | "autonomous" = "interactive",
	) =>
		createGovernance({
			plugins: [createPolicyPlugin({ engine: router, mapCall })],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: organizationId,
				[RUN_MODE_CONTEXT_KEY]: runMode,
			}),
			runTool: (call) => {
				ran.push(call.name);
				return { ran: call.name };
			},
		});

	const call = (
		org: string,
		name: string,
		runMode?: "interactive" | "autonomous",
	) =>
		coreFor(org, runMode).handleToolCall(
			{ name, args: {} },
			{ principal: "alice" },
		);

	return { stores, coreFor, call, divergences, ran, getBuilds: () => builds };
}

describe("policy-slice blueprint (composed slice 6b)", () => {
	it("an enforce slice denies what the system posture allowed", async () => {
		const { call, stores } = setup();
		// Baseline: an uncustomized org runs reads (the system posture permits them).
		expect((await call("org-x", "readDoc")).status).toBe("ok");
		// A customer enforce forbid on readDoc: deny wins over the posture's permit-reads.
		await stores.policySlices.upsert({
			organizationId: "org-y",
			name: "no-reads",
			cedar: FORBID_READ,
			mode: "enforce",
			updatedBy: "admin",
		});
		expect((await call("org-y", "readDoc")).status).toBe("denied");
	});

	it("a shadow slice records a divergence WITHOUT changing the decision", async () => {
		const { call, stores, divergences } = setup();
		await stores.policySlices.upsert({
			organizationId: "org-s",
			name: "watch",
			cedar: FORBID_READ,
			mode: "shadow",
			updatedBy: "admin",
		});
		const result = await call("org-s", "readDoc");
		expect(result.status).toBe("ok"); // the live decision (permit) stands
		expect(divergences).toHaveLength(1);
		expect(divergences[0]).toMatchObject({ live: "permit", candidate: "deny" });
	});

	it("an off slice is inert (no candidate, no second evaluation)", async () => {
		const { call, stores, divergences } = setup();
		await stores.policySlices.upsert({
			organizationId: "org-o",
			name: "disabled",
			cedar: FORBID_READ,
			mode: "off",
			updatedBy: "admin",
		});
		expect((await call("org-o", "readDoc")).status).toBe("ok");
		expect(divergences).toHaveLength(0);
	});

	it("editing a slice takes effect on the next decision (count-keyed invalidation)", async () => {
		const { call, stores } = setup();
		await stores.policySlices.upsert({
			organizationId: "org-e",
			name: "guard",
			cedar: `permit(principal, action == Action::"writeDoc", resource) when { context.confirmationUsed };`,
			mode: "enforce",
			updatedBy: "admin",
		});
		expect((await call("org-e", "readDoc")).status).toBe("ok"); // guard doesn't touch reads
		// Edit the SAME slice to forbid readDoc — the upsert appends → count bumps → router rebuilds.
		await stores.policySlices.upsert({
			organizationId: "org-e",
			name: "guard",
			cedar: FORBID_READ,
			mode: "enforce",
			updatedBy: "admin",
		});
		expect((await call("org-e", "readDoc")).status).toBe("denied");
	});

	it("DELETING a slice invalidates the bundle — the case max(updatedAt) would serve stale", async () => {
		const { call, stores } = setup();
		// sliceA (added first → older, non-max updatedAt) forbids readDoc; sliceB (newer → MAX
		// updatedAt) is unrelated. Under max(updatedAt) keying, deleting the older sliceA leaves the
		// max unchanged → a STALE bundle that still forbids readDoc. Append-only count keying is sound.
		await stores.policySlices.upsert({
			organizationId: "org-d",
			name: "a-forbid",
			cedar: FORBID_READ,
			mode: "enforce",
			updatedBy: "admin",
		});
		await stores.policySlices.upsert({
			organizationId: "org-d",
			name: "b-permit",
			cedar: `permit(principal, action == Action::"writeDoc", resource) when { context.confirmationUsed };`,
			mode: "enforce",
			updatedBy: "admin",
		});
		expect((await call("org-d", "readDoc")).status).toBe("denied");
		// Delete the OLDER forbidding slice.
		for (const slice of await stores.policySlices.listByOrganization("org-d")) {
			if (slice.name === "a-forbid")
				await stores.policySlices.deleteById(slice.id);
		}
		// count bumped → cache miss → rebuild WITHOUT the forbid → readDoc runs again.
		expect((await call("org-d", "readDoc")).status).toBe("ok");
	});

	it("an uncustomized org routes to the shared 'system' bundle (built once)", async () => {
		const { call, getBuilds } = setup();
		expect((await call("empty-1", "readDoc")).status).toBe("ok");
		expect((await call("empty-2", "readDoc")).status).toBe("ok");
		expect(getBuilds()).toBe(1); // count 0 for both → the same "system" key → one build, shared
	});

	it("a malformed customer slice fails CLOSED at bundle construction — no crash-through", async () => {
		const { coreFor, stores, ran } = setup();
		// The store accepts the raw text (untrusted, stored verbatim); cedar rejects it at construction.
		await stores.policySlices.upsert({
			organizationId: "org-bad",
			name: "broken",
			cedar: "this is not valid cedar @@@",
			mode: "enforce",
			updatedBy: "admin",
		});
		await expect(
			coreFor("org-bad").handleToolCall(
				{ name: "readDoc", args: {} },
				{ principal: "alice" },
			),
		).rejects.toThrow(/Cedar/i); // engineFor throws, the router evicts, the decision fails closed
		expect(ran).not.toContain("readDoc"); // the tool NEVER ran — fail-closed, not fail-open
	});

	it("the system floor cannot be removed by a customer permit (deny wins)", async () => {
		const { call, stores } = setup();
		// A customer slice that tries to permit writes outright — laid over the sealed posture.
		await stores.policySlices.upsert({
			organizationId: "org-floor",
			name: "escalate",
			cedar: `permit(principal, action == Action::"writeDoc", resource);`,
			mode: "enforce",
			updatedBy: "admin",
		});
		// interactive: the permit applies (the autonomous forbid does not) → the write runs.
		expect((await call("org-floor", "writeDoc", "interactive")).status).toBe(
			"ok",
		);
		// autonomous + unconfirmed: the floor forbids; confirming would unblock → needs-approval,
		// NEVER a silent ok. The customer's permit could not escalate past the floor.
		expect((await call("org-floor", "writeDoc", "autonomous")).status).toBe(
			"needs-approval",
		);
	});
});

describe("policy-slice api surface", () => {
	it("put / list / delete round-trip through the claw api and append to the change log", async () => {
		const stores = createRegistryStores(memoryAdapter());
		const api = createClawApi({
			context: { registry: stores } as unknown as ClawContext,
			newId: (prefix) => prefix,
		});
		const created = await api.putPolicySlice({
			organizationId: "org-a",
			name: "s1",
			cedar: `permit(principal, action, resource);`,
			mode: "enforce",
			updatedBy: "admin",
		});
		expect(created.id).toBeTruthy();
		expect(
			await api.listPolicySlices({ organizationId: "org-a" }),
		).toHaveLength(1);
		await api.deletePolicySlice({ id: created.id });
		expect(await api.listPolicySlices({ organizationId: "org-a" })).toEqual([]);
		// put + delete each appended → the org router's count-keyed version bumped twice.
		expect(await stores.authzChanges.count("org-a")).toBe(2);
	});
});
