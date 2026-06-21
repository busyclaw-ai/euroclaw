// Identity & membership resolution — runtime-level wiring, composed into core's neutral
// `resolveContext` hook. Each is a FUNCTION (not a vendor object): a session-getter,
// a JWT decoder, a role lookup — vendor-neutral and testable with a fake.

import {
	ACTOR_CONTEXT_KEY,
	type ContextResolver,
	ROLE_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	TENANT_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/core";

/** Resolves the accountable operator → the `actor` (or undefined). `() => "system:cron"` for background runs. */
export type IdentityResolver = (
	ctx: TurnContext,
) => string | undefined | Promise<string | undefined>;

/** The actor's membership for a run: which team, and their role on it. */
export type Membership = { team: string; role: string };

/** Resolves the actor's membership (team + role). Runs after identity (it needs the actor). */
export type MembershipResolver = (
	ctx: TurnContext,
) => Membership | undefined | Promise<Membership | undefined>;

/** Resolves the tenant boundary for durable resources and PII mapping scopes. */
export type TenantResolver = (
	ctx: TurnContext,
) => string | undefined | Promise<string | undefined>;

/** Build an IdentityResolver from any session-getter — better-auth's, your own — just `getSession`. */
export function sessionIdentity(deps: {
	getSession: (input: {
		headers: unknown;
	}) => Promise<{ user: { id: string } } | null>;
}): IdentityResolver {
	return async (ctx) =>
		(await deps.getSession({ headers: ctx.headers }))?.user.id;
}

/** Build a MembershipResolver from any `roleOf(team, actor)` lookup — the native team store, better-auth, your own. */
export function roleMembership(deps: {
	roleOf: (
		team: string,
		actor: string,
	) => string | null | Promise<string | null>;
	/** Where the active team comes from in `ctx`. Default: a non-reserved `team` key. */
	team?: (ctx: TurnContext) => string | undefined;
}): MembershipResolver {
	const teamOf =
		deps.team ??
		((ctx) => (typeof ctx.team === "string" ? ctx.team : undefined));
	return async (ctx) => {
		const team = teamOf(ctx);
		const actor = ctx[ACTOR_CONTEXT_KEY];
		if (team === undefined || typeof actor !== "string") return undefined;
		const role = await deps.roleOf(team, actor);
		return role === null ? undefined : { team, role };
	};
}

/** Compose identity + membership into ONE core ContextResolver — identity first (membership needs the actor). */
export function composeContext(parts: {
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	tenant?: TenantResolver;
}): ContextResolver | undefined {
	const { identity, membership, tenant } = parts;
	if (!identity && !membership && !tenant) return undefined;
	return async (ctx) => {
		if (tenant) {
			const tenantId = await tenant(ctx);
			if (typeof tenantId === "string") ctx[TENANT_CONTEXT_KEY] = tenantId;
		}
		if (identity) {
			const actor = await identity(ctx);
			if (typeof actor === "string") ctx[ACTOR_CONTEXT_KEY] = actor;
		}
		if (membership) {
			const m = await membership(ctx);
			if (m) {
				ctx[TEAM_CONTEXT_KEY] = m.team;
				ctx[ROLE_CONTEXT_KEY] = m.role;
			}
		}
		return ctx;
	};
}
