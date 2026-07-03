import { validationError } from "@euroclaw/contracts";
import { type as ark } from "arktype";
import { skillManifestLimits } from "../core";
import type { SkillManifest } from "./contracts";
import { isReservedToolName } from "./reserved";
import { skillManifest, skillManifests } from "./schema";

// The manifest's length/non-empty/dedup/id-format/unknown-key constraints now live in the
// `skillManifest` arktype schema (../core) — the single source of truth. The only rule
// the schema can't express is behavioural: a skill may not declare a reserved `euroclaw__` tool name
// (those are governance meta-tools, exempt from the allowed-tools gate). That check stays here.
export { skillManifestLimits };

function assertNoReservedTool(values: readonly string[] | undefined): void {
	for (const toolName of values ?? []) {
		if (isReservedToolName(toolName)) {
			throw validationError(
				"skill manifest allowedTools",
				`reserved tool name "${toolName}" cannot be declared as an allowed tool`,
			);
		}
	}
}

export function assertSkillManifest(input: unknown): SkillManifest {
	// The schema enforces every mechanical constraint (id format, lengths, dedup, bounds,
	// unknown-key rejection). Parse once, then apply the one behavioural rule it can't express.
	const valid = skillManifest(input);
	if (valid instanceof ark.errors) {
		throw validationError("skill manifest invalid", valid.summary);
	}
	assertNoReservedTool(valid.allowedTools);
	return valid;
}

export function assertSkillManifests(input: unknown): SkillManifest[] {
	const valid = skillManifests(input);
	if (valid instanceof ark.errors) {
		throw validationError("skill manifests invalid", valid.summary);
	}
	return valid.map(assertSkillManifest);
}

export function defineSkill<const Manifest extends SkillManifest>(
	manifest: Manifest,
): Manifest {
	// Validate for effect, hand back the caller's own literal — the schemas are pure constraints
	// (no morphs), so the validated value IS the input and no cast is needed to keep the const type.
	assertSkillManifest(manifest);
	return manifest;
}

export function defineSkills<const Manifests extends readonly SkillManifest[]>(
	manifests: Manifests,
): Manifests {
	assertSkillManifests(manifests);
	return manifests;
}
