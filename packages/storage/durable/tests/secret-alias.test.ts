import type { Adapter } from "@euroclaw/contracts";
import { EuroclawError } from "@euroclaw/contracts";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createSecretAliasStore } from "../src/secret-alias";

const now = () => "2026-01-01T00:00:00.000Z";
const later = () => "2026-02-02T00:00:00.000Z";

describe("createSecretAliasStore", () => {
	it("sets a pointer, gets it, and lists it per org", async () => {
		const store = createSecretAliasStore(memoryAdapter(), { now });
		const created = await store.set("org-a", "TELEGRAM_BOT_TOKEN", {
			provider: "vault",
			ref: "kv/telegram",
		});
		expect(created).toMatchObject({
			organizationId: "org-a",
			name: "TELEGRAM_BOT_TOKEN",
			provider: "vault",
			ref: "kv/telegram",
			createdAt: now(),
			updatedAt: now(),
		});
		expect(created.id).toBeTruthy();

		await expect(
			store.get("org-a", "TELEGRAM_BOT_TOKEN"),
		).resolves.toMatchObject({
			id: created.id,
			ref: "kv/telegram",
		});
		await expect(store.list("org-a")).resolves.toHaveLength(1);
		await expect(store.get("org-a", "MISSING")).resolves.toBeNull();
	});

	it("set upserts by (org, name) — replaces provider/ref in place, preserves id/createdAt", async () => {
		const adapter = memoryAdapter();
		const first = await createSecretAliasStore(adapter, { now }).set(
			"org-a",
			"GH",
			{ provider: "env", ref: "OLD" },
		);
		const second = await createSecretAliasStore(adapter, { now: later }).set(
			"org-a",
			"GH",
			{ provider: "vault", ref: "NEW" },
		);
		expect(second.id).toBe(first.id); // same row
		expect(second.createdAt).toBe(now()); // create stamp preserved
		expect(second.updatedAt).toBe(later()); // bumped
		expect(second).toMatchObject({ provider: "vault", ref: "NEW" });
		// still one row for (org-a, GH)
		await expect(
			createSecretAliasStore(adapter).list("org-a"),
		).resolves.toHaveLength(1);
	});

	it("isolates aliases by org; listAll scans across orgs (the boot-validation read)", async () => {
		const store = createSecretAliasStore(memoryAdapter(), { now });
		await store.set("org-a", "SHARED", { provider: "env", ref: "A" });
		await store.set("org-b", "SHARED", { provider: "env", ref: "B" });
		await expect(store.get("org-a", "SHARED")).resolves.toMatchObject({
			ref: "A",
		});
		await expect(store.get("org-b", "SHARED")).resolves.toMatchObject({
			ref: "B",
		});
		await expect(store.list("org-a")).resolves.toHaveLength(1);
		await expect(store.listAll()).resolves.toHaveLength(2);
	});

	it("delete removes the (org, name) row", async () => {
		const store = createSecretAliasStore(memoryAdapter(), { now });
		await store.set("org-a", "GH", { provider: "env", ref: "GH_PAT" });
		await store.delete("org-a", "GH");
		await expect(store.get("org-a", "GH")).resolves.toBeNull();
	});
});

// A stub adapter whose reads/writes throw a native "table missing" error — the enabled-but-not-migrated
// case. Only the methods the store touches need to throw.
function tableMissingAdapter(message: string): Adapter {
	const boom = (): never => {
		throw new Error(message);
	};
	return {
		id: "table-missing",
		create: boom,
		findOne: boom,
		findMany: boom,
		count: boom,
		update: boom,
		updateMany: boom,
		delete: boom,
		deleteMany: boom,
		consumeOne: boom,
	};
}

describe("createSecretAliasStore — enabled-but-not-migrated safety net", () => {
	it("wraps a sqlite 'no such table' error into a clear configurationError", async () => {
		const store = createSecretAliasStore(
			tableMissingAdapter("SqliteError: no such table: secret_alias"),
		);
		await expect(store.get("org-a", "X")).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(
				/secret_alias table isn't in your database/,
			),
		});
	});

	it("wraps a postgres 'does not exist' error too, on every entry point", async () => {
		const store = createSecretAliasStore(
			tableMissingAdapter('relation "secret_alias" does not exist'),
		);
		for (const call of [
			() => store.list("org-a"),
			() => store.listAll(),
			() => store.set("org-a", "X", { provider: "env", ref: "R" }),
			() => store.delete("org-a", "X"),
		]) {
			await expect(call()).rejects.toBeInstanceOf(EuroclawError);
			await expect(call()).rejects.toMatchObject({
				code: "EUROCLAW_CONFIGURATION_ERROR",
			});
		}
	});

	it("does NOT swallow an unrelated DB error — it rethrows as-is", async () => {
		const store = createSecretAliasStore(
			tableMissingAdapter("connection refused"),
		);
		await expect(store.get("org-a", "X")).rejects.toThrow(/connection refused/);
		// and NOT reshaped into a configurationError
		await expect(store.get("org-a", "X")).rejects.not.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
		});
	});
});
