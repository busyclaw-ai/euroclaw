// @euroclaw/channels/connections — user-registered bots (the SSO analog): hosts let their users
// bring their OWN bots at runtime. Credentials live in the channel_connection row, the organization they
// belong to is row data (the organizationId analog), and every connection gets its own webhook URL.
export {
	type ChannelConnectionsApi,
	type ChannelConnectionsOptions,
	type ChannelConnectionsPlugin,
	type ChannelConnectionsPluginApi,
	channelConnections,
} from "./plugin";
export {
	channelConnectionFields,
	channelConnectionStatusValues,
	channelConnectionsModels,
	channelConnectionsSchema,
} from "./schema";
export {
	type ChannelConnectionListFilter,
	type ChannelConnectionLookup,
	type ChannelConnectionRecord,
	type ChannelConnectionStatus,
	type ChannelConnectionsStore,
	type ChannelConnectionsStoreOptions,
	createChannelConnectionsStore,
	type RegisterChannelConnectionInput,
} from "./store";
