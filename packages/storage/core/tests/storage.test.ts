import { describe, expect, it } from "vitest";
import {
	type Adapter,
	memoryAdapter,
	type SchemaDeclaration,
	schemaAdapter,
} from "../src/index";

const a = (): Adapter => memoryAdapter();

describe("@euroclaw/storage-core — memory adapter", () => {
	it("create + findOne by a where clause", async () => {
		const db = a();
		await db.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		});
		const got = await db.findOne<{ id: string; status: string }>({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		});
		expect(got?.status).toBe("pending");
		const miss = await db.findOne({
			model: "approval",
			where: [{ field: "id", value: "nope" }],
		});
		expect(miss).toBeNull();
	});

	it("findMany with where operators, sort, limit, offset", async () => {
		const db = a();
		for (const seq of [2, 0, 3, 1])
			await db.create({ model: "audit", data: { seq, kind: "tool" } });
		const sorted = await db.findMany<{ seq: number }>({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		});
		expect(sorted.map((r) => r.seq)).toEqual([0, 1, 2, 3]);

		const page = await db.findMany<{ seq: number }>({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
			offset: 1,
			limit: 2,
		});
		expect(page.map((r) => r.seq)).toEqual([1, 2]);

		const gt = await db.findMany<{ seq: number }>({
			model: "audit",
			where: [{ field: "seq", operator: "gt", value: 1 }],
		});
		expect(gt.map((r) => r.seq).sort()).toEqual([2, 3]);

		const inSet = await db.findMany<{ seq: number }>({
			model: "audit",
			where: [{ field: "seq", operator: "in", value: [0, 3] }],
		});
		expect(inSet.map((r) => r.seq).sort()).toEqual([0, 3]);
	});

	it("update / updateMany / delete / count", async () => {
		const db = a();
		await db.create({
			model: "approval",
			data: { id: "x", status: "pending" },
		});
		await db.create({
			model: "approval",
			data: { id: "y", status: "pending" },
		});

		await db.update({
			model: "approval",
			where: [{ field: "id", value: "x" }],
			update: { status: "approved" },
		});
		expect(
			(
				await db.findOne<{ status: string }>({
					model: "approval",
					where: [{ field: "id", value: "x" }],
				})
			)?.status,
		).toBe("approved");

		const n = await db.updateMany({
			model: "approval",
			where: [{ field: "status", value: "pending" }],
			update: { status: "expired" },
		});
		expect(n).toBe(1); // only y was still pending

		expect(await db.count({ model: "approval" })).toBe(2);
		await db.delete({
			model: "approval",
			where: [{ field: "id", value: "y" }],
		});
		expect(await db.count({ model: "approval" })).toBe(1);
	});

	it("consumeOne is single-use and race-safe (one winner, the rest get null)", async () => {
		const db = a();
		await db.create({ model: "token", data: { id: "t1", digest: "abc" } });

		// Fire several consumes for the same row concurrently — exactly one gets it.
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				db.consumeOne<{ id: string }>({
					model: "token",
					where: [{ field: "id", value: "t1" }],
				}),
			),
		);
		const winners = results.filter((r) => r !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.id).toBe("t1");
		expect(await db.count({ model: "token" })).toBe(0); // consumed
	});

	it("transaction commits or rolls back a group of writes", async () => {
		const db = a();
		await db.transaction?.(async (tx) => {
			await tx.create({ model: "run", data: { id: "r1", status: "queued" } });
			await tx.create({ model: "event", data: { id: "e1", runId: "r1" } });
		});
		expect(await db.count({ model: "run" })).toBe(1);
		expect(await db.count({ model: "event" })).toBe(1);

		await expect(
			db.transaction?.(async (tx) => {
				await tx.create({
					model: "run",
					data: { id: "r2", status: "queued" },
				});
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(
			await db.findOne({ model: "run", where: [{ field: "id", value: "r2" }] }),
		).toBeNull();
	});

	it("serves the two euroclaw use cases: append-only audit + approval lifecycle", async () => {
		const db = a();

		// Audit: append rows, read back in order — what a durable AuditSink will do.
		for (let seq = 0; seq < 3; seq++) {
			await db.create({
				model: "audit",
				data: { seq, name: `tool${seq}`, hash: `h${seq}` },
			});
		}
		const log = await db.findMany<{ seq: number }>({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		});
		expect(log.map((r) => r.seq)).toEqual([0, 1, 2]);

		// Approval: create pending → consume once on approval → gone (can't be replayed).
		await db.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		});
		const consumed = await db.consumeOne<{ id: string }>({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		});
		expect(consumed?.id).toBe("ap1");
		expect(
			await db.consumeOne({
				model: "approval",
				where: [{ field: "id", value: "ap1" }],
			}),
		).toBeNull();
	});
});

const fieldSchema = {
	claw: {
		modelName: "euroclaw_claw",
		fields: {
			id: { type: "string", required: true, unique: true },
			tenantId: {
				type: "string",
				fieldName: "tenant_id",
				required: true,
			},
			status: {
				type: "string",
				required: true,
				defaultValue: () => "active",
			},
			context: {
				type: "json",
				required: true,
				defaultValue: () => ({ source: "default" }),
			},
			updatedAt: {
				type: "string",
				required: true,
				defaultValue: () => "created",
				onUpdate: () => "updated",
			},
			secret: { type: "string", returned: false },
			locked: { type: "string", immutable: true },
		},
	},
} satisfies SchemaDeclaration;

