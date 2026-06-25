import {
	type EffectClaim,
	type EffectRecord,
	type EffectStore,
	effectRecord as effectRecordSchema,
	jsonValue as jsonValueSchema,
} from "@euroclaw/core";
import { errorMessage, stateError, validationError } from "@euroclaw/errors";
import type { Adapter } from "@euroclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type EffectStoreOptions = {
	/** The table/model effects live in. Default "effect". */
	model?: string;
};

const EffectRow = type({
	id: "string",
	status:
		"'started' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'compensation_failed'",
	toolName: "string",
	inputHash: "string",
	"output?": "string | null | undefined",
	"error?": "string | null | undefined",
	"compensation?": "string | null | undefined",
	"compensationEffectId?": "string | null | undefined",
	"leaseTokenHash?": "string | null | undefined",
	"leaseExpiresAt?": "string | null | undefined",
	createdAt: "string",
	updatedAt: "string",
});

const DEFAULT_EFFECT_LEASE_TTL_MS = 60_000;

const newToken = (): string => bytesToHex(randomBytes(16));
const hashToken = (value: string): string =>
	bytesToHex(sha256(utf8ToBytes(value)));
const addMs = (iso: string, ms: number): string =>
	new Date(new Date(iso).getTime() + ms).toISOString();

function parseJson(value: string | null | undefined, label: string): unknown {
	if (value == null) return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch (err) {
		throw validationError(`${label} invalid JSON`, errorMessage(err));
	}
}

