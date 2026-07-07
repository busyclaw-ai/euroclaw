// The secrets USABILITY layer the assembly owns: collecting plugin declarations, and the boot
// validation (coverage + inline/DB duplicate). The DB-wins resolution itself lives in @euroclaw/secrets
// (buildSecrets' `aliases` option, wired in index.ts); the alias store in @euroclaw/storage-durable;
// the `claw.api.secrets` surface in api.ts. See docs/plans/secrets-per-org-aliases.md.

import type {
	EuroclawPlugin,
	SecretAliasStore,
	SecretDeclaration,
	SecretProvider,
	Secrets,
} from "@euroclaw/contracts";
import { errorMessage } from "@euroclaw/contracts";

/**
 * Collect the required-secret-name declarations across all plugins into a deduped set (first plugin
 * to declare a name keeps its description). Always-on — needs no table, runs whether or not
 * `dynamicSecretAliases` is enabled.
 */
export function collectSecretDeclarations(
	plugins: readonly EuroclawPlugin[],
): SecretDeclaration[] {
	const byName = new Map<string, SecretDeclaration>();
	for (const plugin of plugins) {
		for (const declaration of plugin.secrets ?? []) {
			if (!byName.has(declaration.name))
				byName.set(declaration.name, declaration);
		}
	}
	return [...byName.values()];
}

/** A boot warning — surfaced (never thrown): a name may still be configured later at runtime. */
export type SecretBootWarning = {
	kind: "coverage" | "duplicate" | "scan-failed";
	name: string;
	organizationId?: string;
	message: string;
};

export type ValidateSecretsAtBootInput = {
	/** The collected required-secret names (plugin declarations). */
	declarations: readonly SecretDeclaration[];
	/** The provider chain — read for the set of INLINE-aliased names (a provider's `aliases` keys). */
	providers: readonly SecretProvider[];
	/** The one-door reader — probes inline/direct resolution (`has`, no org ⇒ DB layer skipped). */
	secrets: Secrets;
	/** The alias store — present ONLY when `dynamicSecretAliases.enabled`. Drives the DB-coverage and
	 *  the inline/DB duplicate checks; a cross-org `listAll` scan (cost flagged in the store port). */
	aliasStore?: SecretAliasStore;
	/** Where warnings go. Defaults to console.warn in the assembly's fire-and-forget boot call. */
	warn?: (warning: SecretBootWarning) => void;
};

/**
 * Boot validation — warn-only, NEVER fails boot (createClaw fires it fire-and-forget). Two checks:
 *  - **coverage** (always-on): a declared name that resolves NOWHERE — no inline alias, no direct
 *    provider hit, and (when enabled) no DB alias for ANY org. "Set an alias or the env var."
 *  - **duplicate** (enabled only): a name aliased BOTH inline (a provider `aliases` map) AND in the
 *    DB — "the DB alias is used." Needs the cross-org `listAll` scan (its cost is flagged on the port).
 * A DB scan failure (e.g. the table isn't migrated) is itself a warning — boot proceeds.
 */
export async function validateSecretsAtBoot(
	input: ValidateSecretsAtBootInput,
): Promise<SecretBootWarning[]> {
	const warnings: SecretBootWarning[] = [];
	const emit = (warning: SecretBootWarning): void => {
		warnings.push(warning);
		input.warn?.(warning);
	};

	// Names aliased INLINE — the union of every provider's `aliases` keys.
	const inlineAliasNames = new Set<string>();
	for (const provider of input.providers) {
		for (const name of Object.keys(provider.aliases ?? {})) {
			inlineAliasNames.add(name);
		}
	}

	// Load the DB aliases once (enabled only). A failure here is warned, not thrown — boot proceeds
	// with an empty DB view (coverage may over-report, which is the safe direction for a warning).
	const dbRows: { name: string; organizationId: string }[] = [];
	const aliasedInDb = new Set<string>();
	if (input.aliasStore) {
		try {
			for (const row of await input.aliasStore.listAll()) {
				dbRows.push({ name: row.name, organizationId: row.organizationId });
				aliasedInDb.add(row.name);
			}
		} catch (err) {
			emit({
				kind: "scan-failed",
				name: "",
				message: `could not scan secret aliases for boot validation — ${errorMessage(err)}`,
			});
		}
	}

	// coverage — walk the deduped declared names.
	const seenName = new Set<string>();
	for (const declaration of input.declarations) {
		if (seenName.has(declaration.name)) continue;
		seenName.add(declaration.name);
		const covered =
			(await input.secrets.has(declaration.name)) ||
			aliasedInDb.has(declaration.name);
		if (!covered) {
			emit({
				kind: "coverage",
				name: declaration.name,
				message: `secret "${declaration.name}" is unresolvable — no inline alias, no provider value${input.aliasStore ? ", and no DB alias" : ""}. Set an alias or the env var.`,
			});
		}
	}

	// duplicate — a DB alias whose name is ALSO aliased inline. The DB one wins at resolution.
	for (const row of dbRows) {
		if (inlineAliasNames.has(row.name)) {
			emit({
				kind: "duplicate",
				name: row.name,
				organizationId: row.organizationId,
				message: `secret "${row.name}" is aliased inline and in the DB for org "${row.organizationId}" — the DB alias is used.`,
			});
		}
	}

	return warnings;
}
