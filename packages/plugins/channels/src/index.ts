// @euroclaw/channels — the app's own bots (the socialProviders/genericOAuth analog): one shared bot
// per provider, declared in code, serving every user of the app. This root export is the channels()
// plugin plus the floor every provider and plugin builds on (the @better-auth/core/oauth2 analog).
//
// Deliberately NOT re-exported here (subpath isolation beats tree-shaking):
//   import { channelConnections } from "@euroclaw/channels/connections"  — user-registered bots (SSO analog)
//   import { telegram } from "@euroclaw/channels/telegram"               — providers

export {
	type ChannelsPlugin,
	type ChannelsPluginOptions,
	channels,
} from "./channels/plugin";
export {
	channelEndpointFields,
	channelsModels,
	channelsSchema,
} from "./channels/schema";
export {
	type ChannelEndpointStateRecord,
	type ChannelEndpointStateStore,
	createChannelEndpointStateStore,
} from "./channels/store";
export { type ClawLike, requireClaw } from "./core/claw";
export type {
	Channel,
	ChannelEndpointMode,
	EndpointContext,
	EndpointEvent,
	InboundMessage,
	InboundRequest,
	OutboundMessage,
	PersistEndpointEvent,
} from "./core/contracts";
export {
	APP_ENDPOINT_KEY,
	channelEndpointModeValues,
} from "./core/contracts";
export {
	type ChannelDispatchResult,
	dispatchWebhook,
	handleInbound,
	pollEndpoint,
} from "./core/dispatch";
export { endpointId } from "./core/id";
