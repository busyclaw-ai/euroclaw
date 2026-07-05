export { skillManifest, skillManifests } from "../core";

import { type } from "arktype";
import { nonEmptyString, skillManifest } from "../core";

// Identity fields (ids, organizationId, actor refs) must be non-empty — enforced at the schema so the
// API layer parses instead of re-checking each field with assertNonEmptyString.
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");
const sourceEnum =
	"'user' | 'channel' | 'runtime' | 'cron' | 'default' | undefined";

export const activeSkillIdRef = nonEmptyString;
export const activeSkillInstallationRef = type({
	installationId: nonEmptyString,
});
export const activeSkillOrganizationRef = type({
	skillId: nonEmptyString,
	organizationId: nonEmptyString,
});
export const activeSkillRef = activeSkillIdRef
	.or(activeSkillInstallationRef)
	.or(activeSkillOrganizationRef);
export const activeSkillRefs = activeSkillRef.array();

export const activeSkillResolution = type({
	status: "'ok'",
	manifest: skillManifest,
	ref: activeSkillRef,
})
	.or({ status: "'missing'", ref: activeSkillRef })
	.or({ status: "'organization_required'", ref: activeSkillRef })
	.or({ status: "'forbidden'", ref: activeSkillRef })
	.or({ status: "'unavailable'", ref: activeSkillRef });

export const activateSkillInput = type({
	clawId: nes,
	installationId: nes,
	"runId?": optionalNes,
	"source?": sourceEnum,
	"threadId?": optionalNes,
});

export const activateSkillContext = type({
	activatedBy: nes,
	"teamId?": optionalNes,
	organizationId: nes,
});

export const readSkillContext = type({
	readBy: nes,
	"teamId?": optionalNes,
	organizationId: nes,
});

export const readSkillInput = type({
	"clawId?": optionalNes,
	"id?": optionalNes,
	"installationId?": optionalNes,
	"runId?": optionalNes,
	"skillId?": optionalNes,
	"source?": sourceEnum,
	"organizationId?": optionalNes,
	"threadId?": optionalNes,
}).narrow((value, ctx) => {
	// Exactly one of id / installationId / skillId identifies the skill to read.
	const refs = [value.id, value.installationId, value.skillId].filter(
		(ref) => ref !== undefined,
	);
	return (
		refs.length === 1 ||
		ctx.reject("exactly one of id, installationId, or skillId")
	);
});
