// createRegistryStores — the tool-registry ports (SpecRegistrationStore / RegisteredToolStore /
// FactsOverlayStore) plus the slice-6b customer-policy stores (PolicySliceStore + the append-only
// AuthzChangeStore), backed by any @euroclaw/storage-core Adapter. JSON columns (specBlob, report,
// inputSchema, governance, binding, groups, summary) are (de)serialized by `schemaAdapter` from the
// entity schema — the stores never hand-roll row mapping. Every READ is parsed through the record
// schema (untrusted boundary: a hostile row must fail loud, not cast).
//
// The authz change log is the router's version source: every authz mutation here — facts_overlay and
// policy_slice upsert AND delete — APPENDS an authz_change (createSpecRegistry appends the
// spec_registered event). Append-only ⇒ count() is monotonic ⇒ authzBundleKey is sound under delete.
//
// Replace semantics: spec_registration replaces in place per (organizationId, source) — all its
// mutable columns are re-set, id/createdAt preserved. facts_overlay replaces per (organizationId,
// actionId) by delete-then-create, because a replace must CLEAR optional facts an earlier override
// set (a partial update can only add, and a nulled JSON column would fail the record schema on
// read-back) — a fresh row is the honest "the override was replaced".

import type { Adapter, Where } from "@euroclaw/contracts";
import {
	type AuthzChangeAppend,
	type AuthzChangeRecord,
	type AuthzChangeStore,
	authzChangeAppend as authzChangeAppendSchema,
	authzChangeRecord as authzChangeRecordSchema,
	authzChangeSchema,
	type FactsOverlayRecord,
	type FactsOverlayStore,
	type FactsOverlayUpsert,
	factsOverlayRecord as factsOverlayRecordSchema,
	factsOverlaySchema,
	factsOverlayUpsert as factsOverlayUpsertSchema,
	type PolicySliceRecord,
	type PolicySliceStore,
	type PolicySliceUpsert,
	policySliceRecord as policySliceRecordSchema,
	policySliceSchema,
	policySliceUpsert as policySliceUpsertSchema,
	type RegisteredToolCreate,
	type RegisteredToolPatch,
	type RegisteredToolRecord,
	type RegisteredToolStore,
	registeredToolCreate as registeredToolCreateSchema,
	registeredToolPatch as registeredToolPatchSchema,
	registeredToolRecord as registeredToolRecordSchema,
	registeredToolSchema,
	type SpecRegistrationRecord,
	type SpecRegistrationStore,
	type SpecRegistrationUpsert,
	specRegistrationRecord as specRegistrationRecordSchema,
	specRegistrationSchema,
	specRegistrationUpsert as specRegistrationUpsertSchema,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import { schemaAdapter } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

type RegistryStoresOptions = {
	/** Time source — for deterministic createdAt/updatedAt in tests. */
	now?: () => string;
};

/** The registry ports over one adapter (they share the `now`/id sources). Also carries the slice-6b
 *  customer-policy stores — the policy slices and the append-only authz change log (whose count keys
 *  the org policy router). They ride the same adapter as product durable state, not a plugin. */
export type RegistryStores = {
	specRegistrations: SpecRegistrationStore;
	registeredTools: RegisteredToolStore;
	factsOverlay: FactsOverlayStore;
	policySlices: PolicySliceStore;
	authzChanges: AuthzChangeStore;
};

const SPEC_MODEL = "spec_registration";
const TOOL_MODEL = "registered_tool";
const OVERLAY_MODEL = "facts_overlay";
const POLICY_MODEL = "policy_slice";
const CHANGE_MODEL = "authz_change";
const newId = (): string => bytesToHex(randomBytes(16));

const whereEq = (field: string, value: string): Where => ({ field, value });
const andEq = (field: string, value: string): Where => ({
	field,
	value,
	connector: "AND",
});

/** Back the three registry ports with a storage Adapter. */
export function createRegistryStores(
	adapter: Adapter,
	options: RegistryStoresOptions = {},
): RegistryStores {
	const now = options.now ?? (() => new Date().toISOString());
	const specDb = schemaAdapter(adapter, specRegistrationSchema);
	const toolDb = schemaAdapter(adapter, registeredToolSchema);
	const overlayDb = schemaAdapter(adapter, factsOverlaySchema);
	const policyDb = schemaAdapter(adapter, policySliceSchema);
	const changeDb = schemaAdapter(adapter, authzChangeSchema);

	function validateSpec(record: unknown): SpecRegistrationRecord {
		const valid = specRegistrationRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("spec registration record invalid", valid.summary);
		}
		return valid;
	}
	function validateSpecInput(input: unknown): SpecRegistrationUpsert {
		const valid = specRegistrationUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("spec registration input invalid", valid.summary);
		}
		return valid;
	}
	function validateTool(record: unknown): RegisteredToolRecord {
		const valid = registeredToolRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("registered tool record invalid", valid.summary);
		}
		return valid;
	}
	function validateToolInput(input: unknown): RegisteredToolCreate {
		const valid = registeredToolCreateSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("registered tool input invalid", valid.summary);
		}
		return valid;
	}
	function validateToolPatch(patch: unknown): RegisteredToolPatch {
		const valid = registeredToolPatchSchema(patch);
		if (valid instanceof type.errors) {
			throw validationError("registered tool patch invalid", valid.summary);
		}
		return valid;
	}
	function validateOverlay(record: unknown): FactsOverlayRecord {
		const valid = factsOverlayRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("facts overlay record invalid", valid.summary);
		}
		return valid;
	}
	function validateOverlayInput(input: unknown): FactsOverlayUpsert {
		const valid = factsOverlayUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("facts overlay input invalid", valid.summary);
		}
		return valid;
	}
	function validatePolicy(record: unknown): PolicySliceRecord {
		const valid = policySliceRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("policy slice record invalid", valid.summary);
		}
		return valid;
	}
	function validatePolicyInput(input: unknown): PolicySliceUpsert {
		const valid = policySliceUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("policy slice input invalid", valid.summary);
		}
		return valid;
	}
	function validateChange(record: unknown): AuthzChangeRecord {
		const valid = authzChangeRecordSchema(record);
		if (valid instanceof type.errors) {
			throw validationError("authz change record invalid", valid.summary);
		}
		return valid;
	}
	function validateChangeInput(input: unknown): AuthzChangeAppend {
		const valid = authzChangeAppendSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("authz change input invalid", valid.summary);
		}
		return valid;
	}

	const specRegistrations: SpecRegistrationStore = {
		async upsert(input) {
			const valid = validateSpecInput(input);
			const existing = await specDb.findOne<SpecRegistrationRecord>({
				model: SPEC_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("source", valid.source),
				],
			});
			const stamp = now();
			if (existing) {
				const prev = validateSpec(existing);
				const updated = await specDb.update<SpecRegistrationRecord>({
					model: SPEC_MODEL,
					where: [whereEq("id", prev.id)],
					update: {
						specBlob: valid.specBlob,
						contentVersion: valid.contentVersion,
						report: valid.report,
						registeredBy: valid.registeredBy,
						updatedAt: stamp,
					},
				});
				if (!updated) {
					throw stateError("spec registration vanished mid-upsert", {
						id: prev.id,
					});
				}
				return validateSpec(updated);
			}
			const record = validateSpec({
				...valid,
				id: newId(),
				createdAt: stamp,
				updatedAt: stamp,
			});
			await specDb.create({ model: SPEC_MODEL, data: record });
			return record;
		},

		async get(organizationId, source) {
			const row = await specDb.findOne<SpecRegistrationRecord>({
				model: SPEC_MODEL,
				where: [
					whereEq("organizationId", organizationId),
					andEq("source", source),
				],
			});
			return row ? validateSpec(row) : null;
		},

		async listByOrganization(organizationId) {
			const rows = await specDb.findMany<SpecRegistrationRecord>({
				model: SPEC_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
			return rows.map(validateSpec);
		},
	};

	const registeredTools: RegisteredToolStore = {
		async listBySource(organizationId, source) {
			const rows = await toolDb.findMany<RegisteredToolRecord>({
				model: TOOL_MODEL,
				where: [
					whereEq("organizationId", organizationId),
					andEq("source", source),
				],
			});
			return rows.map(validateTool);
		},

		async listByOrganization(organizationId) {
			const rows = await toolDb.findMany<RegisteredToolRecord>({
				model: TOOL_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
			return rows.map(validateTool);
		},

		async create(input) {
			// Parsed inputs carry no undefined-valued keys (the entity schemas drop them), so the
			// spread writes exactly the present fields — absent stays absent at the adapter.
			const valid = validateToolInput(input);
			const stamp = now();
			const record = validateTool({
				...valid,
				id: newId(),
				createdAt: stamp,
				updatedAt: stamp,
			});
			await toolDb.create({ model: TOOL_MODEL, data: record });
			return record;
		},

		async update(id, patch) {
			const valid = validateToolPatch(patch);
			const row = await toolDb.update<RegisteredToolRecord>({
				model: TOOL_MODEL,
				where: [whereEq("id", id)],
				// The store owns updatedAt — spread first so a caller-supplied one is overridden.
				update: { ...valid, updatedAt: now() },
			});
			return row ? validateTool(row) : null;
		},

		async deleteById(id) {
			await toolDb.delete({ model: TOOL_MODEL, where: [whereEq("id", id)] });
		},
	};

	const factsOverlay: FactsOverlayStore = {
		async listByOrganization(organizationId) {
			const rows = await overlayDb.findMany<FactsOverlayRecord>({
				model: OVERLAY_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
			return rows.map(validateOverlay);
		},

		async upsert(input) {
			const valid = validateOverlayInput(input);
			// Replace: drop any prior override for this (org, actionId), then write the new one whole.
			await overlayDb.delete({
				model: OVERLAY_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("actionId", valid.actionId),
				],
			});
			const stamp = now();
			const record = validateOverlay({
				...valid,
				id: newId(),
				createdAt: stamp,
				updatedAt: stamp,
			});
			await overlayDb.create({ model: OVERLAY_MODEL, data: record });
			await authzChanges.append({
				organizationId: valid.organizationId,
				kind: "overlay_changed",
				summary: { actionId: valid.actionId },
				by: valid.updatedBy,
			});
			return record;
		},

		async deleteById(id) {
			// Read first: the append needs the org (the router keys on its count), and a no-op delete
			// (the row is already gone) must NOT bump the count.
			const existing = await overlayDb.findOne<FactsOverlayRecord>({
				model: OVERLAY_MODEL,
				where: [whereEq("id", id)],
			});
			await overlayDb.delete({
				model: OVERLAY_MODEL,
				where: [whereEq("id", id)],
			});
			if (existing) {
				const prev = validateOverlay(existing);
				await authzChanges.append({
					organizationId: prev.organizationId,
					kind: "overlay_changed",
					// `by` is the row's last actor — deleteById(id) carries no acting principal itself.
					summary: { actionId: prev.actionId, deleted: true },
					by: prev.updatedBy,
				});
			}
		},
	};

	// The append-only authz change log. `append` stamps id + at; `count` is the cheap per-decision
	// read the org router keys on; `listByOrganization` (sorted oldest-first) is the deferred-use
	// history. There is no update or delete — a DELETE elsewhere APPENDS a change event, so the count
	// stays monotonic (sound where max(updatedAt) is not).
	const authzChanges: AuthzChangeStore = {
		async append(input) {
			const valid = validateChangeInput(input);
			const record = validateChange({ ...valid, id: newId(), at: now() });
			await changeDb.create({ model: CHANGE_MODEL, data: record });
			return record;
		},

		async count(organizationId) {
			return changeDb.count({
				model: CHANGE_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
		},

		async listByOrganization(organizationId) {
			const rows = await changeDb.findMany<AuthzChangeRecord>({
				model: CHANGE_MODEL,
				where: [whereEq("organizationId", organizationId)],
				sortBy: { field: "at", direction: "asc" },
			});
			return rows.map(validateChange);
		},
	};

	// A customer's Cedar policy slices; upsert REPLACES in place per (organizationId, name) — id +
	// createdAt preserved, updatedAt bumped (all fields required, so nothing to clear; the in-place
	// replace mirrors spec_registration). Every mutation (upsert AND delete) appends to the authz
	// change log, so the router's `count`-keyed version bumps and the edit takes effect next decision.
	const policySlices: PolicySliceStore = {
		async listByOrganization(organizationId) {
			const rows = await policyDb.findMany<PolicySliceRecord>({
				model: POLICY_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
			return rows.map(validatePolicy);
		},

		async upsert(input) {
			const valid = validatePolicyInput(input);
			const existing = await policyDb.findOne<PolicySliceRecord>({
				model: POLICY_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("name", valid.name),
				],
			});
			const stamp = now();
			let record: PolicySliceRecord;
			if (existing) {
				const prev = validatePolicy(existing);
				const updated = await policyDb.update<PolicySliceRecord>({
					model: POLICY_MODEL,
					where: [whereEq("id", prev.id)],
					// The store owns updatedAt — spread first so a caller-supplied one is overridden.
					update: {
						cedar: valid.cedar,
						mode: valid.mode,
						updatedBy: valid.updatedBy,
						updatedAt: stamp,
					},
				});
				if (!updated) {
					throw stateError("policy slice vanished mid-upsert", { id: prev.id });
				}
				record = validatePolicy(updated);
			} else {
				record = validatePolicy({
					...valid,
					id: newId(),
					createdAt: stamp,
					updatedAt: stamp,
				});
				await policyDb.create({ model: POLICY_MODEL, data: record });
			}
			// Append after the write succeeds — a failed write must never bump the router's version.
			await authzChanges.append({
				organizationId: valid.organizationId,
				kind: "policy_changed",
				summary: { slice: valid.name },
				by: valid.updatedBy,
			});
			return record;
		},

		async deleteById(id) {
			// A delete APPENDS a change event (keeping the count monotonic) — read first for the org,
			// and skip the append when the row was already gone (a no-op must not bump the count).
			const existing = await policyDb.findOne<PolicySliceRecord>({
				model: POLICY_MODEL,
				where: [whereEq("id", id)],
			});
			await policyDb.delete({
				model: POLICY_MODEL,
				where: [whereEq("id", id)],
			});
			if (existing) {
				const prev = validatePolicy(existing);
				await authzChanges.append({
					organizationId: prev.organizationId,
					kind: "policy_changed",
					// `by` is the row's last actor — deleteById(id) carries no acting principal itself.
					summary: { slice: prev.name, deleted: true },
					by: prev.updatedBy,
				});
			}
		},
	};

	return {
		specRegistrations,
		registeredTools,
		factsOverlay,
		policySlices,
		authzChanges,
	};
}
