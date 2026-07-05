import {
	CLAW_ID_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	THREAD_ID_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/contracts";
import type {
	SkillActivationRecord,
	SkillInstallationRecord,
	SkillPackageRecord,
	SkillsStore,
} from "../core";
import type { ActiveSkillRef, SkillManifest } from "./contracts";
import { hasActivationGrant } from "./grants";
import { assertSkillManifest } from "./manifest";
import { parseInstallationRef, parseOrganizationRef } from "./refs";
import type { activeSkillResolution } from "./schema";

type ActiveSkillResolution = typeof activeSkillResolution.infer;

export function contextString(
	ctx: TurnContext,
	key: string,
): string | undefined {
	const value = ctx[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function statusAllowsActivation(
	installation: SkillInstallationRecord,
): boolean {
	return installation.status === "enabled" || installation.status === "trusted";
}

function packageMatchesInstallation(
	pkg: SkillPackageRecord,
	installation: SkillInstallationRecord,
): boolean {
	return (
		pkg.packageId === installation.packageId &&
		pkg.version === installation.version &&
		pkg.digest === installation.digest
	);
}

async function packageForInstallation(input: {
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<SkillPackageRecord | null> {
	const byDigest = await input.store.packages.getByDigest(
		input.installation.digest,
	);
	if (byDigest && packageMatchesInstallation(byDigest, input.installation)) {
		return byDigest;
	}
	const byVersion = await input.store.packages.getByPackageVersion({
		packageId: input.installation.packageId,
		version: input.installation.version,
	});
	return byVersion && packageMatchesInstallation(byVersion, input.installation)
		? byVersion
		: null;
}

function manifestFromPackage(pkg: SkillPackageRecord): SkillManifest {
	return assertSkillManifest(pkg.manifest);
}

export async function packageAndManifestForInstallation(input: {
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<{ manifest: SkillManifest; pkg: SkillPackageRecord } | null> {
	const pkg = await packageForInstallation(input);
	if (!pkg) return null;
	return { manifest: manifestFromPackage(pkg), pkg };
}

async function resolveStoredSkillByInstallation(input: {
	ctx: TurnContext;
	installationId: string;
	ref: ActiveSkillRef;
	store: SkillsStore;
	organizationId: string | undefined;
}): Promise<ActiveSkillResolution> {
	const installation = await input.store.installations.get(
		input.installationId,
	);
	if (!installation) return { status: "missing", ref: input.ref };
	if (
		input.organizationId === undefined ||
		installation.organizationId !== input.organizationId
	) {
		return { status: "organization_required", ref: input.ref };
	}
	if (!statusAllowsActivation(installation)) {
		return { status: "unavailable", ref: input.ref };
	}
	if (
		!(await hasActivationGrant({
			ctx: input.ctx,
			installation,
			store: input.store,
		}))
	) {
		return { status: "forbidden", ref: input.ref };
	}
	const pkg = await packageForInstallation({
		installation,
		store: input.store,
	});
	if (!pkg) return { status: "missing", ref: input.ref };
	return { status: "ok", manifest: manifestFromPackage(pkg), ref: input.ref };
}

async function resolveStoredSkillByOrganizationRef(input: {
	ctx: TurnContext;
	ref: { skillId: string; organizationId: string };
	store: SkillsStore;
}): Promise<ActiveSkillResolution> {
	let forbidden = false;
	const trusted = await input.store.installations.listForOrganization({
		status: "trusted",
		organizationId: input.ref.organizationId,
	});
	const enabled = await input.store.installations.listForOrganization({
		status: "enabled",
		organizationId: input.ref.organizationId,
	});
	for (const installation of [...enabled, ...trusted]) {
		const pkg = await packageForInstallation({
			installation,
			store: input.store,
		});
		if (!pkg) continue;
		const manifest = manifestFromPackage(pkg);
		if (manifest.id === input.ref.skillId) {
			if (
				await hasActivationGrant({
					ctx: input.ctx,
					installation,
					store: input.store,
				})
			) {
				return { status: "ok", manifest, ref: input.ref };
			}
			forbidden = true;
		}
	}
	return forbidden
		? { status: "forbidden", ref: input.ref }
		: { status: "missing", ref: input.ref };
}

export async function resolveActiveSkill(input: {
	ctx: TurnContext;
	ref: ActiveSkillRef;
	skillById: Map<string, SkillManifest>;
	store: SkillsStore | undefined;
}): Promise<ActiveSkillResolution> {
	if (typeof input.ref === "string") {
		const manifest = input.skillById.get(input.ref);
		if (manifest) return { status: "ok", manifest, ref: input.ref };
		if (!input.store) return { status: "missing", ref: input.ref };
		const organizationId = contextString(input.ctx, ORGANIZATION_CONTEXT_KEY);
		if (!organizationId)
			return { status: "organization_required", ref: input.ref };
		return resolveStoredSkillByOrganizationRef({
			ctx: input.ctx,
			ref: { skillId: input.ref, organizationId },
			store: input.store,
		});
	}
	if (!input.store) return { status: "missing", ref: input.ref };
	const installationRef = parseInstallationRef(input.ref);
	if (installationRef) {
		return resolveStoredSkillByInstallation({
			ctx: input.ctx,
			installationId: installationRef.installationId,
			ref: input.ref,
			store: input.store,
			organizationId: contextString(input.ctx, ORGANIZATION_CONTEXT_KEY),
		});
	}
	const organizationRef = parseOrganizationRef(input.ref);
	if (!organizationRef) return { status: "missing", ref: input.ref };
	if (
		contextString(input.ctx, ORGANIZATION_CONTEXT_KEY) !==
		organizationRef.organizationId
	) {
		return { status: "organization_required", ref: input.ref };
	}
	return resolveStoredSkillByOrganizationRef({
		ctx: input.ctx,
		ref: organizationRef,
		store: input.store,
	});
}

function activationRefs(
	records: readonly SkillActivationRecord[],
): ActiveSkillRef[] {
	return records.map((record) => ({ installationId: record.installationId }));
}

function activationMatchesContext(
	record: SkillActivationRecord,
	ctx: TurnContext,
): boolean {
	const organizationId = contextString(ctx, ORGANIZATION_CONTEXT_KEY);
	if (organizationId === undefined || record.organizationId !== organizationId)
		return false;
	const clawId = contextString(ctx, CLAW_ID_CONTEXT_KEY);
	if (clawId !== undefined && record.clawId !== clawId) return false;
	const threadId = contextString(ctx, THREAD_ID_CONTEXT_KEY);
	return threadId === undefined || record.threadId === threadId;
}

function scopedActivationRefs(
	records: readonly SkillActivationRecord[],
	ctx: TurnContext,
): ActiveSkillRef[] {
	return activationRefs(
		records.filter((record) => activationMatchesContext(record, ctx)),
	);
}

export async function recordedActiveSkillRefs(input: {
	ctx: TurnContext;
	store: SkillsStore | undefined;
}): Promise<ActiveSkillRef[]> {
	if (!input.store) return [];
	const runId = contextString(input.ctx, RUN_ID_CONTEXT_KEY);
	if (runId !== undefined) {
		const runRefs = scopedActivationRefs(
			await input.store.activations.listForRun(runId),
			input.ctx,
		);
		if (runRefs.length > 0) return runRefs;
	}
	const threadId = contextString(input.ctx, THREAD_ID_CONTEXT_KEY);
	return threadId === undefined
		? []
		: scopedActivationRefs(
				await input.store.activations.listForThread(threadId),
				input.ctx,
			);
}
