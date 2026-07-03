import {
	type Adapter,
	configurationError,
	type EuroclawCronFlag,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type EuroclawRoute,
	type EuroclawRouteContext,
} from "@euroclaw/contracts";
import { requireClaw } from "../core/claw";
import {
	APP_ENDPOINT_KEY,
	type Channel,
	type EndpointContext,
} from "../core/contracts";
import { dispatchWebhook, pollEndpoint } from "../core/dispatch";
import { channelsModels } from "./schema";
import {
	type ChannelEndpointStateStore,
	createChannelEndpointStateStore,
} from "./store";

export type ChannelsPluginOptions = {
	/** Plugin id override (default "euroclaw.channels"). */
	id?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

export type ChannelsPlugin<
	HasCron extends EuroclawCronFlag = EuroclawCronFlag,
> = EuroclawPlugin<HasCron, readonly string[]>;

/** A channel that may carry a compile-time poll marker (providers like telegram set it). */
type PollAware = Channel & { readonly $poll?: boolean };

/**
 * Does any channel in the list declare a poll endpoint at the type level? If so the plugin contributes
 * the poll cron, and `createClaw`'s RequireCronHandler demands a cronHandler at compile time. Channels
 * without a `$poll` marker fall back to runtime cron enforcement (assertCronHandler).
 */
type AnyPoll<List extends readonly PollAware[]> = [
	Extract<List[number]["$poll"], true>,
] extends [never]
	? false
	: true;

type ChannelsCronFlag<List extends readonly PollAware[]> =
	AnyPoll<List> extends true ? "has-cron" : "no-cron";

/**
 * The compile-time channel key — provider(:name), literals only. A wide `string` provider/name
 * (hand-rolled fixtures) yields `never` and falls back to the runtime check, so the fold can't
 * false-positive on non-literal types.
 */
type ChannelKeyOf<C> = C extends { readonly provider: infer P extends string }
	? string extends P
		? never
		: C extends { readonly name: infer N extends string }
			? string extends N
				? never
				: `${P}:${N}`
			: `${P}:${typeof APP_ENDPOINT_KEY}`
	: never;

type ChannelKeys<List extends readonly unknown[]> = List extends readonly [
	infer Head,
	...infer Tail,
]
	? [ChannelKeyOf<Head>, ...ChannelKeys<Tail>]
	: [];

type HasDuplicateKey<
	Items extends readonly unknown[],
	Seen = never,
> = Items extends readonly [infer Head, ...infer Tail]
	? [Head] extends [never]
		? HasDuplicateKey<Tail, Seen>
		: [Head] extends [Seen]
			? true
			: HasDuplicateKey<Tail, Seen | Head>
	: false;

type DuplicateChannelError = {
	readonly "ERROR: two channels share a provider without distinct names": never;
	readonly "FIX: name the extra bots — telegram({ name: 'sales' })": never;
};

/** Two bots of one provider must carry distinct names (the genericOAuth providerId model). */
type RequireDistinctChannels<List extends readonly unknown[]> =
	HasDuplicateKey<ChannelKeys<List>> extends true
		? DuplicateChannelError
		: unknown;

// The webhook mounts for the app's own bots: a provider's unnamed bot answers on the bare path,
// named bots each get their own segment — the genericOAuth `/oauth2/callback/:providerId` model.
// User-registered bots are the channelConnections plugin's route, not these.
const WEBHOOK_PATH = "/channels/:provider/webhook";
const NAMED_WEBHOOK_PATH = "/channels/:provider/webhook/:name";

/** A bot's endpoint key: its name, or the unnamed-bot constant. */
const keyOf = (channel: Channel): string => channel.name ?? APP_ENDPOINT_KEY;

/** Narrow the resolved adapter the assembly passes through the configure context's index signature. */
export function contextAdapter(context: unknown): Adapter | undefined {
	if (context === null || typeof context !== "object") return undefined;
	const value = (context as { adapter?: unknown }).adapter;
	if (value === null || typeof value !== "object") return undefined;
	return value as Adapter;
}

/** One transport per provider — channelConnections resolves everything else from rows. */
export function assertUniqueProviders(channels: readonly Channel[]): void {
	const providers = new Set<string>();
	for (const channel of channels) {
		if (providers.has(channel.provider)) {
			throw configurationError("duplicate channel provider", {
				provider: channel.provider,
				reason: "pass one transport per provider",
			});
		}
		providers.add(channel.provider);
	}
}

/** Distinct (provider, name) per app bot — the runtime mirror of RequireDistinctChannels. */
function assertUniqueChannelKeys(channels: readonly Channel[]): void {
	const keys = new Set<string>();
	for (const channel of channels) {
		const key = `${channel.provider}:${keyOf(channel)}`;
		if (keys.has(key)) {
			throw configurationError("duplicate channel", {
				name: keyOf(channel),
				provider: channel.provider,
				reason:
					"two bots of one provider need distinct names — telegram({ name: 'sales' })",
			});
		}
		keys.add(key);
	}
}

/**
 * The channels plugin — the app's own bots, the socialProviders/genericOAuth analog: one shared bot
 * per provider declared in code, serving every user of the app. Credentials stay in code; the
 * channel_endpoint table holds only operational state (poll cursor, last traffic, last error). For
 * user-registered bots see channelConnections (the SSO analog).
 */
export function channels<const List extends readonly PollAware[]>(
	list: List & RequireDistinctChannels<List>,
	options: ChannelsPluginOptions = {},
): ChannelsPlugin<ChannelsCronFlag<List>> {
	// buildChannelsPlugin sets $HasCron at runtime from the same poll-endpoint check AnyPoll folds at
	// the type level, so this narrowing cast is sound — the one seam between runtime and the typed flag.
	return buildChannelsPlugin(list, options, undefined) as ChannelsPlugin<
		ChannelsCronFlag<List>
	>;
}

function buildChannelsPlugin(
	list: readonly Channel[],
	options: ChannelsPluginOptions,
	store: ChannelEndpointStateStore | undefined,
): ChannelsPlugin {
	assertUniqueChannelKeys(list);
	// Every channel here is an app bot — fail at startup, not on first traffic, if one is unusable
	// (e.g. no token in config and none in the environment).
	for (const channel of list) channel.validate?.();
	const now = options.now ?? (() => new Date().toISOString());
	// Safe to key by (provider, name): assertUniqueChannelKeys guarantees distinct keys.
	const byKey = new Map(
		list.map((channel) => [`${channel.provider}:${keyOf(channel)}`, channel]),
	);
	const hasWebhook = list.some((channel) => channel.supports.webhook);
	const hasNamed = list.some((channel) => channel.name !== undefined);
	const pollTargets = list.filter(
		(channel) => channel.supports.poll && channel.mode === "poll",
	);

	const requireStore = (): ChannelEndpointStateStore => {
		if (!store) {
			throw configurationError("channels requires a database adapter", {
				reason:
					"pass a database to createClaw so channels can persist endpoint state",
			});
		}
		return store;
	};

	const configure = (
		context: EuroclawPluginConfigureContext,
	): ChannelsPlugin | undefined => {
		if (store) return undefined;
		const adapter = contextAdapter(context);
		if (!adapter) return undefined;
		return buildChannelsPlugin(
			list,
			options,
			createChannelEndpointStateStore(adapter, { now }),
		);
	};

	// A bot's normalized view: no secrets (the client lives on the channel), no bind defaults
	// (conversations create bare personal claws — placement is the host's logic through the public
	// bindConversation api), cursor from the state row under the bot's key.
	const contextFor = async (channel: Channel): Promise<EndpointContext> => {
		const state = await requireStore().get({
			provider: channel.provider,
			endpointKey: keyOf(channel),
		});
		return {
			provider: channel.provider,
			endpointKey: keyOf(channel),
			mode: channel.mode,
			cursor: state?.cursor,
		};
	};

	const persistFor =
		(channel: Channel) =>
		(event: Parameters<ChannelEndpointStateStore["record"]>[1]) =>
			requireStore().record(
				{
					provider: channel.provider,
					endpointKey: keyOf(channel),
					mode: channel.mode,
				},
				event,
			);

	const webhookHandler =
		(keyFrom: (params: Record<string, string>) => string) =>
		async ({ claw, params, request }: EuroclawRouteContext) => {
			const channel = byKey.get(`${params.provider ?? ""}:${keyFrom(params)}`);
			if (!channel) {
				return { status: 404, body: { ok: false, error: "unknown channel" } };
			}
			const rawBody = await request.text();
			const result = await dispatchWebhook({
				claw: requireClaw(claw),
				channel,
				endpoint: await contextFor(channel),
				request: { headers: request.headers, rawBody },
				persist: persistFor(channel),
			});
			return { status: result.status, body: result.body };
		};

	const webhookRoutes: EuroclawRoute[] = [
		{
			id: "channels:webhook",
			method: "POST",
			path: WEBHOOK_PATH,
			handler: webhookHandler(() => APP_ENDPOINT_KEY),
		},
		// Mounted only when a named bot exists — each named bot answers on its own path segment.
		...(hasNamed
			? [
					{
						id: "channels:webhook:named",
						method: "POST" as const,
						path: NAMED_WEBHOOK_PATH,
						handler: webhookHandler((params) => params.name ?? ""),
					},
				]
			: []),
	];

	const pollTask = {
		id: "channels:poll",
		handler: async ({ claw, limit }: { claw: unknown; limit?: number }) => {
			let processed = 0;
			for (const channel of pollTargets) {
				const result = await pollEndpoint({
					claw: requireClaw(claw),
					channel,
					endpoint: await contextFor(channel),
					limit,
					persist: persistFor(channel),
				});
				processed += result.processed;
			}
			return {
				processed,
				status: processed > 0 ? ("processed" as const) : ("idle" as const),
			};
		},
	};

	return {
		id: options.id ?? "euroclaw.channels",
		$HasCron: pollTargets.length > 0 ? "has-cron" : "no-cron",
		schema: channelsModels,
		configure,
		routes: hasWebhook ? webhookRoutes : [],
		cron: pollTargets.length > 0 ? [pollTask] : [],
	};
}
