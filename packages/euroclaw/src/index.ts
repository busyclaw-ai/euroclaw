import {
	type AuditSink,
	type ClawsStore,
	configurationError,
	type EffectStore,
	type EuroclawCronFlag,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type InferPluginApi,
} from "@euroclaw/contracts";
import type {
	ClawEngineFactory,
	ClawEngineHandle,
} from "@euroclaw/engine-core";
import {
	createRuntime,
	defaultRuntimeNewId,
	pluginEventSink,
	type Runtime,
	type RuntimeConfig,
	type RuntimeDatabase,
	type RuntimeEventSink,
	resolveDatabase,
} from "@euroclaw/runtime";
import { createClawsStore, createEffectStore } from "@euroclaw/storage-durable";
import { type as ark } from "arktype";
import {
	type ClawApi,
	type ClawContext,
	type ClawCronHandlerConfig,
	clawCronHandlerSecretConfig,
	clawCronHandlerUnsafeConfig,
	createClawApi,
} from "./api";
import { createClawRuntimeEventSink } from "./events";
import type { ClawModelsConfig, RequireNoCoreColumnCollision } from "./models";
import { collectModelFields, getEuroclawTables } from "./tables";

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
	ClawCronHandlerSecretConfig,
	ClawCronHandlerUnsafeConfig,
	ClawSendInput,
	ClawSendResult,
} from "./api";
export {
	clawApiInputSchemas,
	clawApiRouteList,
	clawApiRoutes,
	clawCronHandlerSecretConfig,
	clawCronHandlerUnsafeConfig,
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
	models?: ClawModelsConfig;
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
	readonly api: ClawApi<Config> & InferPluginApi<Config>;
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
	const unsafe = clawCronHandlerUnsafeConfig(input.cronHandler);
	if (!(unsafe instanceof ark.errors)) return;
	const secret = clawCronHandlerSecretConfig(input.cronHandler);
	if (secret instanceof ark.errors || secret.secret.length === 0) {
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

function configurePlugins(input: {
	context: EuroclawPluginConfigureContext;
	plugins: readonly EuroclawPlugin[];
}): EuroclawPlugin[] {
	return input.plugins.map((plugin) => {
		const configured = plugin.configure?.(input.context);
		return configured ?? plugin;
	});
}

function assertApiContribution(input: {
	pluginId: string;
	value: unknown;
}): Record<string, unknown> {
	if (
		input.value === null ||
		typeof input.value !== "object" ||
		Array.isArray(input.value)
	) {
		throw configurationError("euroclaw plugin api must be an object", {
			pluginId: input.pluginId,
		});
	}
	return input.value as Record<string, unknown>;
}

function createPluginApi(input: {
	baseApi: object;
	context: ClawContext;
	plugins: readonly EuroclawPlugin[];
}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const owners = new Map<string, string>();
	for (const plugin of input.plugins) {
		if (!plugin.api) continue;
		const api = assertApiContribution({
			pluginId: plugin.id,
			value: plugin.api(input.context),
		});
		for (const [key, value] of Object.entries(api)) {
			const previous = owners.get(key);
			if (previous) {
				throw configurationError("duplicate euroclaw plugin api namespace", {
					namespace: key,
					pluginId: plugin.id,
					previous,
				});
			}
			if (key in input.baseApi) {
				throw configurationError(
					"euroclaw plugin api conflicts with base api",
					{
						namespace: key,
						pluginId: plugin.id,
					},
				);
			}
			owners.set(key, plugin.id);
			out[key] = value;
		}
	}
	return out;
}

export function createClaw<const Config extends ClawConfig<RuntimeConfig>>(
	config: Config &
		RequireCronHandler<Config> &
		RequireUniquePluginRoutePaths<Config> &
		RequireNoCoreColumnCollision<Config>,
): Claw<Config> {
	const adapter = config.database
		? resolveDatabase(config.database)
		: undefined;
	const pluginList = (config.plugins ?? []) as readonly EuroclawPlugin[];
	// Fail fast at init if any plugin/host schema collides with a core column — the same collection the
	// `generate` CLI runs, so a bad registration surfaces here, not at migration time.
	getEuroclawTables({ models: config.models, plugins: pluginList });
	const modelFields = collectModelFields(pluginList, config.models);
	const clawAdditionalFields = modelFields.claw;
	const clawsStore =
		config.stores?.claws ??
		(adapter
			? createClawsStore(
					adapter,
					clawAdditionalFields
						? { additionalFields: { claw: clawAdditionalFields } }
						: {},
				)
			: undefined);
	const configuredEffectStore = (config as { effectStore?: EffectStore })
		.effectStore;
	const effectsStore =
		config.stores?.effects ??
		configuredEffectStore ??
		(adapter ? createEffectStore(adapter) : undefined);
	const eventSinks = [
		...(clawsStore ? [createClawRuntimeEventSink(clawsStore)] : []),
		...eventSinksFrom(config.events),
	];
	const configuredPlugins = configurePlugins({
		context: {
			// The resolved adapter, passed through the configure context's index signature so a plugin
			// that owns tables (e.g. skills) can build its own store — core never creates a plugin store.
			adapter,
			clawsStore,
			effects: effectsStore,
			events: pluginEventSink(eventSinks),
		},
		plugins: (config.plugins ?? []) as readonly EuroclawPlugin[],
	});
	const runtime = createRuntime({
		...config,
		plugins: configuredPlugins,
		...(adapter ? { database: adapter } : {}),
		...(effectsStore ? { effectStore: effectsStore } : {}),
		...(eventSinks.length > 0 ? { events: eventSinks } : {}),
	} as Config);
	const engine = config.engine?.create(runtime);
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const plugins: EuroclawPlugin<EuroclawCronFlag>[] = [
		...configuredPlugins,
		...(engine?.plugins ?? []),
	];
	assertCronHandler({ cronHandler: config.cronHandler, plugins });
	assertUniquePluginRoutes(plugins);
	const context: Claw<Config>["$context"] = {
		audit: runtime.audit,
		approvals: runtime.approvals,
		clawsStore,
		cronHandler: config.cronHandler,
		effects: effectsStore,
		engine: engine?.engine,
		plugins,
		runs: engine?.runs,
		runtime,
	};
	const baseApi = createClawApi({ context, newId });
	const api = {
		...baseApi,
		...createPluginApi({ baseApi, context, plugins }),
	} as Claw<Config>["api"];

	return {
		$context: context,
		api,
	};
}

export type { Runtime, RuntimeConfig, RuntimeResult } from "@euroclaw/runtime";
export { govern } from "@euroclaw/runtime";
export { createClawRuntimeEventSink } from "./events";
export { getEuroclawTables } from "./tables";
