// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` produced the
// intended compile-time error — createClaw's dynamicSecretAliases → database requirement is enforced
// in the type system (RequireDatabaseForDynamicSecretAliases), the compile-time half of the
// enabled-but-no-database validation (docs/plans/secrets-per-org-aliases.md).
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, test } from "vitest";
import { createClaw, type RuntimeConfig } from "../src/index";

declare const model: RuntimeConfig["model"];

describe("createClaw dynamicSecretAliases database requirement", () => {
	test("enabling without a database is a compile error", () => {
		// @ts-expect-error — dynamicSecretAliases.enabled requires a database
		createClaw({ model, dynamicSecretAliases: { enabled: true } });
	});

	test("enabling WITH a database type-checks", () => {
		createClaw({
			model,
			database: memoryAdapter(),
			dynamicSecretAliases: { enabled: true },
		});
	});

	test("disabled — or absent — needs no database", () => {
		createClaw({ model, dynamicSecretAliases: { enabled: false } });
		createClaw({ model });
	});
});
