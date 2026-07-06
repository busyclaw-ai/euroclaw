import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createRegistryStores } from "../src/registry";

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

describe("createRegistryStores — authz_change (append-only log)", () => {
	it("append stamps id + at and round-trips the summary", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		const record = await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: "admin",
		});
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(record.at).toBe("2026-01-01T00:00:00Z");
		const listed = await authzChanges.listByOrganization("org-a");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: "admin",
		});
	});

	it("append works without a summary (optional)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		const record = await authzChanges.append({
			organizationId: "org-a",
			kind: "spec_registered",
			by: "alice",
		});
		expect(record.summary).toBeUndefined();
	});

	it("count reflects appends and only grows (monotonic)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		expect(await authzChanges.count("org-a")).toBe(0); // no changes yet → the shared bundle
		await authzChanges.append({
			organizationId: "org-a",
			kind: "overlay_changed",
			by: "admin",
		});
		expect(await authzChanges.count("org-a")).toBe(1);
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "admin",
		});
		expect(await authzChanges.count("org-a")).toBe(2);
	});

	it("count is scoped by org — org A's appends never change org B's count", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "admin",
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "admin",
		});
		expect(await authzChanges.count("org-a")).toBe(2);
		expect(await authzChanges.count("org-b")).toBe(0);
	});

	it("listByOrganization returns the history oldest-first, scoped by org", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "spec_registered",
			summary: { source: "petstore" },
			by: "alice",
		});
		await authzChanges.append({
			organizationId: "org-b",
			kind: "policy_changed",
			by: "bob",
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			summary: { slice: "guard" },
			by: "alice",
		});
		const a = await authzChanges.listByOrganization("org-a");
		expect(a.map((c) => c.kind)).toEqual(["spec_registered", "policy_changed"]);
		expect(a.every((c) => c.organizationId === "org-a")).toBe(true);
	});

	it("rejects a malformed stored change row (out-of-enum kind)", async () => {
		const adapter = memoryAdapter();
		const { authzChanges } = createRegistryStores(adapter);
		await adapter.create({
			model: "authz_change",
			data: {
				id: "bad",
				organizationId: "org-bad",
				kind: "mystery", // not a known change kind
				at: "t",
				by: "a",
			},
		});
		await expect(authzChanges.listByOrganization("org-bad")).rejects.toThrow(
			"authz change record invalid",
		);
	});
});
