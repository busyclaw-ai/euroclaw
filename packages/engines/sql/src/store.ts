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

import { jsonObject as jsonObjectSchema } from "@euroclaw/core";
import {
	configurationError,
	errorMessage,
	stateError,
	validationError,
} from "@euroclaw/errors";
import type { Adapter, Where } from "@euroclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type as ark } from "arktype";

export const RunStatus = ark(
	"'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'",
);
export type RunStatus = typeof RunStatus.infer;

export const TaskStatus = ark(
	"'pending' | 'leased' | 'completed' | 'failed' | 'dead'",
);
export type TaskStatus = typeof TaskStatus.infer;

const JsonRecord = jsonObjectSchema;
const SerializedJsonObject = jsonObjectSchema;
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

const OptionalDbString = ark("string | null | undefined");

const RunRow = ark({
	id: "string",
	status: RunStatus,
	input: "string",
	"actor?": OptionalDbString,
	"team?": OptionalDbString,
	createdAt: "string",
	updatedAt: "string",
});
type RunRow = typeof RunRow.infer;

const TaskRow = ark({
	id: "string",
	runId: "string",
	kind: "string",
	status: TaskStatus,
	payload: "string",
	dueAt: "string",
	attempt: "number",
	maxAttempts: "number",
	retryDelayMs: "number",
	"leaseId?": OptionalDbString,
	"workerId?": OptionalDbString,
	"leasedUntil?": OptionalDbString,
	"lastError?": OptionalDbString,
	"output?": OptionalDbString,
	createdAt: "string",
	updatedAt: "string",
	"completedAt?": OptionalDbString,
});
type TaskRow = typeof TaskRow.infer;

const EventRow = ark({
	id: "string",
	runId: "string",
	type: "string",
	payload: "string",
	createdAt: "string",
});
type EventRow = typeof EventRow.infer;

const IdempotencyRow = ark({
	id: "string",
	key: "string",
	method: "string",
	path: "string",
	"tenantId?": OptionalDbString,
	"actor?": OptionalDbString,
	requestHash: "string",
	responseStatus: "number",
	responseBody: "string",
	createdAt: "string",
});
type IdempotencyRow = typeof IdempotencyRow.infer;

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
		patch: Partial<Pick<RunRecord, "status" | "updatedAt">>,
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

function dropUndefined<T extends Record<string, unknown>>(
	value: T,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...value };
	for (const key of Object.keys(out))
		if (out[key] === undefined) delete out[key];
	return out;
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

