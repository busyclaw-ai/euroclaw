import {
	type BindConversationClawInput,
	type BindConversationThreadInput,
	bindConversationClawInput,
	bindConversationThreadInput,
	configurationError,
	type EuroclawCronFlag,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type EuroclawRoute,
	type EuroclawRouteContext,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import { assertUniqueChannels, contextAdapter } from "../channels/plugin";
import { requireClaw } from "../core/claw";
import {
	APP_ENDPOINT_KEY,
	type Channel,
	type EndpointContext,
} from "../core/contracts";
import { dispatchWebhook, pollEndpoint } from "../core/dispatch";
import { channelConnectionsModels } from "./schema";
import {
	type ChannelConnectionListFilter,
	type ChannelConnectionLookup,
	type ChannelConnectionRecord,
	type ChannelConnectionsStore,
	createChannelConnectionsStore,
	type RegisterChannelConnectionInput,
} from "./store";

/** The api namespace this plugin exposes on `claw.api.channels.connections`. */
export type ChannelConnectionsApi = {
	/** Register (or re-register: rotate + re-activate) a user's bot — the sso register analog. */
	register: (
		input: RegisterChannelConnectionInput,
	) => Promise<ChannelConnectionRecord>;
	get: (input: { id: string }) => Promise<ChannelConnectionRecord | null>;
	getByKey: (
		input: ChannelConnectionLookup,
	) => Promise<ChannelConnectionRecord | null>;
	list: (
		filter?: ChannelConnectionListFilter,
	) => Promise<ChannelConnectionRecord[]>;
	revoke: (
		input: ChannelConnectionLookup,
	) => Promise<ChannelConnectionRecord | null>;
};

export type ChannelConnectionsPluginApi = {
	readonly channels: { readonly connections: ChannelConnectionsApi };
};

export type ChannelConnectionsOptions = {
	/** Plugin id override (default "euroclaw.channel-connections"). */
	id?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
	/**
	 * Allow poll-mode connections and contribute the poll cron. Off by default: polling registered
	 * bots needs a scheduler, so enabling this makes createClaw demand a cronHandler at compile time —
	 * and registering a poll-mode connection while it's off fails loudly.
	 */
	poll?: boolean;
};

export type ChannelConnectionsPlugin<
	HasCron extends EuroclawCronFlag = EuroclawCronFlag,
> = EuroclawPlugin<HasCron, readonly string[], ChannelConnectionsPluginApi> & {
	readonly $Api: ChannelConnectionsPluginApi;
};

type ConnectionsCronFlag<Options> = Options extends { poll: true }
	? "has-cron"
	: "no-cron";

// One webhook mount per registered bot — the key is in the path (the sso `/sso/callback/:providerId`
// model): every connection gets its own URL to hand to the provider's setWebhook.
const WEBHOOK_PATH = "/channels/:provider/connections/:endpointKey/webhook";

/**
 * The channelConnections plugin — user-registered bots, the SSO analog: hosts let their users bring
 * their OWN bots at runtime. Credentials live in the channel_connection row (read back at use), the
 * tenant they belong to is row data (the organizationId analog), and conversations bind under the
 * row's claw defaults. Providers are the same Channel transports the channels plugin uses — pass them
 * config-light (e.g. `telegram()`), everything endpoint-specific resolves from the row.
 */
export function channelConnections<
	const Options extends ChannelConnectionsOptions = Record<never, never>,
>(
	providers: readonly Channel[],
	options?: Options,
): ChannelConnectionsPlugin<ConnectionsCronFlag<Options>> {
	// build sets $HasCron at runtime from the same options.poll the conditional type folds — the one
	// seam between runtime and the typed flag.
	return buildPlugin(
		providers,
		options ?? {},
		undefined,
	) as ChannelConnectionsPlugin<ConnectionsCronFlag<Options>>;
}

function buildPlugin(
	providers: readonly Channel[],
	options: ChannelConnectionsOptions,
	store: ChannelConnectionsStore | undefined,
): ChannelConnectionsPlugin {
	assertUniqueChannels(providers);
	const now = options.now ?? (() => new Date().toISOString());
	const pollEnabled = options.poll === true;
	const byProvider = new Map(
		providers.map((channel) => [channel.provider, channel]),
	);

	const requireStore = (): ChannelConnectionsStore => {
		if (!store) {
			throw configurationError(
				"channelConnections requires a database adapter",
				{
					reason:
						"pass a database to createClaw so connections can be registered and resolved",
				},
			);
		}
		return store;
	};

	const configure = (
		context: EuroclawPluginConfigureContext,
	): ChannelConnectionsPlugin | undefined => {
		if (store) return undefined;
		const adapter = contextAdapter(context);
		if (!adapter) return undefined;
		return buildPlugin(
			providers,
			options,
			createChannelConnectionsStore(adapter, { now }),
		);
	};

	// The row's bind-defaults JSON crossed a trust boundary (the registration api wrote it), so the
	// claw/thread defaults are arktype-validated here before they reach bindConversation.
	const clawDefaults = (
		row: ChannelConnectionRecord,
	): BindConversationClawInput | undefined => {
		const merged = {
			...row.claw,
			...(row.tenantId !== undefined ? { tenantId: row.tenantId } : {}),
		};
		if (Object.keys(merged).length === 0) return undefined;
		const valid = bindConversationClawInput(merged);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel connection claw defaults invalid",
				valid.summary,
				{ endpointKey: row.endpointKey, provider: row.provider },
			);
		}
		return valid;
	};
	const threadDefaults = (
		row: ChannelConnectionRecord,
	): BindConversationThreadInput | undefined => {
		if (row.thread === undefined || Object.keys(row.thread).length === 0)
			return undefined;
		const valid = bindConversationThreadInput(row.thread);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel connection thread defaults invalid",
				valid.summary,
				{ endpointKey: row.endpointKey, provider: row.provider },
			);
		}
		return valid;
	};

	const contextFor = (row: ChannelConnectionRecord): EndpointContext => ({
		provider: row.provider,
		endpointKey: row.endpointKey,
		mode: row.mode,
		secret: row.secret,
		webhookSecret: row.webhookSecret,
		cursor: row.cursor,
		claw: clawDefaults(row),
		thread: threadDefaults(row),
	});

	const register = async (
		input: RegisterChannelConnectionInput,
	): Promise<ChannelConnectionRecord> => {
		if (!byProvider.has(input.provider)) {
			throw configurationError("unknown channel provider", {
				provider: input.provider,
				reason: "pass this provider's channel to channelConnections([...])",
			});
		}
		if (input.endpointKey === APP_ENDPOINT_KEY) {
			// The app's own bot binds under this key — a connection sharing it would land in the same
			// (provider, endpointKey) binding space and cross-wire conversations.
			throw configurationError("reserved connection key", {
				endpointKey: input.endpointKey,
				provider: input.provider,
				reason: `"${APP_ENDPOINT_KEY}" is the app bot's endpoint key — pick another`,
			});
		}
		if (input.mode === "poll" && !pollEnabled) {
			throw configurationError("connections poll is disabled", {
				provider: input.provider,
				reason:
					"enable it with channelConnections(providers, { poll: true }) and configure a cronHandler",
			});
		}
		return requireStore().register(input);
	};

	const webhookRoute: EuroclawRoute = {
		id: "channels:connections:webhook",
		method: "POST",
		path: WEBHOOK_PATH,
		handler: async ({ claw, params, request }: EuroclawRouteContext) => {
			const channel = byProvider.get(params.provider ?? "");
			if (!channel) {
				return { status: 404, body: { ok: false, error: "unknown provider" } };
			}
			const endpointKey = params.endpointKey ?? "";
			const row = await requireStore().getByKey({
				provider: channel.provider,
				endpointKey,
			});
			// Absent and revoked look identical from outside — don't leak registry state.
			if (row?.status !== "active") {
				return {
					status: 404,
					body: { ok: false, error: "unknown connection" },
				};
			}
			const rawBody = await request.text();
			const result = await dispatchWebhook({
				claw: requireClaw(claw),
				channel,
				endpoint: contextFor(row),
				request: { headers: request.headers, rawBody },
				persist: (event) =>
					requireStore().record(
						{ provider: row.provider, endpointKey: row.endpointKey },
						event,
					),
			});
			return { status: result.status, body: result.body };
		},
	};

	const pollTask = {
		id: "channels:connections:poll",
		handler: async ({ claw, limit }: { claw: unknown; limit?: number }) => {
			const rows = await requireStore().list({
				mode: "poll",
				status: "active",
			});
			let processed = 0;
			for (const row of rows) {
				const channel = byProvider.get(row.provider);
				if (!channel) continue; // registered before its provider left the registry — skip
				const result = await pollEndpoint({
					claw: requireClaw(claw),
					channel,
					endpoint: contextFor(row),
					limit,
					persist: (event) =>
						requireStore().record(
							{ provider: row.provider, endpointKey: row.endpointKey },
							event,
						),
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
		id: options.id ?? "euroclaw.channel-connections",
		$HasCron: pollEnabled ? "has-cron" : "no-cron",
		$Api: {} as ChannelConnectionsPluginApi,
		schema: channelConnectionsModels,
		configure,
		routes: [webhookRoute],
		cron: pollEnabled ? [pollTask] : [],
		api: () => ({
			channels: {
				connections: {
					register,
					get: ({ id }) => requireStore().get(id),
					getByKey: (input) => requireStore().getByKey(input),
					list: (filter) => requireStore().list(filter),
					revoke: (input) => requireStore().revoke(input),
				},
			},
		}),
	};
}
