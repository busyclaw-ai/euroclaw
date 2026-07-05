import { validationError } from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type { ActiveSkillRef, ActiveSkillSelection } from "./contracts";
import {
	activeSkillIdRef,
	activeSkillInstallationRef,
	activeSkillOrganizationRef,
	activeSkillRefs,
} from "./schema";

type ActiveSkillInstallationRef = typeof activeSkillInstallationRef.infer;
type ActiveSkillOrganizationRef = typeof activeSkillOrganizationRef.infer;

export function parseInstallationRef(
	value: ActiveSkillRef,
): ActiveSkillInstallationRef | null {
	const valid = activeSkillInstallationRef(value) as
		| ActiveSkillInstallationRef
		| ark.errors;
	return valid instanceof ark.errors ? null : valid;
}

export function parseOrganizationRef(
	value: ActiveSkillRef,
): ActiveSkillOrganizationRef | null {
	const valid = activeSkillOrganizationRef(value) as
		| ActiveSkillOrganizationRef
		| ark.errors;
	return valid instanceof ark.errors ? null : valid;
}

// The ref schemas enforce non-empty fields; this just identifies which ref shape was given.
function assertActiveSkillRefContent(ref: ActiveSkillRef): ActiveSkillRef {
	if (typeof ref === "string") {
		const valid = activeSkillIdRef(ref);
		if (valid instanceof ark.errors) {
			throw validationError("active skill id invalid", valid.summary);
		}
		return valid;
	}
	const installationRef = parseInstallationRef(ref);
	if (installationRef) return installationRef;
	const organizationRef = parseOrganizationRef(ref);
	if (organizationRef) return organizationRef;
	throw validationError(
		"active skill ref invalid",
		"unrecognized active skill ref",
	);
}

export function parseActiveSkillSelection(
	selection: ActiveSkillSelection,
	allStaticSkillIds: readonly string[],
): ActiveSkillRef[] {
	if (selection === undefined || selection === "recorded") return [];
	if (selection === "all") return [...allStaticSkillIds];
	const valid = activeSkillRefs([...selection]) as
		| ActiveSkillRef[]
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("active skill refs invalid", valid.summary);
	}
	return uniqueActiveSkillRefs(valid.map(assertActiveSkillRefContent));
}

function uniqueActiveSkillRefs(
	input: readonly ActiveSkillRef[],
): ActiveSkillRef[] {
	const out: ActiveSkillRef[] = [];
	const seen = new Set<string>();
	for (const ref of input) {
		const installationRef = parseInstallationRef(ref);
		const organizationRef = parseOrganizationRef(ref);
		const key =
			typeof ref === "string"
				? `id:${ref}`
				: installationRef
					? `installation:${installationRef.installationId}`
					: organizationRef
						? `organization:${organizationRef.organizationId}:skill:${organizationRef.skillId}`
						: "invalid";
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

export function refLabel(ref: ActiveSkillRef): string {
	const installationRef = parseInstallationRef(ref);
	const organizationRef = parseOrganizationRef(ref);
	return typeof ref === "string"
		? ref
		: installationRef
			? installationRef.installationId
			: organizationRef
				? `${organizationRef.organizationId}:${organizationRef.skillId}`
				: "unknown";
}
