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

// The one webhook mount for the app's own bots — dispatch is by `:provider` alone (one bot per
// provider; the provider's verify authenticates it). User-registered bots are the channelConnections
// plugin's route, not this one.
const WEBHOOK_PATH = "/channels/:provider/webhook";

/** Narrow the resolved adapter the assembly passes through the configure context's index signature. */
export function contextAdapter(context: unknown): Adapter | undefined {
	if (context === null || typeof context !== "object") return undefined;
	const value = (context as { adapter?: unknown }).adapter;
	if (value === null || typeof value !== "object") return undefined;
	return value as Adapter;
}

/** One channel per provider — webhook dispatch is by provider alone. */
export function assertUniqueChannels(channels: readonly Channel[]): void {
	const providers = new Set<string>();
	for (const channel of channels) {
		if (providers.has(channel.provider)) {
			throw configurationError("duplicate channel provider", {
				provider: channel.provider,
				reason:
					"webhook dispatch is by provider — register one channel per provider",
			});
		}
		providers.add(channel.provider);
	}
}

/**
 * The channels plugin — the app's own bots, the socialProviders/genericOAuth analog: one shared bot
 * per provider declared in code, serving every user of the app. Credentials stay in code; the
 * channel_endpoint table holds only operational state (poll cursor, last traffic, last error). For
 * user-registered bots see channelConnections (the SSO analog).
 */
export function channels<const List extends readonly PollAware[]>(
	list: List,
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
	assertUniqueChannels(list);
	// Every channel here is an app bot — fail at startup, not on first traffic, if one is unusable
	// (e.g. no token in config and none in the environment).
	for (const channel of list) channel.validate?.();
	const now = options.now ?? (() => new Date().toISOString());
	// Safe to key by provider: assertUniqueChannels guarantees one channel per provider.
	const byProvider = new Map(
		list.map((channel) => [channel.provider, channel]),
	);
	const hasWebhook = list.some((channel) => channel.supports.webhook);
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

	// The app bot's normalized view: no secrets (the client lives on the channel), no bind defaults
	// (conversations create bare personal claws — placement is the host's logic through the public
	// bindConversation api), cursor from the state row under the reserved app-bot key.
	const contextFor = async (channel: Channel): Promise<EndpointContext> => {
		const state = await requireStore().get({
			provider: channel.provider,
			endpointKey: APP_ENDPOINT_KEY,
		});
		return {
			provider: channel.provider,
			endpointKey: APP_ENDPOINT_KEY,
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
					endpointKey: APP_ENDPOINT_KEY,
					mode: channel.mode,
				},
				event,
			);

	const webhookRoute: EuroclawRoute = {
		id: "channels:webhook",
		method: "POST",
		path: WEBHOOK_PATH,
		handler: async ({ claw, params, request }: EuroclawRouteContext) => {
			const channel = byProvider.get(params.provider ?? "");
			if (!channel) {
				return { status: 404, body: { ok: false, error: "unknown provider" } };
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
		},
	};

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
		routes: hasWebhook ? [webhookRoute] : [],
		cron: pollTargets.length > 0 ? [pollTask] : [],
	};
}
