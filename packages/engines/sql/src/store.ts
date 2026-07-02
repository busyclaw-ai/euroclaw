/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (patterns/architecture, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * - The lease/claim/heartbeat/idempotency shape is adapted from NullTickets' SQLite tracker:
 *   `/Users/konstantinponomarev/Downloads/nulltickets-main/src/store.zig` and `src/api.zig`.
 * - The run/event/checkpoint/orchestrator shape is informed by NullBoiler:
 *   `/Users/konstantinponomarev/Downloads/nullboiler-main/src/store.zig` and `src/engine.zig`.
 *
 * This is an independent TypeScript implementation over euroclaw's storage Adapter. Runtime history
 * produced here is operational state, not compliance audit; compliance evidence stays in @euroclaw/core.
 */

import {
	type EntityUpdateInput,
	jsonObject as jsonObjectSchema,
} from "@euroclaw/contracts";
import {
	configurationError,
	errorMessage,
	stateError,
	validationError,
} from "@euroclaw/errors";
import {
	type Adapter,
	schemaAdapter,
	type TableSchema,
	type Where,
} from "@euroclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type as ark } from "arktype";
import { type runFields, sqlEngineSchema } from "./schema";

export const RunStatus = ark(
	"'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'",
);
export type RunStatus = typeof RunStatus.infer;

export const TaskStatus = ark(
	"'pending' | 'leased' | 'completed' | 'failed' | 'dead'",
);
export type TaskStatus = typeof TaskStatus.infer;

const JsonRecord = jsonObjectSchema;
const OptionalString = ark("string | undefined");

export const RunRecord = ark({
	id: "string",
	status: RunStatus,
	input: JsonRecord,
	"actor?": OptionalString,
	"team?": OptionalString,
	createdAt: "string",
	updatedAt: "string",
});
export type RunRecord = typeof RunRecord.infer;

export const RuntimeTask = ark({
	id: "string",
	runId: "string",
	kind: "string",
	status: TaskStatus,
	payload: JsonRecord,
	dueAt: "string",
	attempt: "number",
	maxAttempts: "number",
	retryDelayMs: "number",
	"leaseId?": OptionalString,
	"workerId?": OptionalString,
	"leasedUntil?": OptionalString,
	"lastError?": OptionalString,
	"output?": JsonRecord.or("undefined"),
	createdAt: "string",
	updatedAt: "string",
	"completedAt?": OptionalString,
});
export type RuntimeTask = typeof RuntimeTask.infer;

export const RunEvent = ark({
	id: "string",
	runId: "string",
	type: "string",
	payload: JsonRecord,
	createdAt: "string",
});
export type RunEvent = typeof RunEvent.infer;

export const LeaseRecord = ark({
	id: "string",
	taskId: "string",
	workerId: "string",
	tokenHash: "string",
	expiresAt: "string",
	lastHeartbeatAt: "string",
	createdAt: "string",
});
export type LeaseRecord = typeof LeaseRecord.infer;

export type ClaimedTask = {
	task: RuntimeTask;
	leaseId: string;
	leaseToken: string;
	expiresAt: string;
};

export const IdempotencyRecord = ark({
	id: "string",
	key: "string",
	method: "string",
	path: "string",
	"tenantId?": OptionalString,
	"actor?": OptionalString,
	requestHash: "string",
	responseStatus: "number",
	responseBody: JsonRecord,
	createdAt: "string",
});
export type IdempotencyRecord = typeof IdempotencyRecord.infer;

export type SqlEngineStoreOptions = {
	now?: () => string;
	runModel?: string;
	taskModel?: string;
	eventModel?: string;
	leaseModel?: string;
	idempotencyModel?: string;
};

export type CreateRunInput = {
	id?: string;
	input?: Record<string, unknown>;
	actor?: string;
	team?: string;
};

export type EnqueueTaskInput = {
	id?: string;
	runId: string;
	kind: string;
	payload?: Record<string, unknown>;
	dueAt?: string;
	maxAttempts?: number;
	retryDelayMs?: number;
};

export type ClaimTaskInput = {
	workerId: string;
	leaseTtlMs?: number;
	limit?: number;
};

export type IdempotencyLookup = {
	key: string;
	method: string;
	path: string;
	tenantId?: string;
	actor?: string;
	requestHash: string;
};

export type SaveIdempotencyInput = IdempotencyLookup & {
	responseStatus: number;
	responseBody: Record<string, unknown>;
};

export type SqlEngineStore = {
	transaction: <R>(fn: (tx: SqlEngineStore) => Promise<R>) => Promise<R>;
	createRun: (input?: CreateRunInput) => Promise<RunRecord>;
	getRun: (id: string) => Promise<RunRecord | null>;
	updateRun: (
		id: string,
		patch: EntityUpdateInput<typeof runFields>,
	) => Promise<RunRecord | null>;
	enqueueTask: (input: EnqueueTaskInput) => Promise<RuntimeTask>;
	getTask: (id: string) => Promise<RuntimeTask | null>;
	claimDueTask: (input: ClaimTaskInput) => Promise<ClaimedTask | null>;
	heartbeatLease: (input: {
		leaseId: string;
		leaseToken: string;
		leaseTtlMs?: number;
	}) => Promise<LeaseRecord | null>;
	completeTask: (input: {
		taskId: string;
		leaseToken: string;
		output?: Record<string, unknown>;
	}) => Promise<RuntimeTask | null>;
	failTask: (input: {
		taskId: string;
		leaseToken: string;
		reason: string;
	}) => Promise<RuntimeTask | null>;
	reapExpiredLeases: () => Promise<number>;
	appendEvent: (input: {
		runId: string;
		type: string;
		payload?: Record<string, unknown>;
	}) => Promise<RunEvent>;
	events: (runId: string) => Promise<RunEvent[]>;
	requestHash: (body: unknown) => string;
	getIdempotency: (
		input: IdempotencyLookup,
	) => Promise<IdempotencyRecord | null>;
	saveIdempotency: (input: SaveIdempotencyInput) => Promise<IdempotencyRecord>;
};

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function newId(): string {
	return bytesToHex(randomBytes(16));
}

function newToken(): string {
	return bytesToHex(randomBytes(32));
}

function hashText(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}

function addMs(iso: string, ms: number): string {
	return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * Narrow an engine schema table — the tables are index-typed under `satisfies SchemaDeclaration` — and
 * pin its physical model name. The tables always exist (sqlEngineSchema is built from these entities);
 * the guard is how we narrow without a non-null assertion.
 */
function engineTable(
	table: TableSchema | undefined,
	modelName: string,
): TableSchema {
	if (!table)
		throw configurationError("engine schema table missing", { modelName });
	return { ...table, modelName };
}

function stringifyJson(value: unknown, label: string): string {
	const valid = jsonObjectSchema(value);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	try {
		const json = JSON.stringify(valid);
		if (typeof json !== "string") {
			throw validationError(`${label} invalid`, "must be JSON-serializable");
		}
		return json;
	} catch (err) {
		if (err instanceof Error && err.name === "EuroclawError") throw err;
		throw validationError(`${label} invalid`, errorMessage(err));
	}
}

function validateRunRecord(record: unknown): RunRecord {
	const valid = RunRecord(record);
	if (valid instanceof ark.errors) {
		throw validationError("run record invalid", valid.summary);
	}
	return valid;
}

function validateTask(task: unknown): RuntimeTask {
	const valid = RuntimeTask(task);
	if (valid instanceof ark.errors) {
		throw validationError("runtime task invalid", valid.summary);
	}
	return valid;
}

function validateEvent(event: unknown): RunEvent {
	const valid = RunEvent(event);
	if (valid instanceof ark.errors) {
		throw validationError("run event invalid", valid.summary);
	}
	return valid;
}

function validateLeaseRecord(record: unknown): LeaseRecord {
	const valid = LeaseRecord(record);
	if (valid instanceof ark.errors) {
		throw validationError("lease record invalid", valid.summary);
	}
	return valid;
}

function validateIdempotencyRecord(record: unknown): IdempotencyRecord {
	const valid = IdempotencyRecord(record);
	if (valid instanceof ark.errors) {
		throw validationError("idempotency record invalid", valid.summary);
	}
	return valid;
}

function pendingWhere(now: string): Where[] {
	return [
		{ field: "status", value: "pending" },
		{ field: "dueAt", value: now, operator: "lte", connector: "AND" },
	];
}

function idempotencyId(input: IdempotencyLookup): string {
	return hashText(
		JSON.stringify({
			key: input.key,
			method: input.method,
			path: input.path,
			tenantId: input.tenantId ?? null,
			actor: input.actor ?? null,
		}),
	);
}

export function createSqlEngineStore(
	adapter: Adapter,
	options: SqlEngineStoreOptions = {},
): SqlEngineStore {
	const runTransaction = adapter.transaction;
	if (!runTransaction) {
		throw configurationError(
			"@euroclaw/engine-sql requires a transactional storage adapter",
			{ adapter: adapter.id },
		);
	}
	const now = options.now ?? (() => new Date().toISOString());
	const runModel = options.runModel ?? "run";
	const taskModel = options.taskModel ?? "runtime_task";
	const eventModel = options.eventModel ?? "run_event";
	const leaseModel = options.leaseModel ?? "lease";
	const idempotencyModel = options.idempotencyModel ?? "idempotency_key";
	// Every engine table persists through schemaAdapter (logical↔physical names, JSON encode/decode,
	// undefined-dropping, immutable enforcement), so the ops speak native records and never hand-roll row
	// mapping. Each table's *Model option pins its physical name via modelName.
	const db = schemaAdapter(adapter, {
		run: engineTable(sqlEngineSchema.run, runModel),
		runtime_task: engineTable(sqlEngineSchema.runtime_task, taskModel),
		run_event: engineTable(sqlEngineSchema.run_event, eventModel),
		lease: engineTable(sqlEngineSchema.lease, leaseModel),
		idempotency_key: engineTable(
			sqlEngineSchema.idempotency_key,
			idempotencyModel,
		),
	});

	async function validateLease(
		task: RuntimeTask,
		token: string,
	): Promise<LeaseRecord | null> {
		if (task.leaseId === undefined) return null;
		const row = await db.findOne<unknown>({
			model: "lease",
			where: [{ field: "id", value: task.leaseId }],
		});
		if (!row) return null;
		const lease = validateLeaseRecord(row);
		if (lease.taskId !== task.id) return null;
		if (lease.expiresAt <= now()) return null;
		if (lease.tokenHash !== hashText(token)) return null;
		return lease;
	}

	const store: SqlEngineStore = {
		transaction(fn) {
			return runTransaction((tx) => fn(createSqlEngineStore(tx, options)));
		},

		async createRun(input = {}) {
			const ts = now();
			const record = validateRunRecord({
				id: input.id ?? newId(),
				status: "queued",
				input: input.input ?? {},
				actor: input.actor,
				team: input.team,
				createdAt: ts,
				updatedAt: ts,
			});
			await db.create({ model: "run", data: record });
			return record;
		},

		async getRun(id) {
			const row = await db.findOne<unknown>({
				model: "run",
				where: [{ field: "id", value: id }],
			});
			return row ? validateRunRecord(row) : null;
		},

		async updateRun(id, patch) {
			// schemaAdapter drops undefined + encodes JSON; the store owns updatedAt (input:false).
			const row = await db.update<unknown>({
				model: "run",
				where: [{ field: "id", value: id }],
				update: { ...patch, updatedAt: now() },
			});
			return row ? validateRunRecord(row) : null;
		},

		async enqueueTask(input) {
			const ts = now();
			const record = validateTask({
				id: input.id ?? newId(),
				runId: input.runId,
				kind: input.kind,
				status: "pending",
				payload: input.payload ?? {},
				dueAt: input.dueAt ?? ts,
				attempt: 0,
				maxAttempts: input.maxAttempts ?? 1,
				retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
				createdAt: ts,
				updatedAt: ts,
			});
			await db.create({ model: "runtime_task", data: record });
			return record;
		},

		async getTask(id) {
			const row = await db.findOne<unknown>({
				model: "runtime_task",
				where: [{ field: "id", value: id }],
			});
			return row ? validateTask(row) : null;
		},

		async claimDueTask(input) {
			await store.reapExpiredLeases();
			const ts = now();
			const candidates = await db.findMany<unknown>({
				model: "runtime_task",
				where: pendingWhere(ts),
				sortBy: { field: "dueAt", direction: "asc" },
				limit: input.limit ?? 10,
			});
			for (const candidateRow of candidates) {
				const candidate = validateTask(candidateRow);
				if (candidate.attempt >= candidate.maxAttempts) {
					await db.update<unknown>({
						model: "runtime_task",
						where: [
							{ field: "id", value: candidate.id },
							{ field: "status", value: "pending", connector: "AND" },
						],
						update: {
							status: "dead",
							lastError: "max attempts exhausted before claim",
							updatedAt: ts,
						},
					});
					await store.updateRun(candidate.runId, { status: "failed" });
					continue;
				}
				const leaseToken = newToken();
				const leaseId = newId();
				const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
				const lease: LeaseRecord = {
					id: leaseId,
					taskId: candidate.id,
					workerId: input.workerId,
					tokenHash: hashText(leaseToken),
					expiresAt,
					lastHeartbeatAt: ts,
					createdAt: ts,
				};
				await db.create({ model: "lease", data: lease });
				const updated = await db.update<unknown>({
					model: "runtime_task",
					where: [
						{ field: "id", value: candidate.id },
						{ field: "status", value: "pending", connector: "AND" },
					],
					update: {
						status: "leased",
						leaseId,
						workerId: input.workerId,
						leasedUntil: expiresAt,
						attempt: candidate.attempt + 1,
						updatedAt: ts,
					},
				});
				if (!updated) {
					await db.delete({
						model: "lease",
						where: [{ field: "id", value: leaseId }],
					});
					continue;
				}
				const task = validateTask(updated);
				await store.updateRun(task.runId, { status: "running" });
				return { task, leaseId, leaseToken, expiresAt };
			}
			return null;
		},

		async heartbeatLease(input) {
			const leaseRow = await db.findOne<unknown>({
				model: "lease",
				where: [{ field: "id", value: input.leaseId }],
			});
			if (!leaseRow) return null;
			const lease = validateLeaseRecord(leaseRow);
			if (lease.expiresAt <= now()) return null;
			if (lease.tokenHash !== hashText(input.leaseToken)) return null;
			const ts = now();
			const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
			const tokenHash = hashText(input.leaseToken);
			const updated = await db.update<unknown>({
				model: "lease",
				where: [
					{ field: "id", value: input.leaseId },
					{ field: "tokenHash", value: tokenHash, connector: "AND" },
					{ field: "expiresAt", value: ts, operator: "gt", connector: "AND" },
				],
				update: { expiresAt, lastHeartbeatAt: ts },
			});
			if (!updated) return null;
			await db.update<unknown>({
				model: "runtime_task",
				where: [
					{ field: "id", value: lease.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: input.leaseId, connector: "AND" },
					{ field: "workerId", value: lease.workerId, connector: "AND" },
				],
				update: { leasedUntil: expiresAt, updatedAt: ts },
			});
			return validateLeaseRecord(updated);
		},

		async completeTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const row = await db.update<unknown>({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status: "completed",
					output: input.output,
					completedAt: ts,
					updatedAt: ts,
				},
			});
			if (!row) return null;
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return validateTask(row);
		},

		async failTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const status: TaskStatus =
				task.attempt >= task.maxAttempts ? "dead" : "pending";
			const row = await db.update<unknown>({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status,
					lastError: input.reason,
					dueAt:
						status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				},
			});
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return row ? validateTask(row) : null;
		},

		async reapExpiredLeases() {
			const ts = now();
			const leaseRows = await db.findMany<unknown>({
				model: "lease",
				where: [{ field: "expiresAt", value: ts, operator: "lte" }],
			});
			let count = 0;
			for (const leaseRow of leaseRows) {
				const candidate = validateLeaseRecord(leaseRow);
				const consumedLeaseRow = await db.consumeOne<unknown>({
					model: "lease",
					where: [
						{ field: "id", value: candidate.id },
						{
							field: "expiresAt",
							value: ts,
							operator: "lte",
							connector: "AND",
						},
					],
				});
				if (!consumedLeaseRow) continue;
				const lease = validateLeaseRecord(consumedLeaseRow);
				const taskRow = await db.findOne<unknown>({
					model: "runtime_task",
					where: [{ field: "id", value: lease.taskId }],
				});
				if (!taskRow) continue;
				const task = validateTask(taskRow);
				const status: TaskStatus =
					task.attempt >= task.maxAttempts ? "dead" : "pending";
				const updated = await db.update<unknown>({
					model: "runtime_task",
					where: [
						{ field: "id", value: lease.taskId },
						{ field: "status", value: "leased", connector: "AND" },
						{ field: "leaseId", value: lease.id, connector: "AND" },
					],
					update: {
						status,
						lastError: "lease expired",
						dueAt:
							status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
						leaseId: null,
						workerId: null,
						leasedUntil: null,
						updatedAt: ts,
					},
				});
				if (updated && status === "dead") {
					await store.updateRun(task.runId, { status: "failed" });
				}
				count++;
			}
			return count;
		},

		async appendEvent(input) {
			const record = validateEvent({
				id: newId(),
				runId: input.runId,
				type: input.type,
				payload: input.payload ?? {},
				createdAt: now(),
			});
			await db.create({ model: "run_event", data: record });
			return record;
		},

		async events(runId) {
			const rows = await db.findMany<unknown>({
				model: "run_event",
				where: [{ field: "runId", value: runId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
			return rows.map((row) => validateEvent(row));
		},

		requestHash(body) {
			return hashText(stringifyJson(body, "request body"));
		},

		async getIdempotency(input) {
			// The id IS the hash of the scope tuple (key/method/path/tenantId/actor), so a primary-key
			// lookup is exactly the scoped match — and it sidesteps `WHERE col = NULL` (never true in SQL,
			// and undefined !== null in the memory adapter) for absent tenant/actor.
			const row = await db.findOne<unknown>({
				model: "idempotency_key",
				where: [{ field: "id", value: idempotencyId(input) }],
			});
			if (!row) return null;
			const record = validateIdempotencyRecord(row);
			if (record.requestHash !== input.requestHash) {
				throw stateError(
					"idempotency key reused with a different request body",
					{
						key: input.key,
						method: input.method,
						path: input.path,
					},
				);
			}
			return record;
		},

		async saveIdempotency(input) {
			const existing = await store.getIdempotency(input);
			if (existing) return existing;
			const record = validateIdempotencyRecord({
				id: idempotencyId(input),
				key: input.key,
				method: input.method,
				path: input.path,
				tenantId: input.tenantId,
				actor: input.actor,
				requestHash: input.requestHash,
				responseStatus: input.responseStatus,
				responseBody: input.responseBody,
				createdAt: now(),
			});
			try {
				await db.create({ model: "idempotency_key", data: record });
			} catch (err) {
				const raced = await store.getIdempotency(input);
				if (raced) return raced;
				throw err;
			}
			return record;
		},
	};

	return store;
}
