export { skillInstallationVisibility } from "../core";

import { type } from "arktype";
import {
	nonEmptyString,
	skillAclRecord,
	skillInstallationVisibility,
	skillProposalRecord,
} from "../core";

// Identity fields (ids, organizationId, actor refs) must be non-empty — enforced at the schema so the
// API layer parses instead of re-checking each field with assertNonEmptyString.
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");

export const installSkillInput = type({
	"digest?": optionalNes,
	"initialStatus?": "'installed' | 'quarantined' | undefined",
	"ownerActorId?": optionalNes,
	packageId: nes,
	"teamId?": optionalNes,
	organizationId: nes,
	"version?": optionalNes,
	"visibility?": skillInstallationVisibility.or("undefined"),
}).narrow(
	(value, ctx) =>
		value.version !== undefined ||
		value.digest !== undefined ||
		ctx.reject("version or digest"),
);

export const trustSkillInstallationInput = type({
	installationId: nes,
	organizationId: nes,
	trustedBy: nes,
});

export const enableSkillInstallationInput = type({
	enabledBy: nes,
	installationId: nes,
	organizationId: nes,
});

// public grants carry no principalId; every other principal type requires a non-empty one.
const grantPrincipal = type({
	principalType: "'public'",
	"principalId?": "undefined",
}).or({
	principalType: "'actor' | 'team' | 'organization'",
	principalId: nes,
});

export const grantActivationInput = type({
	installationId: nes,
	organizationId: nes,
}).and(grantPrincipal);

export const requestShareInput = type({
	installationId: nes,
	"reason?": optionalNes,
	requestedBy: nes,
	organizationId: nes,
}).and(grantPrincipal);

export const shareSkillInput = type({
	"approvedBy?": optionalNes,
	installationId: nes,
	"reason?": optionalNes,
	requestedBy: nes,
	organizationId: nes,
}).and(grantPrincipal);

export const shareSkillResult = type({
	grant: skillAclRecord,
	status: "'granted'",
}).or({
	proposal: skillProposalRecord,
	status: "'proposed'",
});
