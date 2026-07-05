import {
	ACTOR_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/contracts";
import type {
	SkillAclPermission,
	SkillInstallationRecord,
	SkillsStore,
} from "../core";

function contextString(ctx: TurnContext, key: string): string | undefined {
	const value = ctx[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Grant resolution: does the actor (or its team / organization / a public grant) hold `permission` on the
// installation? Shared by active-skill resolution (the gate) and the governed lifecycle API.
export async function hasSkillGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	permission: SkillAclPermission;
	store: SkillsStore;
}): Promise<boolean> {
	const organizationId = contextString(input.ctx, ORGANIZATION_CONTEXT_KEY);
	if (
		organizationId === undefined ||
		organizationId !== input.installation.organizationId
	) {
		return false;
	}
	const actorId = contextString(input.ctx, ACTOR_CONTEXT_KEY);
	if (actorId !== undefined) {
		const actorGrants = await input.store.acl.listForPrincipal({
			permission: input.permission,
			principalId: actorId,
			principalType: "actor",
			organizationId,
		});
		if (
			actorGrants.some(
				(grant) => grant.installationId === input.installation.id,
			)
		) {
			return true;
		}
	}
	const teamId = contextString(input.ctx, TEAM_CONTEXT_KEY);
	if (teamId !== undefined) {
		const teamGrants = await input.store.acl.listForPrincipal({
			permission: input.permission,
			principalId: teamId,
			principalType: "team",
			organizationId,
		});
		if (
			teamGrants.some((grant) => grant.installationId === input.installation.id)
		) {
			return true;
		}
	}
	const organizationGrants = await input.store.acl.listForPrincipal({
		permission: input.permission,
		principalId: organizationId,
		principalType: "organization",
		organizationId,
	});
	if (
		organizationGrants.some(
			(grant) => grant.installationId === input.installation.id,
		)
	) {
		return true;
	}
	const publicGrants = await input.store.acl.listForPrincipal({
		permission: input.permission,
		principalType: "public",
		organizationId,
	});
	return publicGrants.some(
		(grant) => grant.installationId === input.installation.id,
	);
}

export function hasActivationGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, permission: "activate" });
}

export function hasReadGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, permission: "read" });
}
