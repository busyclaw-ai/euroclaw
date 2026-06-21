import {
	type AuditSink,
	type ClawsStore,
	configurationError,
	type EffectStore,
	type EuroclawCronFlag,
	type EuroclawPlugin,
} from "@euroclaw/core";
import type {
	ClawEngineFactory,
	ClawEngineHandle,
} from "@euroclaw/engine-core";
import {
	createRuntime,
	defaultRuntimeNewId,
	type Runtime,
	type RuntimeConfig,
	type RuntimeDatabase,
	type RuntimeEventSink,
	resolveDatabase,
} from "@euroclaw/runtime";
import { createClawsStore } from "@euroclaw/storage-durable";
import {
	type ClawApi,
	type ClawContext,
	type ClawCronHandlerConfig,
	createClawApi,
} from "./api";
import { createClawRuntimeEventSink } from "./events";

export type {
	BindConversationClawInput,
	BindConversationInput,
	BindConversationResult,
	BindConversationThreadInput,
	ClawApi,
	ClawApiHttpMethod,
	ClawApiInputSchema,
	ClawApiMethod,
	ClawApiRouteDefinition,
	ClawContext,
	ClawCronHandlerConfig,
	ClawSendInput,
	ClawSendResult,
} from "./api";
export {
	clawApiInputSchemas,
	clawApiRouteList,
	clawApiRoutes,
	parseClawApiInput,
} from "./api";

export type ClawStores = {
	claws?: ClawsStore;
	effects?: EffectStore;
};

export type ClawConfig<Config extends RuntimeConfig = RuntimeConfig> = Omit<
	Config,
	"database" | "effectStore" | "events"
> & {
	cronHandler?: ClawCronHandlerConfig;
	database?: RuntimeDatabase;
	engine?: ClawEngineFactory<
		Runtime<Config>,
		ClawEngineHandle,
		EuroclawCronFlag
	>;
	events?: RuntimeEventSink | readonly RuntimeEventSink[];
	stores?: ClawStores;
};

type EngineCronFlag<Config> = Config extends {
	engine: ClawEngineFactory<infer _RuntimeLike, infer _Handle, infer HasCron>;
}
	? HasCron
	: "no-cron";

type PluginCronFlag<Config> = Config extends {
	plugins: readonly (infer Plugin)[];
}
	? Plugin extends { $HasCron?: infer HasCron }
		? Extract<HasCron, EuroclawCronFlag>
		: "unknown-cron"
	: "no-cron";

type HasCronContributor<Config> = "has-cron" extends
	| EngineCronFlag<Config>
	| PluginCronFlag<Config>
	? true
	: false;

type RoutePathsOf<Plugin> = Plugin extends { $RoutePaths?: infer Paths }
	? Paths extends readonly string[]
		? Paths
		: []
	: [];

type ConcatRoutePaths<Plugins> = Plugins extends readonly [
	infer Head,
	...infer Tail,
]
	? [...RoutePathsOf<Head>, ...ConcatRoutePaths<Tail>]
	: [];

type HasDuplicateRoutePath<
	Items extends readonly string[],
	Seen extends readonly string[] = [],
> = Items extends readonly [
	infer Head extends string,
	...infer Tail extends string[],
]
	? Head extends Seen[number]
		? true
		: HasDuplicateRoutePath<Tail, [...Seen, Head]>
	: false;

type MissingCronHandlerError = {
	readonly "ERROR: createClaw requires cronHandler because an engine/plugin/channel contributes cron tasks": never;
	readonly "FIX: add cronHandler: { secret: string } or disable cron tasks on the contributor": never;
};

type RequireCronHandler<Config> =
	HasCronContributor<Config> extends true
		? Config extends { cronHandler: ClawCronHandlerConfig }
			? unknown
			: MissingCronHandlerError
		: unknown;

type DuplicatePluginRoutePathError = {
	readonly "ERROR: duplicate plugin route path detected": never;
	readonly "FIX: set a unique webhook.path or endpointKey for each channel/plugin": never;
};

