import type { Adapter, Where } from "@euroclaw/contracts";
import {
	configurationError,
	type PiiMapping,
	type PiiMappingStore,
	piiMapping as piiMappingRecord,
	piiMappingSchema,
	validationError,
} from "@euroclaw/contracts";
import { schemaAdapter } from "@euroclaw/storage-core";
import { type } from "arktype";

export type PiiMappingStoreOptions = {
	/** The table/model PII mappings live in. Default "pii_mapping". */
	model?: string;
};

function validateMapping(value: unknown): PiiMapping {
	const valid = piiMappingRecord(value);
	if (valid instanceof type.errors) {
		throw validationError("PII mapping invalid", valid.summary);
	}
	return valid;
}

function mappingWhere(
	mapping: Pick<
		PiiMapping,
		"memoryNamespace" | "placeholder" | "subjectId" | "tenantId"
	>,
): Where[] {
	const where: Where[] = [{ field: "placeholder", value: mapping.placeholder }];
	if (mapping.tenantId !== undefined) {
		where.push({
			field: "tenantId",
			value: mapping.tenantId,
			connector: "AND",
		});
	}
	if (mapping.subjectId !== undefined) {
		where.push({
			field: "subjectId",
			value: mapping.subjectId,
			connector: "AND",
		});
	}
	if (mapping.memoryNamespace !== undefined) {
		where.push({
			field: "memoryNamespace",
			value: mapping.memoryNamespace,
			connector: "AND",
		});
	}
	return where;
}

function sameScope(
	mapping: PiiMapping,
	ctx: Parameters<PiiMappingStore["resolve"]>[1],
): boolean {
	return (
		mapping.tenantId === ctx?.tenantId &&
		mapping.subjectId === ctx?.subjectId &&
		mapping.memoryNamespace === ctx?.memoryNamespace
	);
}

export function createPiiMappingStore(
	adapter: Adapter,
	options: PiiMappingStoreOptions = {},
): PiiMappingStore {
	// Persist through the schema-aware adapter (the options.model override rides modelName — the
	// engine-sql precedent). The decode normalizes SQL NULL scope columns to absent, which is what
	// the === scope comparison expects — hand-rolled reads broke on real SQL backends here.
	const table = piiMappingSchema.pii_mapping;
	if (!table) throw configurationError("pii_mapping schema missing", {});
	const db = schemaAdapter(adapter, {
		pii_mapping: { ...table, modelName: options.model ?? "pii_mapping" },
	});
	const model = "pii_mapping";
	return {
		durable: true,

		async save(mapping) {
			const valid = validateMapping(mapping);
			const existing = (
				await db.findMany<PiiMapping>({
					model,
					where: [{ field: "placeholder", value: valid.placeholder }],
				})
			)
				.map(validateMapping)
				.find((row) => sameScope(row, valid));
			if (existing) {
				await db.update({
					model,
					where: mappingWhere(valid),
					update: valid,
				});
				return;
			}
			await db.create({ model, data: valid });
		},

		async resolve(placeholder, ctx) {
			const row = (
				await db.findMany<PiiMapping>({
					model,
					where: [{ field: "placeholder", value: placeholder }],
				})
			)
				.map(validateMapping)
				.find((mapping) => sameScope(mapping, ctx));
			return row?.original ?? null;
		},

		async deleteForSubject(subjectId: string, ctx?: { tenantId?: string }) {
			const where: Where[] = [{ field: "subjectId", value: subjectId }];
			if (ctx?.tenantId !== undefined) {
				where.push({
					field: "tenantId",
					value: ctx.tenantId,
					connector: "AND",
				});
			}
			await db.deleteMany({
				model,
				where,
			});
		},
	};
}
