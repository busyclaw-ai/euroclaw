/**
 * @euroclaw/storage-drizzle — the @euroclaw/storage-core Adapter port over Drizzle.
 * You pass the drizzle `db`, provider (`sqlite` / `pg` / `mysql`), plus a model name → table map.
 *
 * Modeled on Better Auth's Drizzle adapter: https://github.com/better-auth/better-auth —
 * `packages/drizzle-adapter`. The CRUD/where translation here is euroclaw's own, written against
 * Drizzle's public API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import { configurationError } from "@euroclaw/errors";
import type { Adapter, Where } from "@euroclaw/storage-core";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";

/** Map a model name to its Drizzle table: `{ audit, approval }`. */
export type DrizzleSchema = Record<string, unknown>;
export type DrizzleProvider = "sqlite" | "pg" | "mysql";
export type DrizzleAdapterConfig = {
	provider: DrizzleProvider;
	schema: DrizzleSchema;
};

type Query = {
	values: (data: Record<string, unknown>) => Query;
	set: (data: Record<string, unknown>) => Query;
	from: (table: unknown) => Query;
	where: (...conditions: unknown[]) => Query;
	limit: (value: number) => Query;
	offset: (value: number) => Query;
	orderBy: (...columns: unknown[]) => Query;
	$dynamic: () => Query;
	returning: () => Query;
	get: () => unknown;
	all: () => unknown;
	run: () => unknown;
	execute: () => unknown;
};

type DrizzleDb = {
	select: (...args: unknown[]) => Query;
	insert: (table: unknown) => Query;
	update: (table: unknown) => Query;
	delete: (table: unknown) => Query;
	transaction: <R>(fn: (tx: DrizzleDb) => R | Promise<R>) => R | Promise<R>;
};

const columns = (t: unknown): Record<string, unknown> =>
	getTableColumns(t as never) as Record<string, unknown>;

function condition(col: unknown, w: Where): SQL {
	const op = w.operator ?? "eq";
	if (w.value === null) {
		if (op === "eq") return isNull(col as never);
		if (op === "ne") return isNotNull(col as never);
		throw configurationError(
			`storage-drizzle: where operator "${op}" cannot compare null`,
			{ field: w.field, operator: op },
		);
	}
	switch (op) {
		case "ne":
			return ne(col as never, w.value);
		case "lt":
			return lt(col as never, w.value);
		case "lte":
			return lte(col as never, w.value);
		case "gt":
			return gt(col as never, w.value);
		case "gte":
			return gte(col as never, w.value);
		case "in":
			return inArray(col as never, w.value as unknown[]);
		case "contains":
			return like(col as never, `%${w.value}%`);
		default:
			return eq(col as never, w.value);
	}
}

/** Translate Where[] to a Drizzle condition, left-folded by each clause's connector. */
function whereClause(table: unknown, where: Where[]): SQL | undefined {
	const cols = columns(table);
	let combined: SQL | undefined;
	for (const w of where) {
		const col = cols[w.field];
		if (!col) {
			throw configurationError(
				`storage-drizzle: unknown field "${w.field}" in where clause`,
				{ field: w.field },
			);
		}
		const c = condition(col, w);
		combined =
			combined === undefined
				? c
				: w.connector === "OR"
					? or(combined, c)
					: and(combined, c);
	}
	return combined;
}

function affectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		const first = result[0] as Record<string, unknown> | undefined;
		if (first) return affectedRows(first);
		return 0;
	}
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const value = r.rowCount ?? r.affectedRows ?? r.rowsAffected ?? r.changes;
		return typeof value === "number" ? value : 0;
	}
	return 0;
}

async function one(
	query: unknown,
	provider: DrizzleProvider,
): Promise<unknown> {
	const q = query as Query;
	if (provider === "sqlite") return q.get() ?? null;
	const rows = ((await q.execute()) ?? []) as unknown[];
	return rows[0] ?? null;
}

async function many(
	query: unknown,
	provider: DrizzleProvider,
): Promise<unknown[]> {
	const q = query as Query;
	if (provider === "sqlite") return (q.all() ?? []) as unknown[];
	return ((await q.execute()) ?? []) as unknown[];
}

async function run(
	query: unknown,
	provider: DrizzleProvider,
): Promise<unknown> {
	const q = query as Query;
	if (provider === "sqlite") return q.run();
	return q.execute();
}

function oneSync(query: unknown): unknown {
	return (query as Query).get() ?? null;
}

function runSync(query: unknown): unknown {
	return (query as Query).run();
}

function parseConfig(
	config: DrizzleSchema | DrizzleAdapterConfig,
): DrizzleAdapterConfig {
	if ("schema" in config || "provider" in config) {
		const c = config as Partial<DrizzleAdapterConfig>;
		if (!c.schema)
			throw configurationError("storage-drizzle: schema is required");
		return { provider: c.provider ?? "sqlite", schema: c.schema };
	}
	return { provider: "sqlite", schema: config };
}

