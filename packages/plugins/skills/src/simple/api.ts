import {
	ACTOR_CONTEXT_KEY,
	configurationError,
	TEAM_CONTEXT_KEY,
	TENANT_CONTEXT_KEY,
	type TurnContext,
	validationError,
} from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type {
	ActivateSkillContext,
	ActivateSkillInput,
	ReadSkillContext,
	ReadSkillInput,
	SkillManifest,
	SkillsApiOptions,
} from "../common/contracts";
import { hasActivationGrant, hasReadGrant } from "../common/grants";
import { assertSkillManifest } from "../common/manifest";
import { requireSkillsStore } from "../common/plugin";
import {
	packageAndManifestForInstallation,
	statusAllowsActivation,
} from "../common/resolution";
import {
	activateSkillContext,
	activateSkillInput,
	readSkillContext,
	readSkillInput,
} from "../common/schema";
import type {
	SkillInstallationRecord,
	SkillReadRecord,
	SkillsStore,
} from "../core";
import type {
	CreatePersonalSkillInput,
	CreatePersonalSkillResult,
	ReadSkillResult,
	SimpleSkillsApi,
	SkillCatalogEntry,
	SkillCatalogInput,
} from "./contracts";
import {
	createPersonalSkillInput,
	createPersonalSkillResult,
	readSkillResult,
	skillCatalogEntry,
	skillCatalogInput,
} from "./schema";

function assertCreatePersonalSkillInput(
	input: unknown,
): CreatePersonalSkillInput {
	const valid = createPersonalSkillInput(input) as
		| CreatePersonalSkillInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("create personal skill input invalid", valid.summary);
	}
	return { ...valid, manifest: assertSkillManifest(valid.manifest) };
}

function assertCreatePersonalSkillResult(
	input: unknown,
): CreatePersonalSkillResult {
	const valid = createPersonalSkillResult(input) as
		| CreatePersonalSkillResult
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError(
			"create personal skill result invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertSkillCatalogInput(input: unknown): SkillCatalogInput {
	const valid = skillCatalogInput(input ?? {}) as
		| SkillCatalogInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("skill catalog input invalid", valid.summary);
	}
	return valid;
}

