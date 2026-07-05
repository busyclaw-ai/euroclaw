import { type } from "arktype";
import {
	nonEmptyString,
	skillAclRecord,
	skillInstallationRecord,
	skillInstallationStatus,
	skillInstallationVisibility,
	skillManifest,
	skillPackageRecord,
	skillPackageSource,
	skillReadRecord,
} from "../core";

const stringArray = type("string").array();
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");

export const readSkillResult = type({
	id: "string",
	kind: "'static'",
	manifest: skillManifest,
	"read?": skillReadRecord.or("undefined"),
}).or({
	id: "string",
	installation: skillInstallationRecord,
	kind: "'installed'",
	manifest: skillManifest,
	package: skillPackageRecord,
	read: skillReadRecord,
});

export const createPersonalSkillInput = type({
	digest: nes,
	manifest: skillManifest,
	ownerActorId: nes,
	packageId: nes,
	"source?": "'local' | 'upload' | undefined",
	organizationId: nes,
	version: nes,
});

export const createPersonalSkillResult = type({
	grant: skillAclRecord,
	installation: skillInstallationRecord,
	package: skillPackageRecord,
	readGrant: skillAclRecord,
});

export const skillCatalogInput = type({
	"includeStatic?": "boolean | undefined",
	"publisher?": optionalNes,
	"source?": skillPackageSource.or("undefined"),
	"status?": skillInstallationStatus.or("undefined"),
	"organizationId?": optionalNes,
	"visibility?": skillInstallationVisibility.or("undefined"),
});

export const skillCatalogEntry = type({
	allowedTools: stringArray,
	description: "string",
	"digest?": "string | undefined",
	id: "string",
	kind: "'static' | 'installed'",
	"name?": "string | undefined",
	"packageId?": "string | undefined",
	"publisher?": "string | undefined",
	"source?": skillPackageSource.or("undefined"),
	"installationId?": "string | undefined",
	"status?": skillInstallationStatus.or("undefined"),
	"organizationId?": "string | undefined",
	"version?": "string | undefined",
	"visibility?": skillInstallationVisibility.or("undefined"),
});