/** Adapt a Drizzle database + schema map to the storage Adapter port. */
export function drizzleAdapter(
	db: unknown,
	config: DrizzleSchema | DrizzleAdapterConfig,
): Adapter {
	const database = db as DrizzleDb;
	const { provider, schema } = parseConfig(config);
	const table = (model: string): unknown => {
		const t = schema[model];
		if (!t)
			throw configurationError(
				`storage-drizzle: unknown model "${model}" — add it to the schema map`,
				{ model },
			);
		return t;
	};
	const idColumn = (t: unknown): unknown => {
		const col = columns(t).id;
		if (!col)
			throw configurationError(
				"storage-drizzle: consumeOne requires an `id` column",
			);
		return col;
	};

	const adapter: Adapter = {
		id: "drizzle",

		async create({ model, data }) {
			const t = table(model);
			const builder = database.insert(t).values(data);
			if (provider === "mysql") {
				await run(builder, provider);
				return data as never;
			}
			const row = await one(builder.returning(), provider);
			return row as never;
		},

		async findOne({ model, where }) {
			const t = table(model);
			const row = await one(
				database.select().from(t).where(whereClause(t, where)).limit(1),
				provider,
			);
			return (row ?? null) as never;
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			const t = table(model);
			let q = database
				.select()
				.from(t)
				.where(whereClause(t, where ?? []))
				.$dynamic();
			if (sortBy) {
				const col = columns(t)[sortBy.field];
				if (col)
					q = q.orderBy(
						sortBy.direction === "desc"
							? desc(col as Parameters<typeof desc>[0])
							: asc(col as Parameters<typeof asc>[0]),
					);
			}
			if (limit !== undefined) q = q.limit(limit);
			if (offset) q = q.offset(offset);
			return (await many(q, provider)) as never;
		},

		async count({ model, where }) {
			const t = table(model);
			const row = (await one(
				database
					.select({ count: sql<number>`count(*)` })
					.from(t)
					.where(whereClause(t, where ?? [])),
				provider,
			)) as { count?: unknown } | null;
			return Number(row?.count ?? 0);
		},

		async update({ model, where, update }) {
			const t = table(model);
			const before = await adapter.findOne<{ id?: string | number }>({
				model,
				where,
			});
			const id = before?.id;
			if (id === undefined || id === null) return null;
			const idCol = idColumn(t);
			const clause = and(
				whereClause(t, where),
				eq(idCol as Parameters<typeof eq>[0], id),
			);
			const builder = database.update(t).set(update).where(clause);
			if (provider === "mysql") {
				await run(builder, provider);
				return adapter.findOne({ model, where: [{ field: "id", value: id }] });
			}
			const row = await one(builder.returning(), provider);
			return (row ?? null) as never;
		},

		async updateMany({ model, where, update }) {
			const t = table(model);
			const builder = database
				.update(t)
				.set(update)
				.where(whereClause(t, where));
			if (provider === "mysql")
				return affectedRows(await run(builder, provider));
			return (await many(builder.returning(), provider)).length;
		},

		async delete({ model, where }) {
			const t = table(model);
			const before = await adapter.findOne<{ id?: string | number }>({
				model,
				where,
			});
			const id = before?.id;
			if (id === undefined || id === null) return;
			const idCol = idColumn(t);
			await run(
				database
					.delete(t)
					.where(
						and(
							whereClause(t, where),
							eq(idCol as Parameters<typeof eq>[0], id),
						),
					),
				provider,
			);
		},

		async deleteMany({ model, where }) {
			const t = table(model);
			const builder = database.delete(t).where(whereClause(t, where));
			if (provider === "mysql")
				return affectedRows(await run(builder, provider));
			return (await many(builder.returning(), provider)).length;
		},

		// Atomic single-use: a transaction takes one matching row then deletes it by `id`. The
		// transaction serializes concurrent callers, so exactly one wins (the rest see no row).
		async consumeOne({ model, where }) {
			const t = table(model);
			const clause = whereClause(t, where);
			const idCol = idColumn(t);
			const result =
				provider === "sqlite"
					? database.transaction((tx) => {
							const row = oneSync(tx.select().from(t).where(clause).limit(1));
							if (!row) return null;
							const deleted = runSync(
								tx
									.delete(t)
									.where(
										eq(
											idCol as Parameters<typeof eq>[0],
											(row as { id: unknown }).id,
										),
									),
							);
							if (affectedRows(deleted) !== 1) return null;
							return row;
						})
					: await database.transaction(async (tx) => {
							const row = await one(
								tx.select().from(t).where(clause).limit(1),
								provider,
							);
							if (!row) return null;
							if (provider === "mysql") {
								const deleted = await run(
									tx
										.delete(t)
										.where(
											eq(
												idCol as Parameters<typeof eq>[0],
												(row as { id: unknown }).id,
											),
										),
									provider,
								);
								return affectedRows(deleted) === 1 ? row : null;
							}
							const deleted = await one(
								tx
									.delete(t)
									.where(
										eq(
											idCol as Parameters<typeof eq>[0],
											(row as { id: unknown }).id,
										),
									)
									.returning(),
								provider,
							);
							return deleted ? row : null;
						});
			return result as never;
		},
	};

	if (provider !== "sqlite") {
		adapter.transaction = (fn) =>
			database.transaction((tx) =>
				fn(drizzleAdapter(tx, { provider, schema })),
			) as never;
	}

	return adapter;
}