function parseSerializedJsonObject(
	value: string,
	label: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch (err) {
		throw validationError(`${label} invalid JSON`, errorMessage(err));
	}
	const valid = SerializedJsonObject(parsed);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	return valid;
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

function parseRunRow(row: unknown): RunRow {
	const valid = RunRow(row);
	if (valid instanceof ark.errors) {
		throw validationError("run row invalid", valid.summary);
	}
	return valid;
}

function parseTaskRow(row: unknown): TaskRow {
	const valid = TaskRow(row);
	if (valid instanceof ark.errors) {
		throw validationError("runtime task row invalid", valid.summary);
	}
	return valid;
}

function parseEventRow(row: unknown): EventRow {
	const valid = EventRow(row);
	if (valid instanceof ark.errors) {
		throw validationError("run event row invalid", valid.summary);
	}
	return valid;
}

function parseIdempotencyRow(row: unknown): IdempotencyRow {
	const valid = IdempotencyRow(row);
	if (valid instanceof ark.errors) {
		throw validationError("idempotency row invalid", valid.summary);
	}
	return valid;
}

function runFromRow(row: unknown): RunRecord {
	const valid = parseRunRow(row);
	return validateRunRecord({
		id: valid.id,
		status: valid.status,
		input: parseSerializedJsonObject(valid.input, "run.input"),
		actor: valid.actor ?? undefined,
		team: valid.team ?? undefined,
		createdAt: valid.createdAt,
		updatedAt: valid.updatedAt,
	});
}

function taskFromRow(row: unknown): RuntimeTask {
	const valid = parseTaskRow(row);
	return validateTask({
		id: valid.id,
		runId: valid.runId,
		kind: valid.kind,
		status: valid.status,
		payload: parseSerializedJsonObject(valid.payload, "runtime_task.payload"),
		dueAt: valid.dueAt,
		attempt: valid.attempt,
		maxAttempts: valid.maxAttempts,
		retryDelayMs: valid.retryDelayMs,
		leaseId: valid.leaseId ?? undefined,
		workerId: valid.workerId ?? undefined,
		leasedUntil: valid.leasedUntil ?? undefined,
		lastError: valid.lastError ?? undefined,
		output:
			valid.output == null
				? undefined
				: parseSerializedJsonObject(valid.output, "runtime_task.output"),
		createdAt: valid.createdAt,
		updatedAt: valid.updatedAt,
		completedAt: valid.completedAt ?? undefined,
	});
}

function eventFromRow(row: unknown): RunEvent {
	const valid = parseEventRow(row);
	return validateEvent({
		id: valid.id,
		runId: valid.runId,
		type: valid.type,
		payload: parseSerializedJsonObject(valid.payload, "run_event.payload"),
		createdAt: valid.createdAt,
	});
}

function leaseFromRow(row: unknown): LeaseRecord {
	return validateLeaseRecord(row);
}

function idempotencyFromRow(row: unknown): IdempotencyRecord {
	const valid = parseIdempotencyRow(row);
	return validateIdempotencyRecord({
		id: valid.id,
		key: valid.key,
		method: valid.method,
		path: valid.path,
		tenantId: valid.tenantId ?? undefined,
		actor: valid.actor ?? undefined,
		requestHash: valid.requestHash,
		responseStatus: valid.responseStatus,
		responseBody: parseSerializedJsonObject(
			valid.responseBody,
			"idempotency.responseBody",
		),
		createdAt: valid.createdAt,
	});
}

function pendingWhere(now: string): Where[] {
	return [
		{ field: "status", value: "pending" },
		{ field: "dueAt", value: now, operator: "lte", connector: "AND" },
	];
}

function scopedIdempotencyWhere(input: IdempotencyLookup): Where[] {
	return [
		{ field: "key", value: input.key },
		{ field: "method", value: input.method, connector: "AND" },
		{ field: "path", value: input.path, connector: "AND" },
		{
			field: "tenantId",
			value: input.tenantId ?? null,
			connector: "AND",
		},
		{ field: "actor", value: input.actor ?? null, connector: "AND" },
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

	async function validateLease(
		task: RuntimeTask,
		token: string,
	): Promise<LeaseRecord | null> {
		if (task.leaseId === undefined) return null;
		const row = await adapter.findOne<unknown>({
			model: leaseModel,
			where: [{ field: "id", value: task.leaseId }],
		});
		if (!row) return null;
		const lease = leaseFromRow(row);
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
			const row: RunRow = {
				id: input.id ?? newId(),
				status: "queued",
				input: stringifyJson(input.input ?? {}, "run.input"),
				actor: input.actor,
				team: input.team,
				createdAt: ts,
				updatedAt: ts,
			};
			await adapter.create({ model: runModel, data: dropUndefined(row) });
			return runFromRow(row);
		},

		async getRun(id) {
			const row = await adapter.findOne<unknown>({
				model: runModel,
				where: [{ field: "id", value: id }],
			});
			return row ? runFromRow(row) : null;
		},

		async updateRun(id, patch) {
			const row = await adapter.update<unknown>({
				model: runModel,
				where: [{ field: "id", value: id }],
				update: dropUndefined({
					...patch,
					updatedAt: patch.updatedAt ?? now(),
				}),
			});
			return row ? runFromRow(row) : null;
		},

		async enqueueTask(input) {
			const ts = now();
			const row: TaskRow = {
				id: input.id ?? newId(),
				runId: input.runId,
				kind: input.kind,
				status: "pending",
				payload: stringifyJson(input.payload ?? {}, "runtime_task.payload"),
				dueAt: input.dueAt ?? ts,
				attempt: 0,
				maxAttempts: input.maxAttempts ?? 1,
				retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
				createdAt: ts,
				updatedAt: ts,
			};
			await adapter.create({ model: taskModel, data: dropUndefined(row) });
			return taskFromRow(row);
		},

		async getTask(id) {
			const row = await adapter.findOne<unknown>({
				model: taskModel,
				where: [{ field: "id", value: id }],
			});
			return row ? taskFromRow(row) : null;
		},

		async claimDueTask(input) {
			await store.reapExpiredLeases();
			const ts = now();
			const candidates = await adapter.findMany<unknown>({
				model: taskModel,
				where: pendingWhere(ts),
				sortBy: { field: "dueAt", direction: "asc" },
				limit: input.limit ?? 10,
			});
			for (const candidateRow of candidates) {
				const candidate = taskFromRow(candidateRow);
				if (candidate.attempt >= candidate.maxAttempts) {
					await adapter.update<unknown>({
						model: taskModel,
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
				await adapter.create({ model: leaseModel, data: lease });
				const updated = await adapter.update<unknown>({
					model: taskModel,
					where: [
						{ field: "id", value: candidate.id },
						{ field: "status", value: "pending", connector: "AND" },
					],
					update: {
						status: "leased",
						leaseId,
						workerId: input.workerId,
						leasedUntil: expiresAt,
						attempt: Number(candidate.attempt) + 1,
						updatedAt: ts,
					},
				});
				if (!updated) {
					await adapter.delete({
						model: leaseModel,
						where: [{ field: "id", value: leaseId }],
					});
					continue;
				}
				const task = taskFromRow(updated);
				await store.updateRun(task.runId, { status: "running" });
				return { task, leaseId, leaseToken, expiresAt };
			}
			return null;
		},

		async heartbeatLease(input) {
			const leaseRow = await adapter.findOne<unknown>({
				model: leaseModel,
				where: [{ field: "id", value: input.leaseId }],
			});
			if (!leaseRow) return null;
			const lease = leaseFromRow(leaseRow);
			if (lease.expiresAt <= now()) return null;
			if (lease.tokenHash !== hashText(input.leaseToken)) return null;
			const ts = now();
			const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
			const tokenHash = hashText(input.leaseToken);
			const updated = await adapter.update<unknown>({
				model: leaseModel,
				where: [
					{ field: "id", value: input.leaseId },
					{ field: "tokenHash", value: tokenHash, connector: "AND" },
					{ field: "expiresAt", value: ts, operator: "gt", connector: "AND" },
				],
				update: { expiresAt, lastHeartbeatAt: ts },
			});
			if (!updated) return null;
			await adapter.update<unknown>({
				model: taskModel,
				where: [
					{ field: "id", value: lease.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: input.leaseId, connector: "AND" },
					{ field: "workerId", value: lease.workerId, connector: "AND" },
				],
				update: { leasedUntil: expiresAt, updatedAt: ts },
			});
			return leaseFromRow(updated);
		},

		async completeTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const row = await adapter.update<unknown>({
				model: taskModel,
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: dropUndefined({
					status: "completed",
					output:
						input.output !== undefined
							? stringifyJson(input.output, "runtime_task.output")
							: undefined,
					completedAt: ts,
					updatedAt: ts,
				}),
			});
			if (!row) return null;
			await adapter.delete({
				model: leaseModel,
				where: [{ field: "id", value: lease.id }],
			});
			return taskFromRow(row);
		},

		async failTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const status: TaskStatus =
				task.attempt >= task.maxAttempts ? "dead" : "pending";
			const row = await adapter.update<unknown>({
				model: taskModel,
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: dropUndefined({
					status,
					lastError: input.reason,
					dueAt:
						status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				}),
			});
			await adapter.delete({
				model: leaseModel,
				where: [{ field: "id", value: lease.id }],
			});
			return row ? taskFromRow(row) : null;
		},

		async reapExpiredLeases() {
			const ts = now();
			const leaseRows = await adapter.findMany<unknown>({
				model: leaseModel,
				where: [{ field: "expiresAt", value: ts, operator: "lte" }],
			});
			let count = 0;
			for (const leaseRow of leaseRows) {
				const candidate = leaseFromRow(leaseRow);
				const consumedLeaseRow = await adapter.consumeOne<unknown>({
					model: leaseModel,
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
				const lease = leaseFromRow(consumedLeaseRow);
				const taskRow = await adapter.findOne<unknown>({
					model: taskModel,
					where: [{ field: "id", value: lease.taskId }],
				});
				if (!taskRow) continue;
				const task = taskFromRow(taskRow);
				const status: TaskStatus =
					task.attempt >= task.maxAttempts ? "dead" : "pending";
				const updated = await adapter.update<unknown>({
					model: taskModel,
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
			const row: EventRow = {
				id: newId(),
				runId: input.runId,
				type: input.type,
				payload: stringifyJson(input.payload ?? {}, "run_event.payload"),
				createdAt: now(),
			};
			await adapter.create({ model: eventModel, data: row });
			return eventFromRow(row);
		},

		async events(runId) {
			const rows = await adapter.findMany<unknown>({
				model: eventModel,
				where: [{ field: "runId", value: runId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
			return rows.map(eventFromRow);
		},

		requestHash(body) {
			return hashText(stringifyJson(body, "request body"));
		},

		async getIdempotency(input) {
			const row = await adapter.findOne<unknown>({
				model: idempotencyModel,
				where: scopedIdempotencyWhere(input),
			});
			if (!row) return null;
			const record = idempotencyFromRow(row);
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
			const row: IdempotencyRow = {
				id: idempotencyId(input),
				key: input.key,
				method: input.method,
				path: input.path,
				tenantId: input.tenantId ?? null,
				actor: input.actor ?? null,
				requestHash: input.requestHash,
				responseStatus: input.responseStatus,
				responseBody: stringifyJson(
					input.responseBody,
					"idempotency.responseBody",
				),
				createdAt: now(),
			};
			try {
				await adapter.create({
					model: idempotencyModel,
					data: dropUndefined(row),
				});
			} catch (err) {
				const raced = await store.getIdempotency(input);
				if (raced) return raced;
				throw err;
			}
			return idempotencyFromRow(row);
		},
	};

	return store;
}