function assertSkillCatalogEntry(input: unknown): SkillCatalogEntry {
	const valid = skillCatalogEntry(input);
	if (valid instanceof ark.errors) {
		throw validationError("skill catalog entry invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillInput(input: unknown): ReadSkillInput {
	const valid = readSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill input invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillContext(input: unknown): ReadSkillContext {
	const valid = readSkillContext(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill context invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillResult(input: unknown): ReadSkillResult {
	const valid = readSkillResult(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill result invalid", valid.summary);
	}
	return valid;
}

function staticCatalogEntry(manifest: SkillManifest): SkillCatalogEntry {
	return assertSkillCatalogEntry({
		allowedTools: manifest.allowedTools ?? [],
		description: manifest.description,
		id: manifest.id,
		kind: "static",
		name: manifest.name,
	});
}

function assertActivateSkillInput(input: unknown): ActivateSkillInput {
	const valid = activateSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("activate skill input invalid", valid.summary);
	}
	return valid;
}

function assertActivateSkillContext(input: unknown): ActivateSkillContext {
	const valid = activateSkillContext(input) as
		| ActivateSkillContext
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("activate skill context invalid", valid.summary);
	}
	return valid;
}

async function resolveActivateSkillContext(input: {
	activation: ActivateSkillInput;
	resolver: SkillsApiOptions["activationContext"];
}): Promise<ActivateSkillContext> {
	if (!input.resolver) {
		throw configurationError(
			"claw.api.skills.activate requires activationContext",
			{
				reason:
					"pass activationContext to createSimpleSkillsApi or skillsPlugin so skill authorization uses trusted principal data",
			},
		);
	}
	const value =
		typeof input.resolver === "function"
			? await input.resolver(input.activation)
			: input.resolver;
	return assertActivateSkillContext(value);
}

async function resolveReadSkillContext(input: {
	read: ReadSkillInput;
	resolver: SkillsApiOptions["readContext"];
}): Promise<ReadSkillContext> {
	if (!input.resolver) {
		throw configurationError("claw.api.skills.read requires readContext", {
			reason:
				"pass readContext to createSimpleSkillsApi or skillsPlugin so skill reads use trusted principal data",
		});
	}
	const value =
		typeof input.resolver === "function"
			? await input.resolver(input.read)
			: input.resolver;
	return assertReadSkillContext(value);
}

function activationTurnContext(input: ActivateSkillContext): TurnContext {
	return {
		[ACTOR_CONTEXT_KEY]: input.activatedBy,
		...(input.teamId !== undefined ? { [TEAM_CONTEXT_KEY]: input.teamId } : {}),
		[TENANT_CONTEXT_KEY]: input.tenantId,
	};
}

function readTurnContext(input: ReadSkillContext): TurnContext {
	return {
		[ACTOR_CONTEXT_KEY]: input.readBy,
		...(input.teamId !== undefined ? { [TEAM_CONTEXT_KEY]: input.teamId } : {}),
		[TENANT_CONTEXT_KEY]: input.tenantId,
	};
}

async function assertActivatableInstallation(input: {
	activation: ActivateSkillInput;
	activationContext: ActivateSkillContext;
	store: SkillsStore;
}): Promise<{
	installation: SkillInstallationRecord;
	manifest: ReturnType<typeof assertSkillManifest>;
}> {
	const installation = await input.store.installations.get(
		input.activation.installationId,
	);
	if (
		!installation ||
		installation.tenantId !== input.activationContext.tenantId
	) {
		throw validationError(
			"activate skill input invalid",
			"installation not found",
		);
	}
	if (!statusAllowsActivation(installation)) {
		throw validationError(
			"activate skill input invalid",
			"installation is not enabled or trusted",
		);
	}
	const resolved = await packageAndManifestForInstallation({
		installation,
		store: input.store,
	});
	if (!resolved) {
		throw validationError(
			"activate skill input invalid",
			"skill package not found for installation",
		);
	}
	if (
		!(await hasActivationGrant({
			ctx: activationTurnContext(input.activationContext),
			installation,
			store: input.store,
		}))
	) {
		throw validationError(
			"activate skill input invalid",
			"actor cannot activate this skill",
		);
	}
	return { installation, manifest: resolved.manifest };
}

export async function createReadRecord(input: {
	digest?: string;
	installationId?: string;
	packageId?: string;
	read: ReadSkillInput;
	readBy: string;
	skillId: string;
	store: SkillsStore;
	tenantId: string;
	version?: string;
}): Promise<SkillReadRecord> {
	return input.store.reads.create({
		clawId: input.read.clawId,
		digest: input.digest,
		installationId: input.installationId,
		packageId: input.packageId,
		readBy: input.readBy,
		runId: input.read.runId,
		skillId: input.skillId,
		source: input.read.source ?? "user",
		tenantId: input.tenantId,
		threadId: input.read.threadId,
		version: input.version,
	});
}

async function readInstalledSkill(input: {
	installation: SkillInstallationRecord;
	read: ReadSkillInput;
	readContext: ReadSkillContext;
	store: SkillsStore;
}): Promise<ReadSkillResult> {
	if (input.installation.tenantId !== input.readContext.tenantId) {
		throw validationError("read skill input invalid", "installation not found");
	}
	if (!statusAllowsActivation(input.installation)) {
		throw validationError(
			"read skill input invalid",
			"installation is not enabled or trusted",
		);
	}
	const resolved = await packageAndManifestForInstallation({
		installation: input.installation,
		store: input.store,
	});
	if (!resolved) {
		throw validationError(
			"read skill input invalid",
			"skill package not found for installation",
		);
	}
	if (
		!(await hasReadGrant({
			ctx: readTurnContext(input.readContext),
			installation: input.installation,
			store: input.store,
		}))
	) {
		throw validationError(
			"read skill input invalid",
			"actor cannot read this skill",
		);
	}
	const read = await createReadRecord({
		digest: resolved.pkg.digest,
		installationId: input.installation.id,
		packageId: resolved.pkg.packageId,
		read: input.read,
		readBy: input.readContext.readBy,
		skillId: resolved.manifest.id,
		store: input.store,
		tenantId: input.installation.tenantId,
		version: resolved.pkg.version,
	});
	return assertReadSkillResult({
		id: resolved.manifest.id,
		installation: input.installation,
		kind: "installed",
		manifest: resolved.manifest,
		package: resolved.pkg,
		read,
	});
}

async function readInstalledSkillById(input: {
	read: ReadSkillInput;
	readContext: ReadSkillContext;
	store: SkillsStore;
}): Promise<ReadSkillResult> {
	if (
		input.read.tenantId !== undefined &&
		input.read.tenantId !== input.readContext.tenantId
	) {
		throw validationError("read skill input invalid", "tenant mismatch");
	}
	if (input.read.installationId !== undefined) {
		const installation = await input.store.installations.get(
			input.read.installationId,
		);
		if (!installation) {
			throw validationError(
				"read skill input invalid",
				"installation not found",
			);
		}
		return readInstalledSkill({
			installation,
			read: input.read,
			readContext: input.readContext,
			store: input.store,
		});
	}
	const skillId = input.read.skillId ?? input.read.id;
	if (skillId === undefined) {
		throw validationError("read skill input invalid", "skill id is required");
	}
	let sawMatchingSkill = false;
	for (const status of ["enabled", "trusted"] as const) {
		const installations = await input.store.installations.listForTenant({
			status,
			tenantId: input.readContext.tenantId,
		});
		for (const installation of installations) {
			const resolved = await packageAndManifestForInstallation({
				installation,
				store: input.store,
			});
			if (!resolved || resolved.manifest.id !== skillId) continue;
			sawMatchingSkill = true;
			if (
				await hasReadGrant({
					ctx: readTurnContext(input.readContext),
					installation,
					store: input.store,
				})
			) {
				const read = await createReadRecord({
					digest: resolved.pkg.digest,
					installationId: installation.id,
					packageId: resolved.pkg.packageId,
					read: input.read,
					readBy: input.readContext.readBy,
					skillId: resolved.manifest.id,
					store: input.store,
					tenantId: installation.tenantId,
					version: resolved.pkg.version,
				});
				return assertReadSkillResult({
					id: resolved.manifest.id,
					installation,
					kind: "installed",
					manifest: resolved.manifest,
					package: resolved.pkg,
					read,
				});
			}
		}
	}
	throw validationError(
		"read skill input invalid",
		sawMatchingSkill ? "actor cannot read this skill" : "skill not found",
	);
}

async function installedCatalogEntries(input: {
	catalog: SkillCatalogInput;
	store: SkillsStore | undefined;
}): Promise<SkillCatalogEntry[]> {
	if (!input.store || input.catalog.tenantId === undefined) return [];
	const installations = await input.store.installations.listForTenant({
		status: input.catalog.status,
		tenantId: input.catalog.tenantId,
		visibility: input.catalog.visibility,
	});
	const out: SkillCatalogEntry[] = [];
	for (const installation of installations) {
		const resolved = await packageAndManifestForInstallation({
			installation,
			store: input.store,
		});
		if (!resolved) continue;
		if (
			input.catalog.source !== undefined &&
			resolved.pkg.source !== input.catalog.source
		) {
			continue;
		}
		if (
			input.catalog.publisher !== undefined &&
			resolved.pkg.publisher !== input.catalog.publisher
		) {
			continue;
		}
		out.push(
			assertSkillCatalogEntry({
				allowedTools: resolved.manifest.allowedTools ?? [],
				description: resolved.manifest.description,
				digest: resolved.pkg.digest,
				id: resolved.manifest.id,
				installationId: installation.id,
				kind: "installed",
				name: resolved.manifest.name,
				packageId: resolved.pkg.packageId,
				publisher: resolved.pkg.publisher,
				source: resolved.pkg.source,
				status: installation.status,
				tenantId: installation.tenantId,
				version: resolved.pkg.version,
				visibility: installation.visibility,
			}),
		);
	}
	return out;
}

export function createSimpleSkillsApi(
	store: SkillsStore | undefined,
	options: SkillsApiOptions = {},
): SimpleSkillsApi {
	const resolvedStore = () => requireSkillsStore(store);
	return {
		async catalog(input) {
			const catalog = assertSkillCatalogInput(input);
			const staticEntries =
				catalog.includeStatic === false
					? []
					: (options.staticSkills ?? []).map(staticCatalogEntry);
			return [
				...staticEntries,
				...(await installedCatalogEntries({ catalog, store })),
			];
		},
		async read(input) {
			const read = assertReadSkillInput(input);
			if (read.id !== undefined) {
				const staticManifest = options.staticSkills?.find(
					(skill) => skill.id === read.id,
				);
				if (staticManifest) {
					let record: SkillReadRecord | undefined;
					if (store && options.readContext) {
						const readContext = await resolveReadSkillContext({
							read,
							resolver: options.readContext,
						});
						record = await createReadRecord({
							read,
							readBy: readContext.readBy,
							skillId: staticManifest.id,
							store,
							tenantId: readContext.tenantId,
						});
					}
					return assertReadSkillResult({
						id: staticManifest.id,
						kind: "static",
						manifest: staticManifest,
						read: record,
					});
				}
			}
			const readContext = await resolveReadSkillContext({
				read,
				resolver: options.readContext,
			});
			return readInstalledSkillById({
				read,
				readContext,
				store: resolvedStore(),
			});
		},
		async createPersonal(input) {
			const valid = assertCreatePersonalSkillInput(input);
			const pkg = await resolvedStore().packages.create({
				digest: valid.digest,
				manifest: valid.manifest,
				packageId: valid.packageId,
				publisher: valid.ownerActorId,
				source: valid.source ?? "local",
				version: valid.version,
			});
			const installation = await resolvedStore().installations.create({
				digest: pkg.digest,
				enabledBy: valid.ownerActorId,
				ownerActorId: valid.ownerActorId,
				packageId: pkg.packageId,
				status: "enabled",
				tenantId: valid.tenantId,
				version: pkg.version,
				visibility: "private",
			});
			const grant = await resolvedStore().acl.grant({
				installationId: installation.id,
				permission: "activate",
				principalId: valid.ownerActorId,
				principalType: "actor",
				tenantId: valid.tenantId,
			});
			const readGrant = await resolvedStore().acl.grant({
				installationId: installation.id,
				permission: "read",
				principalId: valid.ownerActorId,
				principalType: "actor",
				tenantId: valid.tenantId,
			});
			return assertCreatePersonalSkillResult({
				grant,
				installation,
				package: pkg,
				readGrant,
			});
		},
		async activate(input) {
			const valid = assertActivateSkillInput(input);
			const activationContext = await resolveActivateSkillContext({
				activation: valid,
				resolver: options.activationContext,
			});
			const { installation, manifest } = await assertActivatableInstallation({
				activationContext,
				activation: valid,
				store: resolvedStore(),
			});
			return resolvedStore().activations.create({
				activatedBy: activationContext.activatedBy,
				clawId: valid.clawId,
				digest: installation.digest,
				installationId: installation.id,
				runId: valid.runId,
				skillId: manifest.id,
				source: valid.source ?? "user",
				tenantId: activationContext.tenantId,
				threadId: valid.threadId,
			});
		},
	};
}
