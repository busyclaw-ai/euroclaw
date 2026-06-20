/**
 * Portions of this file are adapted from Better Auth
 * (https://github.com/better-auth/better-auth), Copyright (c) 2024 - present,
 * Bereket Engida, licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 * Copyright (c) 2026 Konstantin Ponomarev.
 *
 * Adapted (patterns/API, not verbatim): the plugin-as-data-object shape with phantom
 * type carriers, and the tuple-fold that intersects a field across all plugins (cf.
 * `InferPluginFieldFromTuple` / `InferPluginTypes`). Reason-code catalog helpers live in
 * `reason-codes.ts`.
 */

// Plugins contribute gates at RUNTIME and named info at COMPILE TIME. The fold below
// is the better-auth pattern: capture the config generically with
// `createGovernance<const Config>` and intersect a chosen field from every plugin.
//   $Infer        — phantom types the plugin introduces        → ec.$Infer        (types only)
//   $InferContext — context fields the plugin makes available  → typed on ctx     (types only)
//   $REASON_CODES — reason code → message catalog              → ec.$REASON_CODES (types AND runtime)
// See docs/research/better-auth/design-lessons-for-euroclaw.md.

import type { AfterGate, BoundaryGate, Gate } from "./boundary";
import type { ReasonCode } from "./reason-codes";

export type EuroclawHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type EuroclawRouteRequest = {
	method: string;
	url: string;
	headers: { get: (name: string) => string | null };
	json: () => Promise<unknown>;
	text: () => Promise<string>;
};

export type EuroclawRouteResult = {
	body?: unknown;
	headers?: Record<string, string>;
	status?: number;
};

export type EuroclawRouteContext<ClawLike = unknown> = {
	request: EuroclawRouteRequest;
	claw: ClawLike;
	params: Record<string, string>;
};

export type EuroclawRoute<ClawLike = unknown> = {
	id?: string;
	method: EuroclawHttpMethod;
	path: string;
	handler: (
		ctx: EuroclawRouteContext<ClawLike>,
	) => EuroclawRouteResult | Promise<EuroclawRouteResult>;
};

export type EuroclawCronStatus = "idle" | "processed" | "limit";

export type EuroclawCronResult = {
	processed?: number;
	status?: EuroclawCronStatus;
	data?: unknown;
};

export type EuroclawCronContext<ClawLike = unknown> = {
	claw: ClawLike;
	request?: EuroclawRouteRequest;
	limit?: number;
};

export type EuroclawCronTask<ClawLike = unknown> = {
	id: string;
	handler: (
		ctx: EuroclawCronContext<ClawLike>,
	) => EuroclawCronResult | Promise<EuroclawCronResult>;
};

export type EuroclawCronFlag = "has-cron" | "no-cron" | "unknown-cron";

/** A euroclaw plugin: a plain data object. Only `id` is required. */
export type EuroclawPlugin<
	HasCron extends EuroclawCronFlag = EuroclawCronFlag,
	RoutePaths extends readonly string[] = readonly string[],
> = {
	id: string;
	/** Phantom: whether this plugin definitely contributes cron tasks. */
	$HasCron?: HasCron;
	/** Phantom: route paths this plugin definitely contributes, for literal duplicate checks. */
	$RoutePaths?: RoutePaths;
	/** Phantom: named types this plugin introduces (folded onto `ec.$Infer`). */
	$Infer?: Record<string, unknown>;
	/** Phantom: context fields this plugin makes available (folded onto the turn `ctx`). */
	$InferContext?: Record<string, unknown>;
	/** Governance reason code catalog; merged (runtime + type) onto `ec.$REASON_CODES`. */
	$REASON_CODES?: Record<string, ReasonCode>;
	/** Before-gates this plugin installs (decide). */
	gates?: Gate[];
	/** Boundary before-gates this plugin installs (decide across tool/model boundaries). */
	boundaryGates?: BoundaryGate[];
	/** After-gates this plugin installs (observe). */
	afterGates?: AfterGate[];
	/** Adapter routes this plugin contributes. Framework adapters decide how to expose them. */
	routes?: readonly EuroclawRoute[];
	/** Scheduled work this plugin contributes. Framework adapters expose the cron trigger. */
	cron?: readonly EuroclawCronTask[];
};

/** Union → intersection (a ubiquitous TS idiom — not better-auth-specific). */
export type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never;

/** True only for `any` (a ubiquitous TS idiom). Stops a stray `any` collapsing the fold. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type EmptyObject = Record<never, never>;

/** Intersect field `K` across every plugin in a config (the one reusable fold). */
type FoldPluginField<Config, K extends string> = Config extends {
	plugins: infer P;
}
	? P extends ReadonlyArray<infer Item>
		? UnionToIntersection<
				Item extends Record<K, infer V>
					? IsAny<V> extends true
						? EmptyObject
						: V
					: EmptyObject
			>
		: EmptyObject
	: EmptyObject;

export type InferPlugins<Config> = FoldPluginField<Config, "$Infer">;
export type InferContext<Config> = FoldPluginField<Config, "$InferContext">;
export type InferReasonCodes<Config> = FoldPluginField<Config, "$REASON_CODES">;
