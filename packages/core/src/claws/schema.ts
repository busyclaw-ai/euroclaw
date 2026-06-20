import { type } from "arktype";
import { entity, field } from "../entity";

export const clawStatusValues = ["active", "paused", "archived"] as const;
export const threadStatusValues = ["active", "archived"] as const;
export const messageRoleValues = [
	"system",
	"user",
	"assistant",
	"tool",
	"summary",
] as const;
export const messageVisibilityValues = [
	"user",
	"internal",
	"audit-only",
] as const;
export const toolCallStatusValues = [
	"proposed",
	"waiting_approval",
	"running",
	"completed",
	"denied",
	"failed",
] as const;
export const toolResultStatusValues = ["completed", "failed"] as const;
export const toolResultOutputModeValues = ["none", "redacted", "full"] as const;
export const checkpointKindValues = [
	"step",
	"approval_wait",
	"compaction",
	"replay",
	"fork",
] as const;
export const channelEndpointModeValues = ["webhook", "poll"] as const;
export const channelEndpointStatusValues = [
	"pending",
	"provisioned",
	"validated",
	"disabled",
	"expired",
	"error",
] as const;

export const clawStatus = type("'active' | 'paused' | 'archived'");
export const threadStatus = type("'active' | 'archived'");
export const messageRole = type(
	"'system' | 'user' | 'assistant' | 'tool' | 'summary'",
);
export const messageVisibility = type("'user' | 'internal' | 'audit-only'");
export const toolCallStatus = type(
	"'proposed' | 'waiting_approval' | 'running' | 'completed' | 'denied' | 'failed'",
);
export const toolResultStatus = type("'completed' | 'failed'");
export const toolResultOutputMode = type("'none' | 'redacted' | 'full'");
export const checkpointKind = type(
	"'step' | 'approval_wait' | 'compaction' | 'replay' | 'fork'",
);
export const channelEndpointMode = type("'webhook' | 'poll'");
export const channelEndpointStatus = type(
	"'pending' | 'provisioned' | 'validated' | 'disabled' | 'expired' | 'error'",
);

