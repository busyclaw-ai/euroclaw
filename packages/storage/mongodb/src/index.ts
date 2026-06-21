/**
 * @euroclaw/storage-mongodb — the @euroclaw/storage-core Adapter port over a MongoDB database.
 * `consumeOne` uses Mongo's native atomic `findOneAndDelete` — no transaction needed.
 *
 * Modeled on Better Auth's MongoDB adapter: https://github.com/better-auth/better-auth —
 * `packages/mongo-adapter`. The filter/CRUD translation here is euroclaw's own, written against
 * the mongodb driver's public API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, Where } from "@euroclaw/storage-core";
import type { Db, Document, Filter } from "mongodb";

const MONGO_OP = {
	ne: "$ne",
	lt: "$lt",
	lte: "$lte",
	gt: "$gt",
	gte: "$gte",
	in: "$in",
} as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertFieldName(field: string): void {
	if (field.startsWith("$") || field.includes(".") || field.includes("\0")) {
		throw new Error(`storage-mongodb: invalid field name "${field}"`);
	}
}

/** One Where clause → a Mongo filter fragment. */
function clause(w: Where): Filter<Document> {
	assertFieldName(w.field);
	const op = w.operator ?? "eq";
	if (op === "eq") return { [w.field]: w.value };
	if (op === "contains")
		return { [w.field]: { $regex: escapeRegExp(String(w.value)) } };
	return { [w.field]: { [MONGO_OP[op]]: w.value } };
}

/** Where[] → a Mongo filter, left-folded by each clause's connector. */
export function toFilter(where: Where[]): Filter<Document> {
	let combined: Filter<Document> | undefined;
	for (const w of where) {
		const c = clause(w);
		combined =
			combined === undefined
				? c
				: { [w.connector === "OR" ? "$or" : "$and"]: [combined, c] };
	}
	return combined ?? {};
}

/** Strip Mongo's internal `_id` from a returned document (euroclaw rows carry their own `id`). */
function strip<T>(doc: Document | null): T | null {
	if (!doc) return null;
	const { _id, ...rest } = doc;
	return rest as T;
}

/** Adapt a MongoDB `Db` to the storage Adapter port. euroclaw rows carry their own `id` field. */
export function mongoAdapter(db: Db): Adapter {
	const col = (model: string) => db.collection(model);
	return {
		id: "mongodb",

		async create({ model, data }) {
			await col(model).insertOne({ ...data });
			return data as never;
		},

		async findOne({ model, where }) {
			return strip(await col(model).findOne(toFilter(where))) as never;
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			let cursor = col(model).find(toFilter(where ?? []));
			if (sortBy) {
				assertFieldName(sortBy.field);
				cursor = cursor.sort({
					[sortBy.field]: sortBy.direction === "desc" ? -1 : 1,
				});
			}
			if (offset) cursor = cursor.skip(offset);
			if (limit !== undefined) cursor = cursor.limit(limit);
			return (await cursor.toArray()).map((d) => strip(d)) as never;
		},

		async count({ model, where }) {
			return col(model).countDocuments(toFilter(where ?? []));
		},

		async update({ model, where, update }) {
			const doc = await col(model).findOneAndUpdate(
				toFilter(where),
				{ $set: update },
				{ returnDocument: "after" },
			);
			return strip(doc) as never;
		},

		async updateMany({ model, where, update }) {
			const r = await col(model).updateMany(toFilter(where), { $set: update });
			return r.modifiedCount;
		},

		async delete({ model, where }) {
			await col(model).deleteOne(toFilter(where));
		},

		async deleteMany({ model, where }) {
			const r = await col(model).deleteMany(toFilter(where));
			return r.deletedCount;
		},

		async consumeOne({ model, where }) {
			// Native atomic single-use: findOneAndDelete removes and returns one matching doc in one op.
			return strip(await col(model).findOneAndDelete(toFilter(where))) as never;
		},
	};
}
