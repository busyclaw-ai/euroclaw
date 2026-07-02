import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	approvalSchema,
	effectRecord,
	effectSchema,
	entity,
	field,
	piiMappingSchema,
} from "../src/index";

describe("euroclaw core — entity-derived schemas", () => {
	it("derives approval/effect/PII storage schemas from entity fields", () => {
		expect(approvalSchema.approval.fields.args).toMatchObject({
			type: "json",
			required: true,
		});
		expect(effectSchema.effect.fields.leaseTokenHash).toMatchObject({
			type: "string",
			returned: false,
		});
		expect(piiMappingSchema.pii_mapping.fields.original).toMatchObject({
			type: "string",
			required: true,
			pii: "contains",
		});
	});

	it("keeps custom JSON field validation on entity records", () => {
		const invalid = effectRecord({
			id: "effect-1",
			status: "started",
			toolName: "send_email",
			inputHash: "hash",
			compensation: { args: {} },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	it("derives the update-patch schema from field flags (immutable / input:false drop out)", () => {
		const thing = entity("thing", {
			id: field.string({ required: true, unique: true, immutable: true }),
			name: field.string({ required: true }),
			tag: field.string(),
			createdAt: field.string({ required: true, immutable: true }),
			updatedAt: field.string({ required: true, input: false }),
		});
		const update = thing.updateSchema();

		// a mutable field is accepted, and every field is optional (a patch sets any subset)
		expect(update({ name: "renamed", tag: "vip" })).not.toBeInstanceOf(
			type.errors,
		);
		expect(update({})).not.toBeInstanceOf(type.errors);
		// wrong type is still rejected — it's a real validator, not a passthrough
		expect(update({ name: 123 })).toBeInstanceOf(type.errors);

		// the immutable flag flows into the storage declaration the update path enforces
		expect(thing.storage.thing.fields.id.immutable).toBe(true);
		expect(thing.storage.thing.fields.name.immutable).toBeUndefined();
	});
});
