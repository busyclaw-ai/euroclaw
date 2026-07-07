import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	secretAliasRecord,
	secretAliasSchema,
	secretAliasUpsert,
} from "../src/index";

const row = {
	id: "alias-1",
	organizationId: "org-a",
	name: "TELEGRAM_BOT_TOKEN",
	provider: "vault",
	ref: "kv/telegram/prod",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("secret_alias — the per-org pointer entity", () => {
	it("declares a pointer-only storage schema (org + name indexed, NO value column)", () => {
		const fields = secretAliasSchema.secret_alias.fields;
		expect(fields.organizationId).toMatchObject({
			required: true,
			index: true,
		});
		expect(fields.name).toMatchObject({ required: true, index: true });
		expect(fields.provider).toMatchObject({ type: "string", required: true });
		expect(fields.ref).toMatchObject({ type: "string", required: true });
		// The "stores no secrets" invariant: there is no value/token/secret column.
		expect(fields.value).toBeUndefined();
		expect(fields.token).toBeUndefined();
		expect(fields.secret).toBeUndefined();
	});

	it("id and name are immutable (half the natural key), provider/ref are mutable", () => {
		const fields = secretAliasSchema.secret_alias.fields;
		expect(fields.id.immutable).toBe(true);
		expect(fields.organizationId.immutable).toBe(true);
		expect(fields.name.immutable).toBe(true);
		expect(fields.provider.immutable).toBeUndefined();
		expect(fields.ref.immutable).toBeUndefined();
	});

	it("validates a well-formed record", () => {
		expect(secretAliasRecord(row)).toEqual(row);
	});

	it("rejects a record missing a required pointer column", () => {
		const { ref: _ref, ...noRef } = row;
		expect(secretAliasRecord(noRef)).toBeInstanceOf(type.errors);
	});

	it("upsert input omits the store-owned id/createdAt/updatedAt", () => {
		const valid = secretAliasUpsert({
			organizationId: "org-a",
			name: "GITHUB_TOKEN",
			provider: "env",
			ref: "GH_PAT",
		});
		expect(valid).toEqual({
			organizationId: "org-a",
			name: "GITHUB_TOKEN",
			provider: "env",
			ref: "GH_PAT",
		});
	});
});
