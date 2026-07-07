// The DB-wins alias layer of buildSecrets (the opt-in `{ aliases }` option). Layer 0 (per-org DB
// pointer) WINS over the inline chain; absent org OR absent alias falls through to the existing
// behaviour, so buildSecrets stays back-compatible. See docs/plans/secrets-per-org-aliases.md.

import type { SecretAliasPointer } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { buildSecrets, env, type SecretAliasLookup } from "../src/index";

/** An in-memory alias table keyed `org/name` → pointer, exposed as a SecretAliasLookup. */
function aliasLookup(
	table: Record<string, SecretAliasPointer>,
): SecretAliasLookup {
	return async (organizationId, name) =>
		table[`${organizationId}/${name}`] ?? null;
}

describe("buildSecrets — the per-org DB-alias layer", () => {
	it("a per-org DB alias WINS over the inline chain", async () => {
		const secrets = buildSecrets(
			[
				env({
					source: { INLINE_KEY: "from-inline", VAULT_KEY: "from-vault" },
					aliases: { TELEGRAM_BOT_TOKEN: "INLINE_KEY" },
				}),
			],
			{
				aliases: aliasLookup({
					"org-a/TELEGRAM_BOT_TOKEN": { provider: "env", ref: "VAULT_KEY" },
				}),
			},
		);
		// org-a has a DB alias → routes to env's VAULT_KEY, not the inline INLINE_KEY.
		expect(
			await secrets.get("TELEGRAM_BOT_TOKEN", { organizationId: "org-a" }),
		).toEqual({
			kind: "token",
			value: "from-vault",
		});
	});

	it("skips the DB layer when no org is in context (deployment default only)", async () => {
		const secrets = buildSecrets(
			[
				env({
					source: { INLINE_KEY: "from-inline" },
					aliases: { NAME: "INLINE_KEY" },
				}),
			],
			{
				aliases: aliasLookup({
					"org-a/NAME": { provider: "env", ref: "NOPE" },
				}),
			},
		);
		// No org ⇒ layer 0 skipped ⇒ inline alias resolves.
		expect(await secrets.get("NAME")).toEqual({
			kind: "token",
			value: "from-inline",
		});
	});

	it("falls through to the inline chain when the org has no alias for the name", async () => {
		const secrets = buildSecrets(
			[env({ source: { DIRECT: "direct-value" } })],
			{
				aliases: aliasLookup({ "org-a/OTHER": { provider: "env", ref: "X" } }),
			},
		);
		// org-a has an alias for OTHER, not for DIRECT → DIRECT resolves directly.
		expect(await secrets.get("DIRECT", { organizationId: "org-a" })).toEqual({
			kind: "token",
			value: "direct-value",
		});
	});

	it("routes through the pointer's ref verbatim — the provider's own alias remap does NOT apply", async () => {
		const secrets = buildSecrets(
			[
				env({
					source: { BACKEND: "the-value" },
					// This inline remap must be IGNORED for a DB-alias resolution (ref is already the key).
					aliases: { BACKEND: "SOMEWHERE_ELSE" },
				}),
			],
			{
				aliases: aliasLookup({
					"org-a/CANON": { provider: "env", ref: "BACKEND" },
				}),
			},
		);
		expect(await secrets.get("CANON", { organizationId: "org-a" })).toEqual({
			kind: "token",
			value: "the-value",
		});
	});

	it("a dangling pointer (provider not in the chain) resolves to null — never another provider", async () => {
		const secrets = buildSecrets(
			[env({ name: "env", source: { CANON: "would-be-wrong" } })],
			{
				aliases: aliasLookup({
					"org-a/CANON": { provider: "vault", ref: "CANON" },
				}),
			},
		);
		// The alias points at "vault", which isn't configured → null (caller fails loud), and we do NOT
		// silently fall through to env's direct CANON value.
		expect(await secrets.get("CANON", { organizationId: "org-a" })).toBeNull();
	});

	it("propagates a lookup failure LOUD — never falls through to inline/direct", async () => {
		const boom = new Error("no such table: secret_alias");
		const secrets = buildSecrets([env({ source: { CANON: "direct-value" } })], {
			aliases: async () => {
				throw boom;
			},
		});
		await expect(
			secrets.get("CANON", { organizationId: "org-a" }),
		).rejects.toBe(boom);
	});
});
