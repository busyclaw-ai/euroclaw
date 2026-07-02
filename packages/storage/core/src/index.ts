/**
 * @euroclaw/storage-core — the storage Adapter port, the declarative schema format, and a zero-dep
 * in-memory adapter. euroclaw's durable state is narrow — the audit log and pending approvals
 * (better-auth keeps users/orgs/roles) — but the port is the proven generic CRUD one, so any ORM
 * adapter (`@euroclaw/storage-drizzle`, `-prisma`, `-kysely`, `-mongodb`) plugs in.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * euroclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
 * Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

export { type SchemaAdapterOptions, schemaAdapter } from "./schema-adapter";

export type WhereOperator =
	| "eq"
	| "ne"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "in"
	| "contains";

/** One predicate. Clauses combine left-to-right by `connector` (default AND). */
export type Where = {
	field: string;
	value: string | number | boolean | string[] | number[] | Date | null;
	/** Default "eq". */
	operator?: WhereOperator;
	/** How this clause joins the previous one. Default "AND". */
	connector?: "AND" | "OR";
};

export type SortBy = { field: string; direction: "asc" | "desc" };

/**
 * The storage substrate: generic CRUD over named models. An ORM adapter implements this; the
 * memory adapter below is the zero-dep default. `consumeOne` is the race-safe single-use primitive.
 *
 * Each method is generic over the caller-chosen row type (`T`/`R`) — like better-auth's `DBAdapter`.
 * An implementation reads an untyped DB row and bridges it to that type with a single `as never` —
 * provably the minimal cast at this generic boundary (an impl arrow can't name `T`/`R`, so `as T`/
 * `as R` don't compile). Type-safety is recovered by the CALLER naming the type — the durable
 * stores (AuditSink, ApprovalStore) call `adapter.findOne<AuditRow>(…)`, like better-auth's
 * internal-adapter does (`findOne<User>`). The declarative `SchemaDeclaration` below is for
 * migrations (the `generate` CLI), not for typing these methods.
 */
export type Adapter = {
	/** Adapter id, e.g. "memory" / "drizzle" — for diagnostics. */
	id: string;
	create: <T extends Record<string, unknown>, R = T>(data: {
		model: string;
		data: T;
		select?: string[];
	}) => Promise<R>;
	findOne: <T>(data: {
		model: string;
		where: Where[];
		select?: string[];
	}) => Promise<T | null>;
	findMany: <T>(data: {
		model: string;
		where?: Where[];
		limit?: number;
		offset?: number;
		sortBy?: SortBy;
		select?: string[];
	}) => Promise<T[]>;
	count: (data: { model: string; where?: Where[] }) => Promise<number>;
	update: <T>(data: {
		model: string;
		where: Where[];
		update: Record<string, unknown>;
	}) => Promise<T | null>;
	updateMany: (data: {
		model: string;
		where: Where[];
		update: Record<string, unknown>;
	}) => Promise<number>;
	delete: (data: { model: string; where: Where[] }) => Promise<void>;
	deleteMany: (data: { model: string; where: Where[] }) => Promise<number>;
	/**
	 * Atomically delete and return one matching row (or `null`). The race-safe primitive for
	 * consuming single-use credentials — confirmation tokens, one-time approvals. Under concurrent
	 * calls against the same row, exactly one caller gets it; the rest get `null`.
	 */
	consumeOne: <T>(data: { model: string; where: Where[] }) => Promise<T | null>;
	/** Run a set of adapter operations atomically when the backing store supports transactions. */
	transaction?: <R>(fn: (tx: Adapter) => Promise<R>) => Promise<R>;
};

// ── Declarative schema (what a plugin's table looks like) — fed to the `generate` CLI ────────────

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export type FieldAttribute = {
	type: FieldType;
	required?: boolean;
	unique?: boolean;
	index?: boolean;
	references?: { model: string; field: string };
	fieldName?: string;
	input?: boolean;
	returned?: boolean;
	/** Set once at create, never changed by an update — the update path rejects writes to it. */
	immutable?: boolean;
	pii?: "none" | "possible" | "contains" | "redacted";
	retention?: "default" | "ephemeral" | "audit" | "until-erasure";
	defaultValue?: unknown | (() => unknown);
	onUpdate?: () => unknown;
};

export type TableSchema = {
	modelName?: string;
	fields: Record<string, FieldAttribute>;
};

/** A plugin declares the tables it needs: `{ audit: { fields: { … } } } satisfies SchemaDeclaration`. */
export type SchemaDeclaration = Record<string, TableSchema>;

