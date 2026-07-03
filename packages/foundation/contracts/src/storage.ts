/**
 * The storage protocol — what an adapter IS: generic CRUD over named models, the Where shape, and
 * the declarative table-schema format plugins register through their `schema` slot. Pure types;
 * the implementations (schemaAdapter, memoryAdapter, the ORM adapters) live in @euroclaw/storage-*.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * euroclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
 * Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

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
 * memory adapter in @euroclaw/storage-core is the zero-dep default. `consumeOne` is the race-safe
 * single-use primitive.
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
