import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mongoAdapter, toFilter } from "./index";

describe("@euroclaw/storage-mongodb — Where → Mongo filter", () => {
	it("eq, operators, in, contains", () => {
		expect(toFilter([{ field: "id", value: "x" }])).toEqual({ id: "x" });
		expect(toFilter([{ field: "seq", operator: "ne", value: 1 }])).toEqual({
			seq: { $ne: 1 },
		});
		expect(toFilter([{ field: "seq", operator: "gt", value: 1 }])).toEqual({
			seq: { $gt: 1 },
		});
		expect(toFilter([{ field: "seq", operator: "in", value: [0, 3] }])).toEqual(
			{ seq: { $in: [0, 3] } },
		);
		expect(
			toFilter([{ field: "name", operator: "contains", value: "a.b" }]),
		).toEqual({ name: { $regex: "a\\.b" } });
	});

	it("left-folds AND / OR by connector", () => {
		expect(
			toFilter([
				{ field: "a", value: 1 },
				{ field: "b", value: 2 },
			]),
		).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
		expect(
			toFilter([
				{ field: "a", value: 1 },
				{ field: "b", value: 2, connector: "OR" },
			]),
		).toEqual({
			$or: [{ a: 1 }, { b: 2 }],
		});
		expect(toFilter([])).toEqual({});
	});

	it("rejects Mongo operator field names", () => {
		expect(() => toFilter([{ field: "$where", value: "true" }])).toThrow(
			/invalid field name/,
		);
		expect(() => toFilter([{ field: "profile.$expr", value: "x" }])).toThrow(
			/invalid field name/,
		);
	});
});

// Real behavioral coverage against an in-memory MongoDB (mongod binary, cached after first run).
let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	client = new MongoClient(mongod.getUri());
	await client.connect();
	db = client.db("euroclaw_test");
}, 120000);

afterAll(async () => {
	await client?.close();
	await mongod?.stop();
});

afterEach(async () => {
	for (const c of ["approval", "audit", "token"])
		await db.collection(c).deleteMany({});
});

describe("@euroclaw/storage-mongodb — adapter against real MongoDB", () => {
	it("create + findOne (and _id is stripped)", async () => {
		const a = mongoAdapter(db);
		await a.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		});
		const got = await a.findOne<{ id: string; status: string }>({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		});
		expect(got).toEqual({ id: "ap1", status: "pending" });
		expect(
			await a.findOne({
				model: "approval",
				where: [{ field: "id", value: "nope" }],
			}),
		).toBeNull();
	});

	it("findMany with operators, sort, limit, offset", async () => {
		const a = mongoAdapter(db);
		for (const seq of [2, 0, 3, 1])
			await a.create({ model: "audit", data: { seq, name: `t${seq}` } });
		const sorted = await a.findMany<{ seq: number }>({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		});
		expect(sorted.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
		const page = await a.findMany<{ seq: number }>({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
			offset: 1,
			limit: 2,
		});
		expect(page.map((r) => r.seq)).toEqual([1, 2]);
		const gt = await a.findMany<{ seq: number }>({
			model: "audit",
			where: [{ field: "seq", operator: "gt", value: 1 }],
		});
		expect(gt.map((r) => r.seq).sort()).toEqual([2, 3]);
		const inSet = await a.findMany<{ seq: number }>({
			model: "audit",
			where: [{ field: "seq", operator: "in", value: [0, 3] }],
		});
		expect(inSet.map((r) => r.seq).sort()).toEqual([0, 3]);
	});

	it("update / updateMany / delete / count", async () => {
		const a = mongoAdapter(db);
		await a.create({ model: "approval", data: { id: "x", status: "pending" } });
		await a.create({ model: "approval", data: { id: "y", status: "pending" } });
		await a.update({
			model: "approval",
			where: [{ field: "id", value: "x" }],
			update: { status: "approved" },
		});
		expect(
			(
				await a.findOne<{ status: string }>({
					model: "approval",
					where: [{ field: "id", value: "x" }],
				})
			)?.status,
		).toBe("approved");
		expect(
			await a.updateMany({
				model: "approval",
				where: [{ field: "status", value: "pending" }],
				update: { status: "expired" },
			}),
		).toBe(1);
		expect(await a.count({ model: "approval" })).toBe(2);
		await a.delete({ model: "approval", where: [{ field: "id", value: "y" }] });
		expect(await a.count({ model: "approval" })).toBe(1);
	});

	it("consumeOne is single-use and race-safe (native atomic findOneAndDelete)", async () => {
		const a = mongoAdapter(db);
		await a.create({ model: "token", data: { id: "t1", digest: "abc" } });
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				a.consumeOne<{ id: string }>({
					model: "token",
					where: [{ field: "id", value: "t1" }],
				}),
			),
		);
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await a.count({ model: "token" })).toBe(0);
	});
});
