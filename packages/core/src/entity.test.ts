import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	approvalSchema,
	effectRecord,
	effectSchema,
	piiMappingSchema,
} from "./index";

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
});
