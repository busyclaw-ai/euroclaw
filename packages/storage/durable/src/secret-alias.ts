// createSecretAliasStore — the per-org secret-alias store (SecretAliasStore port), backed by any
// @euroclaw/storage-core Adapter. Product durable state (rides the same adapter as the tool registry),
// contributed to the schema ONLY when `dynamicSecretAliases.enabled`. Rows are POINTERS — {provider,
// ref} into the org's own SM, never a value. Uniqueness on (organizationId, name) is enforced here
// (findOne-then-upsert), like spec_registration. Every READ is parsed through the record schema
// (untrusted boundary: a hostile row fails loud, not casts).
//
// Enabled-but-not-migrated safety net: enabling adds `secret_alias` to the generated schema (host runs
// generate→migrate, exactly like better-auth's organizationRole). If the table isn't there, a DB call
// throws a native "no such table"/"does not exist" error — every op wraps that into a clear
// `configurationError` (run the migration). Fires on first table access (a DB-alias resolution in
// `secrets.get`, or a `claw.api.secrets` call). Fail LOUD — the resolver NEVER falls through to
// inline/direct on a missing table (a wrong-credential hazard).

import {
	type Adapter,
	configurationError,
	errorMessage,
	type SecretAliasPointer,
	type SecretAliasRecord,
	type SecretAliasStore,
	type SecretAliasUpsert,
	secretAliasRecord as secretAliasRecordSchema,
	secretAliasSchema,
	secretAliasUpsert as secretAliasUpsertSchema,
	stateError,
	validationError,
	type Where,
} from "@euroclaw/contracts";
import { schemaAdapter } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

type SecretAliasStoreOptions = {
	/** Time source — for deterministic createdAt/updatedAt in tests. */
	now?: () => string;
};

const MODEL = "secret_alias";
const newId = (): string => bytesToHex(randomBytes(16));
const whereEq = (field: string, value: string): Where => ({ field, value });
const andEq = (field: string, value: string): Where => ({
	field,
	value,
	connector: "AND",
});

/** A DB error meaning the `secret_alias` table isn't migrated — sqlite/postgres/mysql phrasings. */
function isMissingTableError(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return (
		message.includes("no such table") || // sqlite
		message.includes("does not exist") || // postgres: relation "secret_alias" does not exist
		message.includes("doesn't exist") || // mysql
		message.includes("no such relation") ||
		message.includes("unknown table")
	);
}

/** Rethrow a table-missing DB error as an actionable configurationError; otherwise rethrow as-is. */
function wrapMissingTable(err: unknown): never {
	if (isMissingTableError(err)) {
		throw configurationError(
			"secret_alias table isn't in your database — run the migration for dynamicSecretAliases",
			{
				reason:
					"enabling dynamicSecretAliases adds secret_alias to the generated schema — run generate + migrate to create it",
				cause: errorMessage(err),
			},
		);
	}
	throw err;
}

/** Run one adapter op behind the missing-table safety net. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		return wrapMissingTable(err);
	}
}

/** Back the SecretAliasStore port with a storage Adapter. */
export function createSecretAliasStore(
	adapter: Adapter,
	options: SecretAliasStoreOptions = {},
): SecretAliasStore {
	const now = options.now ?? (() => new Date().toISOString());
	const db = schemaAdapter(adapter, secretAliasSchema);

	function validate(record: unknown): SecretAliasRecord {
		const valid = secretAliasRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("secret alias record invalid", valid.summary);
		}
		return valid;
	}
	function validateUpsert(input: unknown): SecretAliasUpsert {
		const valid = secretAliasUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("secret alias input invalid", valid.summary);
		}
		return valid;
	}

	return {
		async list(organizationId) {
			const rows = await guarded(() =>
				db.findMany<SecretAliasRecord>({
					model: MODEL,
					where: [whereEq("organizationId", organizationId)],
				}),
			);
			return rows.map(validate);
		},

		async get(organizationId, name) {
			const row = await guarded(() =>
				db.findOne<SecretAliasRecord>({
					model: MODEL,
					where: [
						whereEq("organizationId", organizationId),
						andEq("name", name),
					],
				}),
			);
			return row ? validate(row) : null;
		},

		async set(organizationId, name, pointer: SecretAliasPointer) {
			const valid = validateUpsert({
				organizationId,
				name,
				provider: pointer.provider,
				ref: pointer.ref,
			});
			const existing = await guarded(() =>
				db.findOne<SecretAliasRecord>({
					model: MODEL,
					where: [
						whereEq("organizationId", organizationId),
						andEq("name", name),
					],
				}),
			);
			const stamp = now();
			if (existing) {
				const prev = validate(existing);
				const updated = await guarded(() =>
					db.update<SecretAliasRecord>({
						model: MODEL,
						where: [whereEq("id", prev.id)],
						// The store owns updatedAt; provider/ref are the only mutable columns.
						update: {
							provider: valid.provider,
							ref: valid.ref,
							updatedAt: stamp,
						},
					}),
				);
				if (!updated) {
					throw stateError("secret alias vanished mid-set", { id: prev.id });
				}
				return validate(updated);
			}
			const record = validate({
				...valid,
				id: newId(),
				createdAt: stamp,
				updatedAt: stamp,
			});
			await guarded(() => db.create({ model: MODEL, data: record }));
			return record;
		},

		async delete(organizationId, name) {
			await guarded(() =>
				db.delete({
					model: MODEL,
					where: [
						whereEq("organizationId", organizationId),
						andEq("name", name),
					],
				}),
			);
		},

		async listAll() {
			const rows = await guarded(() =>
				db.findMany<SecretAliasRecord>({ model: MODEL }),
			);
			return rows.map(validate);
		},
	};
}