type FieldClaw = {
	id: string;
	tenantId: string;
	status: string;
	context: unknown;
	updatedAt: string;
	secret?: string;
	locked?: string;
};

describe("@euroclaw/storage-core — schema adapter", () => {
	it("maps model and field names while encoding and decoding JSON", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);

		const created = await db.create<FieldClaw>({
			model: "claw",
			data: { id: "c1", tenantId: "t1", secret: "hidden", locked: "v1" },
		});

		expect(created).toEqual({
			context: { source: "default" },
			id: "c1",
			locked: "v1",
			status: "active",
			tenantId: "t1",
			updatedAt: "created",
		});

		const row = await raw.findOne<Record<string, unknown>>({
			model: "euroclaw_claw",
			where: [{ field: "tenant_id", value: "t1" }],
		});
		expect(row).toMatchObject({
			context: JSON.stringify({ source: "default" }),
			id: "c1",
			secret: "hidden",
			tenant_id: "t1",
		});

		const found = await db.findOne<FieldClaw>({
			model: "claw",
			where: [{ field: "tenantId", value: "t1" }],
		});
		expect(found).toEqual(created);
	});

	it("maps select, sort, count, and update fields", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);
		await db.create({ model: "claw", data: { id: "c2", tenantId: "b" } });
		await db.create({ model: "claw", data: { id: "c3", tenantId: "a" } });

		const selected = await db.findOne<Partial<FieldClaw>>({
			model: "claw",
			select: ["tenantId", "context"],
			where: [{ field: "id", value: "c2" }],
		});
		expect(selected).toEqual({
			context: { source: "default" },
			tenantId: "b",
		});

		const sorted = await db.findMany<FieldClaw>({
			model: "claw",
			sortBy: { field: "tenantId", direction: "asc" },
		});
		expect(sorted.map((row) => row.tenantId)).toEqual(["a", "b"]);
		expect(
			await db.count({
				model: "claw",
				where: [{ field: "tenantId", value: "a" }],
			}),
		).toBe(1);

		const updated = await db.update<FieldClaw>({
			model: "claw",
			where: [{ field: "tenantId", value: "a" }],
			update: { context: { patched: true } },
		});
		expect(updated?.context).toEqual({ patched: true });
		expect(updated?.updatedAt).toBe("updated");

		const row = await raw.findOne<Record<string, unknown>>({
			model: "euroclaw_claw",
			where: [{ field: "tenant_id", value: "a" }],
		});
		expect(row?.context).toBe(JSON.stringify({ patched: true }));
		expect(row?.updatedAt).toBe("updated");
	});

	it("lets explicit update values win over onUpdate", async () => {
		const db = schemaAdapter(memoryAdapter(), fieldSchema);
		await db.create({ model: "claw", data: { id: "c4", tenantId: "t4" } });

		const updated = await db.update<FieldClaw>({
			model: "claw",
			where: [{ field: "id", value: "c4" }],
			update: { updatedAt: "manual" },
		});

		expect(updated?.updatedAt).toBe("manual");
	});

	it("rejects missing required fields, unknown fields, immutable fields, and invalid JSON", async () => {
		const db = schemaAdapter(memoryAdapter(), fieldSchema);

		await expect(
			db.create({ model: "claw", data: { id: "missing-tenant" } }),
		).rejects.toThrow(/tenantId.*required/);
		await expect(
			db.create({
				model: "claw",
				data: { id: "bad-field", tenantId: "t", unknown: true },
			}),
		).rejects.toThrow(/unknown field/);
		await expect(
			db.update({
				model: "claw",
				where: [{ field: "id", value: "bad-field" }],
				update: { locked: "new" },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.create({
				model: "claw",
				data: { context: () => undefined, id: "bad-json", tenantId: "t" },
			}),
		).rejects.toThrow(/JSON-serializable/);
	});

	it("keeps transactions schema-aware", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);

		await db.transaction?.(async (tx) => {
			await tx.create({ model: "claw", data: { id: "tx1", tenantId: "t" } });
		});

		expect(await raw.count({ model: "euroclaw_claw" })).toBe(1);
		await expect(
			db.transaction?.(async (tx) => {
				await tx.create({
					model: "claw",
					data: { id: "tx2", tenantId: "t" },
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(
			await raw.findOne({
				model: "euroclaw_claw",
				where: [{ field: "id", value: "tx2" }],
			}),
		).toBeNull();
	});

	it("maps consumeOne and decodes the returned row", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);
		await db.create({ model: "claw", data: { id: "consume", tenantId: "t" } });

		const consumed = await db.consumeOne<FieldClaw>({
			model: "claw",
			where: [{ field: "tenantId", value: "t" }],
		});

		expect(consumed?.context).toEqual({ source: "default" });
		expect(consumed?.tenantId).toBe("t");
		expect(await raw.count({ model: "euroclaw_claw" })).toBe(0);
	});
});