function stringifyJson(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	const valid = jsonValueSchema(value);
	if (valid instanceof type.errors) {
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

function validateRecord(value: unknown): EffectRecord {
	const valid = effectRecordSchema(value);
	if (valid instanceof type.errors) {
		throw validationError("effect record invalid", valid.summary);
	}
	return valid;
}

function fromRow(row: unknown): EffectRecord {
	const valid = EffectRow(row);
	if (valid instanceof type.errors) {
		throw validationError("effect row invalid", valid.summary);
	}
	return validateRecord({
		id: valid.id,
		status: valid.status,
		toolName: valid.toolName,
		inputHash: valid.inputHash,
		output: parseJson(valid.output, "effect.output"),
		error: parseJson(valid.error, "effect.error"),
		compensation: parseJson(valid.compensation, "effect.compensation"),
		compensationEffectId: valid.compensationEffectId ?? undefined,
		leaseExpiresAt: valid.leaseExpiresAt ?? undefined,
		createdAt: valid.createdAt,
		updatedAt: valid.updatedAt,
	});
}

function toRow(
	record: EffectRecord,
	leaseTokenHash?: string,
): Record<string, unknown> {
	const valid = validateRecord(record);
	const row: Record<string, unknown> = {
		...valid,
		output: stringifyJson(valid.output, "effect.output"),
		error: stringifyJson(valid.error, "effect.error"),
		compensation: stringifyJson(valid.compensation, "effect.compensation"),
		leaseTokenHash,
	};
	for (const key of Object.keys(row)) {
		if (row[key] === undefined) delete row[key];
	}
	return row;
}

export function createEffectStore(
	adapter: Adapter,
	options: EffectStoreOptions = {},
): EffectStore {
	const model = options.model ?? "effect";
	const locks = new Map<string, Promise<void>>();

	const read = async (id: string): Promise<EffectRecord | null> => {
		const row = await adapter.findOne<Record<string, unknown>>({
			model,
			where: [{ field: "id", value: id }],
		});
		return row ? fromRow(row) : null;
	};

	const withLock = async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
		const previous = locks.get(id) ?? Promise.resolve();
		let release: () => void = () => {};
		const next = previous.then(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		locks.set(id, next);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (locks.get(id) === next) locks.delete(id);
		}
	};

	const assertSameEffect = (
		input: { id: string; toolName: string; inputHash: string },
		record: EffectRecord,
	): void => {
		if (
			record.toolName !== input.toolName ||
			record.inputHash !== input.inputHash
		) {
			throw stateError("effect id reused with different input", {
				effectId: input.id,
			});
		}
	};

	const activeLeaseWhere = (input: {
		id: string;
		leaseToken: string;
		now: string;
	}) => [
		{ field: "id", value: input.id },
		{ field: "status", value: "started", connector: "AND" as const },
		{
			field: "leaseTokenHash",
			value: hashToken(input.leaseToken),
			connector: "AND" as const,
		},
		{
			field: "leaseExpiresAt",
			value: input.now,
			operator: "gt" as const,
			connector: "AND" as const,
		},
	];

	const unavailableClaim = (record: EffectRecord): EffectClaim => {
		if (record.status === "completed") return { status: "completed", record };
		if (record.status === "started") {
			return {
				status: "in_progress",
				record,
				leaseExpiresAt: record.leaseExpiresAt,
			};
		}
		return { status: "unavailable", record };
	};
	const uncertainClaim = (record: EffectRecord): EffectClaim => ({
		status: "uncertain",
		record,
		leaseExpiresAt: record.leaseExpiresAt,
	});

	return {
		async get(id) {
			return read(id);
		},

		async claim(input) {
			return withLock(input.id, async () => {
				const leaseToken = newToken();
				const leaseExpiresAt = addMs(
					input.now,
					input.leaseTtlMs ?? DEFAULT_EFFECT_LEASE_TTL_MS,
				);
				const leaseTokenHash = hashToken(leaseToken);
				const claimRecord = (record: EffectRecord): EffectClaim => ({
					status: "claimed",
					record,
					leaseToken,
					leaseExpiresAt,
				});

				const claimExisting = async (
					record: EffectRecord,
				): Promise<EffectClaim> => {
					assertSameEffect(input, record);
					if (record.status === "completed")
						return { status: "completed", record };
					if (record.status !== "started")
						return { status: "unavailable", record };
					if (record.leaseExpiresAt && record.leaseExpiresAt > input.now) {
						return {
							status: "in_progress",
							record,
							leaseExpiresAt: record.leaseExpiresAt,
						};
					}
					if (!record.leaseExpiresAt) return { status: "in_progress", record };
					if (input.reclaimExpired === false) return uncertainClaim(record);
					const row = await adapter.update<Record<string, unknown>>({
						model,
						where: [
							{ field: "id", value: input.id },
							{ field: "status", value: "started", connector: "AND" },
							{
								field: "leaseExpiresAt",
								value: input.now,
								operator: "lte",
								connector: "AND",
							},
						],
						update: { leaseTokenHash, leaseExpiresAt, updatedAt: input.now },
					});
					if (row) return claimRecord(fromRow(row));
					const latest = await read(input.id);
					if (!latest) return { status: "unavailable", record };
					assertSameEffect(input, latest);
					return unavailableClaim(latest);
				};

				const existing = await read(input.id);
				if (existing) return claimExisting(existing);

				const record: EffectRecord = {
					id: input.id,
					status: "started",
					toolName: input.toolName,
					inputHash: input.inputHash,
					compensation: input.compensation,
					leaseExpiresAt,
					createdAt: input.now,
					updatedAt: input.now,
				};
				try {
					await adapter.create({ model, data: toRow(record, leaseTokenHash) });
					return claimRecord(record);
				} catch (err) {
					const raced = await read(input.id);
					if (!raced) throw err;
					return claimExisting(raced);
				}
			});
		},

		async heartbeat(input) {
			const leaseExpiresAt = addMs(
				input.now,
				input.leaseTtlMs ?? DEFAULT_EFFECT_LEASE_TTL_MS,
			);
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: activeLeaseWhere(input),
				update: { leaseExpiresAt, updatedAt: input.now },
			});
			return row ? fromRow(row) : null;
		},

		async complete(input) {
			const update: Record<string, unknown> = {
				status: "completed",
				leaseTokenHash: null,
				leaseExpiresAt: null,
				updatedAt: input.now,
			};
			if (input.output !== undefined) {
				update.output = stringifyJson(input.output, "effect.output");
			}
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: activeLeaseWhere(input),
				update,
			});
			if (!row) {
				throw validationError(
					"effect complete invalid",
					"effect lease is not active",
					{
						effectId: input.id,
					},
				);
			}
			return fromRow(row);
		},

		async fail(input) {
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: activeLeaseWhere(input),
				update: {
					status: "failed",
					error: stringifyJson(input.error, "effect.error"),
					leaseTokenHash: null,
					leaseExpiresAt: null,
					updatedAt: input.now,
				},
			});
			if (!row) {
				throw validationError(
					"effect fail invalid",
					"effect lease is not active",
					{
						effectId: input.id,
					},
				);
			}
			return fromRow(row);
		},
	};
}
