// The channels floor — the @better-auth/core/oauth2 analog: the Channel adapter contract, the
// normalized endpoint view, and the message shapes. Both plugins (channels = the app's own bots,
// channelConnections = user-registered bots) and every provider build on this module; nothing here
// imports a plugin or a store.

import type {
	BindConversationClawInput,
	BindConversationThreadInput,
	JsonValue,
} from "@euroclaw/contracts";

export const channelEndpointModeValues = ["webhook", "poll"] as const;
export type ChannelEndpointMode = (typeof channelEndpointModeValues)[number];

/**
 * A raw inbound request, narrowed to what a channel needs. The dispatch engine reads the body once and
 * hands the bytes to both `verify` (header- or signature-based) and `parseInbound`, so a channel never
 * has to worry about the single-read body.
 */
export type InboundRequest = {
	headers: { get: (name: string) => string | null };
	rawBody: string;
};

/** One normalized inbound message — the parse target every provider produces from its wire format. */
export type InboundMessage = {
	externalConversationId: string;
	externalActorId?: string;
	text: string;
	conversationTitle?: string;
	/** Opaque token the channel round-trips to `send` to thread the reply (e.g. a message id). */
	replyContext?: JsonValue;
	raw?: JsonValue;
};

/** A normalized reply the dispatch engine hands back to a channel to deliver. */
export type OutboundMessage = {
	externalConversationId: string;
	text: string;
	replyContext?: JsonValue;
};

/**
 * The endpoint a channel operates on for one request/poll cycle — a NORMALIZED view the calling
 * plugin assembles. A code-declared bot (the app's own — credentials in memory on the channel) and a
 * registered connection row (a user's bot — credentials in the row) look identical here; only the
 * assembling plugin knows the source.
 */
export type EndpointContext = {
	provider: string;
	endpointKey: string;
	mode: ChannelEndpointMode;
	/** Egress credential from a connection row (e.g. a bot token). Code bots keep clients in memory. */
	secret?: string;
	/** Inbound verification secret from a connection row — `verify` checks it before code config. */
	webhookSecret?: string;
	/** Poll cursor from the endpoint's persisted state. */
	cursor?: JsonValue;
	/**
	 * Bind defaults for conversations on this endpoint — set by channelConnections from the row
	 * (tenant on `claw.tenantId`). The app's own bots carry none: conversations create bare personal
	 * claws, and hosts that want placement pre-bind through the public bindConversation api.
	 */
	claw?: BindConversationClawInput;
	thread?: BindConversationThreadInput;
};

/**
 * What dispatch reports back after handling traffic on an endpoint. Each plugin maps events onto its
 * own table (channels → channel_endpoint state, channelConnections → the connection row) — the engine
 * never touches storage.
 */
export type EndpointEvent =
	| { kind: "received" }
	| { kind: "polled"; cursor: JsonValue | undefined }
	| { kind: "poll-error"; error: JsonValue };

export type PersistEndpointEvent = (event: EndpointEvent) => Promise<unknown>;

/**
 * The endpoint key of the app's own bot — the channels plugin runs ONE bot per provider (webhook
 * dispatch is by `:provider` alone), so its state rows and conversation bindings all live under this
 * constant. channelConnections refuses to register a connection with this key: it would share the
 * app bot's binding space and cross-wire conversations.
 */
export const APP_ENDPOINT_KEY = "default";

/**
 * The behavioral contract every channel implements — the OAuthProvider analog, but bidirectional
 * (channels send). The shared engine owns bind/relay/reply; a channel supplies only the
 * provider-specific verify/parse/send/poll. Credential resolution (code client vs `endpoint.secret`)
 * is the channel's private concern.
 */
export interface Channel {
	readonly provider: string;
	readonly supports: { readonly webhook: boolean; readonly poll: boolean };
	/** The app bot's transport (the channels plugin runs one bot per provider). */
	readonly mode: ChannelEndpointMode;
	/**
	 * Assert the code-declared configuration is usable (credentials present after env fallbacks).
	 * channels() calls this at construction so a dead app bot fails at startup, not on first traffic;
	 * channelConnections never calls it — a bare transport's credentials live on the rows.
	 */
	validate?: () => void;
	/**
	 * Authenticate an inbound request against the endpoint BEFORE its body is trusted. Prefer failing
	 * closed — an unverified webhook relays attacker input straight into a model run (telegram checks
	 * `endpoint.webhookSecret`, then code config, and refuses when neither is set).
	 */
	verify?: (input: {
		request: InboundRequest;
		endpoint: EndpointContext;
	}) => boolean | Promise<boolean>;
	/** Parse a raw request into normalized inbound messages. */
	parseInbound: (input: {
		request: InboundRequest;
		endpoint: EndpointContext;
	}) => InboundMessage[] | Promise<InboundMessage[]>;
	/** Deliver a reply through the provider. */
	send: (input: {
		message: OutboundMessage;
		endpoint: EndpointContext;
	}) => Promise<void>;
	/** Poll for new messages — present only when `supports.poll`. */
	poll?: (input: {
		endpoint: EndpointContext;
		cursor: JsonValue | undefined;
		limit?: number;
	}) => Promise<{ messages: InboundMessage[]; cursor: JsonValue | undefined }>;
}