export const clawFields = {
	id: field.string({ required: true, unique: true }),
	tenantId: field.string({ required: true, index: true }),
	teamId: field.string({ index: true }),
	ownerActorId: field.string({ index: true }),
	status: field.enum(clawStatusValues, { required: true }),
	name: field.string(),
	instructions: field.string({ pii: "possible" }),
	context: field.jsonObject({ required: true }),
	memoryNamespace: field.string(),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const threadFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	tenantId: field.string({ required: true, index: true }),
	teamId: field.string({ index: true }),
	ownerActorId: field.string({ index: true }),
	title: field.string(),
	status: field.enum(threadStatusValues, { required: true }),
	currentMessageId: field.string(),
	currentSequence: field.number({ required: true }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const messageFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ index: true }),
	parentMessageId: field.string({ index: true }),
	sequence: field.number({ required: true, index: true }),
	role: field.enum(messageRoleValues, { required: true }),
	content: field.jsonValue({ required: true, pii: "redacted" }),
	visibility: field.enum(messageVisibilityValues, { required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const toolCallFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ required: true, index: true }),
	assistantMessageId: field.string({ index: true }),
	toolCallId: field.string({ required: true, index: true }),
	toolName: field.string({ required: true, index: true }),
	args: field.jsonObject({ required: true, pii: "redacted" }),
	status: field.enum(toolCallStatusValues, { required: true, index: true }),
	approvalId: field.string({ index: true }),
	effectId: field.string({ index: true }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const toolResultFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ required: true, index: true }),
	toolCallId: field.string({ required: true, index: true }),
	status: field.enum(toolResultStatusValues, { required: true }),
	output: field.jsonValue({ pii: "redacted" }),
	error: field.jsonObject({ pii: "redacted" }),
	outputMode: field.enum(toolResultOutputModeValues, { required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const checkpointFields = {
	id: field.string({ required: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	parentCheckpointId: field.string({ index: true }),
	kind: field.enum(checkpointKindValues, { required: true, index: true }),
	step: field.number(),
	state: field.jsonObject({ required: true, pii: "redacted" }),
	messageCursor: field.number(),
	toolCallId: field.string({ index: true }),
	createdAt: field.string({ required: true }),
} as const;

export const conversationBindingFields = {
	id: field.string({ required: true, unique: true }),
	provider: field.string({ required: true, index: true }),
	tenantId: field.string({ required: true, index: true }),
	externalConversationId: field.string({ required: true, index: true }),
	externalActorId: field.string({ index: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	metadata: field.jsonObject(),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const channelEndpointFields = {
	id: field.string({ required: true, unique: true }),
	provider: field.string({ required: true, index: true }),
	tenantId: field.string({ required: true, index: true }),
	endpointKey: field.string({ required: true, index: true }),
	mode: field.enum(channelEndpointModeValues, { required: true, index: true }),
	status: field.enum(channelEndpointStatusValues, {
		required: true,
		index: true,
	}),
	externalId: field.string({ index: true }),
	url: field.string(),
	secretRef: field.string({ pii: "possible" }),
	cursor: field.jsonValue({ pii: "possible" }),
	metadata: field.jsonObject(),
	lastError: field.jsonValue({ pii: "redacted" }),
	validatedAt: field.string({ index: true }),
	provisionedAt: field.string({ index: true }),
	expiresAt: field.string({ index: true }),
	lastReceivedAt: field.string({ index: true }),
	lastPolledAt: field.string({ index: true }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const clawEntity = entity("claw", clawFields);
export const threadEntity = entity("thread", threadFields);
export const messageEntity = entity("message", messageFields);
export const toolCallEntity = entity("tool_call", toolCallFields);
export const toolResultEntity = entity("tool_result", toolResultFields);
export const checkpointEntity = entity("checkpoint", checkpointFields);
export const conversationBindingEntity = entity(
	"conversation_binding",
	conversationBindingFields,
);
export const channelEndpointEntity = entity(
	"channel_endpoint",
	channelEndpointFields,
);

export const clawRecord = clawEntity.record;
export const threadRecord = threadEntity.record;
export const messageRecord = messageEntity.record;
export const toolCallRecord = toolCallEntity.record;
export const toolResultRecord = toolResultEntity.record;
export const checkpointRecord = checkpointEntity.record;
export const conversationBindingRecord = conversationBindingEntity.record;
export const channelEndpointRecord = channelEndpointEntity.record;

export const createClawInputOptions = {
	omit: ["status", "createdAt", "updatedAt"],
	optional: ["id", "context"],
} as const;
export const createClawInput = clawEntity.schema(createClawInputOptions);

export const createThreadInputOptions = {
	omit: [
		"status",
		"currentMessageId",
		"currentSequence",
		"createdAt",
		"updatedAt",
	],
	optional: ["id"],
} as const;
export const createThreadInput = threadEntity.schema(createThreadInputOptions);

export const appendMessageInputOptions = {
	omit: ["createdAt"],
	optional: ["id", "sequence", "visibility"],
} as const;
export const appendMessageInput = messageEntity.schema(
	appendMessageInputOptions,
);

export const createToolCallInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id", "status"],
} as const;
export const createToolCallInput = toolCallEntity.schema(
	createToolCallInputOptions,
);

export const createToolResultInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createToolResultInput = toolResultEntity.schema(
	createToolResultInputOptions,
);

export const createCheckpointInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createCheckpointInput = checkpointEntity.schema(
	createCheckpointInputOptions,
);

export const createConversationBindingInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id"],
} as const;
export const createConversationBindingInput = conversationBindingEntity.schema(
	createConversationBindingInputOptions,
);

export const createChannelEndpointInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id", "status"],
} as const;
export const createChannelEndpointInput = channelEndpointEntity.schema(
	createChannelEndpointInputOptions,
);

export const channelEndpointLookupInputOptions = {
	pick: ["provider", "tenantId", "endpointKey"],
} as const;
export const channelEndpointLookupInput = channelEndpointEntity.schema(
	channelEndpointLookupInputOptions,
);

export const updateChannelEndpointInputOptions = {
	pick: [
		"mode",
		"status",
		"externalId",
		"url",
		"secretRef",
		"cursor",
		"metadata",
		"lastError",
		"validatedAt",
		"provisionedAt",
		"expiresAt",
		"lastReceivedAt",
		"lastPolledAt",
	],
	optional: [
		"mode",
		"status",
		"externalId",
		"url",
		"secretRef",
		"cursor",
		"metadata",
		"lastError",
		"validatedAt",
		"provisionedAt",
		"expiresAt",
		"lastReceivedAt",
		"lastPolledAt",
	],
} as const;
export const updateChannelEndpointInput = channelEndpointEntity.schema(
	updateChannelEndpointInputOptions,
);

export const clawsSchema = {
	...clawEntity.storage,
	...threadEntity.storage,
	...messageEntity.storage,
	...toolCallEntity.storage,
	...toolResultEntity.storage,
	...checkpointEntity.storage,
	...conversationBindingEntity.storage,
	...channelEndpointEntity.storage,
};