// ── The memory adapter ───────────────────────────────────────────────────────────────────────

function matchOne(row: Record<string, unknown>, w: Where): boolean {
	const v = row[w.field];
	switch (w.operator ?? "eq") {
		case "eq":
			return v === w.value;
		case "ne":
			return v !== w.value;
		case "lt":
			return (v as number) < (w.value as number);
		case "lte":
			return (v as number) <= (w.value as number);
		case "gt":
			return (v as number) > (w.value as number);
		case "gte":
			return (v as number) >= (w.value as number);
		case "in":
			return Array.isArray(w.value) && (w.value as unknown[]).includes(v);
		case "contains":
			return typeof v === "string" && v.includes(String(w.value));
		default:
			return false;
	}
}

/** Apply a Where[] to a row (left-fold by each clause's connector). Empty → matches all. */
export function matchWhere(
	row: Record<string, unknown>,
	where: Where[],
): boolean {
	let result = true;
	let seen = false;
	for (const w of where) {
		const m = matchOne(row, w);
		result = !seen ? m : w.connector === "OR" ? result || m : result && m;
		seen = true;
	}
	return result;
}

/** A zero-dependency in-memory Adapter — the dev/test default. Rows are stored per model. */
export function memoryAdapter(): Adapter {
	const db = new Map<string, Record<string, unknown>[]>();
	let transactionQueue = Promise.resolve();
	const make = (state: Map<string, Record<string, unknown>[]>): Adapter => {
		const table = (model: string): Record<string, unknown>[] => {
			let t = state.get(model);
			if (!t) {
				t = [];
				state.set(model, t);
			}
			return t;
		};
		const out = <T>(row: Record<string, unknown>): T => ({ ...row }) as T;

		return {
			id: "memory",
			async create({ model, data }) {
				const row = { ...data } as Record<string, unknown>;
				table(model).push(row);
				return out(row);
			},
			async findOne({ model, where }) {
				const row = table(model).find((r) => matchWhere(r, where));
				return row ? out(row) : null;
			},
			async findMany({ model, where, limit, offset, sortBy }) {
				let rows = table(model).filter((r) => matchWhere(r, where ?? []));
				if (sortBy) {
					const { field, direction } = sortBy;
					rows = [...rows].sort((a, b) => {
						const av = a[field] as number;
						const bv = b[field] as number;
						const cmp = av < bv ? -1 : av > bv ? 1 : 0;
						return direction === "desc" ? -cmp : cmp;
					});
				}
				if (offset) rows = rows.slice(offset);
				if (limit !== undefined) rows = rows.slice(0, limit);
				return rows.map((r) => out(r));
			},
			async count({ model, where }) {
				return table(model).filter((r) => matchWhere(r, where ?? [])).length;
			},
			async update({ model, where, update }) {
				const row = table(model).find((r) => matchWhere(r, where));
				if (!row) return null;
				Object.assign(row, update);
				return out(row);
			},
			async updateMany({ model, where, update }) {
				const rows = table(model).filter((r) => matchWhere(r, where));
				for (const r of rows) Object.assign(r, update);
				return rows.length;
			},
			async delete({ model, where }) {
				const t = table(model);
				const i = t.findIndex((r) => matchWhere(r, where));
				if (i !== -1) t.splice(i, 1);
			},
			async deleteMany({ model, where }) {
				const t = table(model);
				let n = 0;
				for (let i = t.length - 1; i >= 0; i--) {
					const r = t[i];
					if (r && matchWhere(r, where)) {
						t.splice(i, 1);
						n++;
					}
				}
				return n;
			},
			async consumeOne({ model, where }) {
				// Single-threaded JS → the find+splice is atomic; concurrent callers can't double-consume.
				const t = table(model);
				const i = t.findIndex((r) => matchWhere(r, where));
				if (i === -1) return null;
				const removed = t.splice(i, 1)[0];
				return removed ? out(removed) : null;
			},
			async transaction(fn) {
				const previous = transactionQueue;
				let release = () => {};
				transactionQueue = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				const snapshot = new Map<string, Record<string, unknown>[]>(
					[...state.entries()].map(([model, rows]) => [
						model,
						rows.map((row) => ({ ...row })),
					]),
				);
				try {
					const result = await fn(make(snapshot));
					state.clear();
					for (const [model, rows] of snapshot) state.set(model, rows);
					return result;
				} finally {
					release();
				}
			},
		};
	};

	return make(db);
}
