import type { SchemaDeclaration } from "@euroclaw/contracts";
import { type EntityField, entity, field } from "@euroclaw/contracts";
import { channelEndpointModeValues } from "../core/contracts";

// A channel connection is a USER-registered bot — the ssoProvider analog: registered at runtime,
// credentials stored in the row and read back at use, with the organization it belongs to as optional row
// DATA (the organizationId analog), never part of transport identity.
export const channelConnectionStatusValues = ["active", "disabled"] as const;

export const channelConnectionFields = {
	// id = hash(provider, endpointKey): the natural key IS the primary key (see core/id.ts).
	id: field.string({ required: true, unique: true, immutable: true }),
	provider: field.string({ required: true, index: true, immutable: true }),
	endpointKey: field.string({ required: true, index: true, immutable: true }),
	mode: field.enum(channelEndpointModeValues, { required: true, index: true }),
	// Enforced at resolution: a disabled connection receives no webhooks and is skipped by the poll
	// fan-out. Revoke is soft — the row (and its audit trail) survives.
	status: field.enum(channelConnectionStatusValues, {
		required: true,
		index: true,
	}),
	// The egress credential (e.g. the bot token), stored in the row and read back at use time — the
	// sso `oidcConfig` model. `redacted` keeps it out of audit/exports; at-rest protection is the
	// host's database concern.
	secret: field.string({ pii: "redacted" }),
	// The INBOUND counterpart: what the provider's `verify` checks an incoming webhook against
	// (e.g. telegram's secret_token). Without it a registered webhook connection fails closed.
	webhookSecret: field.string({ pii: "redacted" }),
	// Whose bot this is — the organizationId analog. Merged into the claw bind defaults at dispatch.
	organizationId: field.string({ index: true }),
	// Bind defaults for conversations on this connection (sans organization — organizationId above wins). Validated
	// against the bindConversation claw/thread inputs when the context is assembled.
	claw: field.jsonObject({ pii: "possible" }),
	thread: field.jsonObject({ pii: "possible" }),
	cursor: field.jsonValue({ pii: "possible" }),
	lastError: field.jsonValue({ pii: "redacted" }),
	lastReceivedAt: field.string({ index: true }),
	lastPolledAt: field.string({ index: true }),
	createdAt: field.string({ required: true, immutable: true }),
	// Written by the store on every update, never caller-provided.
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const channelConnectionEntity = entity(
	"channel_connection",
	channelConnectionFields,
);
export const channelConnectionRecord = channelConnectionEntity.record;

// Registration input: transport identity + credentials + bind scope. State columns (cursor, errors,
// timestamps) and the derived id/status are the store's to write, not the caller's.
export const registerChannelConnectionInputOptions = {
	omit: [
		"id",
		"status",
		"cursor",
		"lastError",
		"lastReceivedAt",
		"lastPolledAt",
		"createdAt",
		"updatedAt",
	],
} as const;
export const registerChannelConnectionInput = channelConnectionEntity.schema(
	registerChannelConnectionInputOptions,
);

export const channelConnectionLookupInputOptions = {
	pick: ["provider", "endpointKey"],
} as const;
export const channelConnectionLookupInput = channelConnectionEntity.schema(
	channelConnectionLookupInputOptions,
);

// The update patch derives from the fields — every mutable column, all optional (identity and
// server-managed columns drop out via their flags).
export const updateChannelConnectionInput =
	channelConnectionEntity.updateSchema();

/** The models this plugin registers via `plugin.schema` — collected into migrations. */
export const channelConnectionsModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[channelConnectionEntity.name]: { fields: channelConnectionEntity.fields },
};

/** The storage view of the same table — what the connections store persists through. */
export const channelConnectionsSchema: SchemaDeclaration = {
	...channelConnectionEntity.storage,
};
