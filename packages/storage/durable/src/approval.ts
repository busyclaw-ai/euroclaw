// createApprovalStore — the @euroclaw/core ApprovalStore port, backed by any @euroclaw/storage-core
// Adapter (memory / kysely / drizzle / prisma / mongo). The single-use guarantee rides on the
// Adapter's atomic `consumeOne` primitive, so a granted approval resumes exactly once even under
// concurrent retries. Governance's ports + the Adapter port are imported TYPE-ONLY — no runtime coupling.

import {
	type ApprovalRecord,
	type ApprovalStore,
	approvalRecord as approvalRecordSchema,
	jsonObject,
	type NewApproval,
	newApproval as newApprovalSchema,
} from "@euroclaw/core";
import { errorMessage, validationError } from "@euroclaw/errors";
import type { Adapter, Where } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type ApprovalStoreOptions = {
	/** The table/model the approvals live in. Default "approval". */
	model?: string;
	/** Time source — for deterministic expiry in tests. */
	now?: () => string;
};

const newId = (): string => bytesToHex(randomBytes(16));

const ApprovalRow = type({
	id: "string",
	status: "'pending' | 'approved' | 'denied' | 'consumed'",
	gateId: "string",
	toolName: "string",
	args: "string",
	"reasonCode?": "string | null | undefined",
	"metadata?": "string | null | undefined",
	"actor?": "string | null | undefined",
	"reason?": "string | null | undefined",
	"decidedBy?": "string | null | undefined",
	createdAt: "string",
	"expiresAt?": "string | null | undefined",
});

function parseArgs(args: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(args) as unknown;
	} catch (err) {
		throw validationError("approval args invalid JSON", errorMessage(err));
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw validationError("approval args invalid", "expected object");
	}
	const valid = jsonObject(parsed);
	if (valid instanceof type.errors) {
		throw validationError("approval args invalid", valid.summary);
	}
	return valid;
}

function parseMetadata(
	metadata: string | null | undefined,
): unknown | undefined {
	if (metadata == null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata) as unknown;
	} catch (err) {
		throw validationError("approval metadata invalid JSON", errorMessage(err));
	}
	const valid = jsonObject(parsed);
	if (valid instanceof type.errors) {
		throw validationError("approval metadata invalid", valid.summary);
	}
	return valid;
}

function validateRecord(record: unknown): ApprovalRecord {
	const valid = approvalRecordSchema(record) as ApprovalRecord | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("approval record invalid", valid.summary);
	}
	return valid;
}

function validateNewApproval(input: unknown): NewApproval {
	const valid = newApprovalSchema(input) as NewApproval | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("new approval invalid", valid.summary);
	}
	return valid;
}

// `args` is structured data; our lean adapters don't coerce JSON columns, so the store owns the
// (de)serialization — uniform across memory/SQL adapters. Undefined optionals are dropped so a SQL
// insert only touches the columns it has values for (the rest default NULL).
function toRow(record: ApprovalRecord): Record<string, unknown> {
	const valid = validateRecord(record);
	const row: Record<string, unknown> = {
		...valid,
		args: JSON.stringify(valid.args),
		metadata:
			valid.metadata !== undefined ? JSON.stringify(valid.metadata) : undefined,
	};
	for (const key of Object.keys(row))
		if (row[key] === undefined) delete row[key];
	return row;
}

function fromRow(row: Record<string, unknown>): ApprovalRecord {
	const valid = ApprovalRow(row);
	if (valid instanceof type.errors) {
		throw validationError("approval row invalid", valid.summary);
	}
	return validateRecord({
		id: valid.id,
		status: valid.status,
		gateId: valid.gateId,
		toolName: valid.toolName,
		args: parseArgs(valid.args),
		reasonCode: valid.reasonCode ?? undefined,
		metadata: parseMetadata(valid.metadata),
		actor: valid.actor ?? undefined,
		reason: valid.reason ?? undefined,
		decidedBy: valid.decidedBy ?? undefined,
		createdAt: valid.createdAt,
		expiresAt: valid.expiresAt ?? undefined,
	});
}

/** Back the ApprovalStore port with a storage Adapter. */
export function createApprovalStore(
	adapter: Adapter,
	options: ApprovalStoreOptions = {},
): ApprovalStore {
	const model = options.model ?? "approval";
	const now = options.now ?? (() => new Date().toISOString());

	// Only a still-pending row can be granted/denied — guards against deciding a consumed approval.
	const wherePending = (id: string): Where[] => [
		{ field: "id", value: id },
		{ field: "status", value: "pending", connector: "AND" },
	];

	return {
		async create(input) {
			const valid = validateNewApproval(input);
			const record: ApprovalRecord = {
				id: newId(),
				status: "pending",
				...valid,
			};
			await adapter.create({ model, data: toRow(record) });
			return record;
		},

		async get(id) {
			const row = await adapter.findOne<Record<string, unknown>>({
				model,
				where: [{ field: "id", value: id }],
			});
			return row ? fromRow(row) : null;
		},

		async grant(id, by) {
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: wherePending(id),
				update: { status: "approved", decidedBy: by },
			});
			return row ? fromRow(row) : null;
		},

		async deny(id, by, reason) {
			const update: Record<string, unknown> = {
				status: "denied",
				decidedBy: by,
			};
			if (reason !== undefined) update.reason = reason;
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: wherePending(id),
				update,
			});
			return row ? fromRow(row) : null;
		},

		async consume(id) {
			const existingRow = await adapter.findOne<Record<string, unknown>>({
				model,
				where: [
					{ field: "id", value: id },
					{ field: "status", value: "approved", connector: "AND" },
				],
			});
			if (!existingRow) return null;
			const existing = fromRow(existingRow);
			if (existing.expiresAt != null && existing.expiresAt < now()) return null;

			// Atomic transition of the approved row by id — race-safe single use while preserving
			// checkpoint metadata for crash recovery.
			const row = await adapter.update<Record<string, unknown>>({
				model,
				where: [
					{ field: "id", value: id },
					{ field: "status", value: "approved", connector: "AND" },
				],
				update: { status: "consumed" },
			});
			if (!row) return null;
			return fromRow(row);
		},

		async list(filter) {
			const where: Where[] = [];
			if (filter?.status !== undefined)
				where.push({ field: "status", value: filter.status });
			if (filter?.actor !== undefined)
				where.push({ field: "actor", value: filter.actor, connector: "AND" });
			const rows = await adapter.findMany<Record<string, unknown>>({
				model,
				where,
			});
			return rows.map(fromRow);
		},
	};
}