type RequireUniquePluginRoutePaths<Config> = Config extends {
	plugins: infer Plugins extends readonly unknown[];
}
	? HasDuplicateRoutePath<ConcatRoutePaths<Plugins>> extends true
		? DuplicatePluginRoutePathError
		: unknown
	: unknown;

export type Claw<Config extends RuntimeConfig = RuntimeConfig> = {
	readonly api: ClawApi<Config>;
	readonly $context: ClawContext<Config> & {
		readonly audit?: AuditSink;
		readonly approvals: Runtime<Config>["approvals"];
	};
};

function eventSinksFrom(
	input: RuntimeEventSink | readonly RuntimeEventSink[] | undefined,
): RuntimeEventSink[] {
	if (!input) return [];
	return "emit" in input ? [input] : [...input];
}

function hasCronTasks(plugins: readonly EuroclawPlugin[]): boolean {
	return plugins.some((plugin) => (plugin.cron?.length ?? 0) > 0);
}

function assertCronHandler(input: {
	cronHandler: ClawCronHandlerConfig | undefined;
	plugins: readonly EuroclawPlugin[];
}): void {
	if (!hasCronTasks(input.plugins)) return;
	if (input.cronHandler === undefined) {
		throw configurationError(
			"createClaw requires cronHandler because an engine/plugin/channel contributes cron tasks",
		);
	}
	if (input.cronHandler === false) return;
	if ("unsafeAllowUnauthenticated" in input.cronHandler) return;
	if (!input.cronHandler.secret) {
		throw configurationError(
			"createClaw cronHandler.secret must be a non-empty string",
		);
	}
}

function normalizeRoutePath(path: string): string {
	const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
	return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
		? withLeadingSlash.slice(0, -1)
		: withLeadingSlash;
}

function assertUniquePluginRoutes(plugins: readonly EuroclawPlugin[]): void {
	const seen = new Map<string, string>();
	for (const plugin of plugins) {
		for (const route of plugin.routes ?? []) {
			const key = `${route.method} ${normalizeRoutePath(route.path)}`;
			const routeId = route.id ?? `${plugin.id}:${route.method}:${route.path}`;
			const previous = seen.get(key);
			if (previous) {
				throw configurationError("duplicate euroclaw plugin route", {
					key,
					previous,
					route: routeId,
				});
			}
			seen.set(key, routeId);
		}
	}
}

export function createClaw<const Config extends ClawConfig<RuntimeConfig>>(
	config: Config &
		RequireCronHandler<Config> &
		RequireUniquePluginRoutePaths<Config>,
): Claw<Config> {
	const adapter = config.database
		? resolveDatabase(config.database)
		: undefined;
	const clawsStore =
		config.stores?.claws ?? (adapter ? createClawsStore(adapter) : undefined);
	const eventSinks = [
		...(clawsStore ? [createClawRuntimeEventSink(clawsStore)] : []),
		...eventSinksFrom(config.events),
	];
	const runtime = createRuntime({
		...config,
		...(adapter ? { database: adapter } : {}),
		...(config.stores?.effects ? { effectStore: config.stores.effects } : {}),
		...(eventSinks.length > 0 ? { events: eventSinks } : {}),
	} as Config);
	const engine = config.engine?.create(runtime);
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const plugins: EuroclawPlugin<EuroclawCronFlag>[] = [
		...((config.plugins ?? []) as readonly EuroclawPlugin[]),
		...(engine?.plugins ?? []),
	];
	assertCronHandler({ cronHandler: config.cronHandler, plugins });
	assertUniquePluginRoutes(plugins);
	const context: Claw<Config>["$context"] = {
		audit: runtime.audit,
		approvals: runtime.approvals,
		clawsStore,
		cronHandler: config.cronHandler,
		effects: runtime.effects,
		engine: engine?.engine,
		plugins,
		runs: engine?.runs,
		runtime,
	};
	const api = createClawApi({ context, newId });

	return {
		$context: context,
		api,
	};
}

export type { Runtime, RuntimeConfig, RuntimeResult } from "@euroclaw/runtime";
export { govern } from "@euroclaw/runtime";
export { createClawRuntimeEventSink } from "./events";
