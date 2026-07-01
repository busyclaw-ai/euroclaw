import type {
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	ChannelEndpointLookup,
	ChannelEndpointRecord,
	CheckpointRecord,
	ClawRecord,
	ClawsStore,
	ConversationBindingRecord,
	CreateChannelEndpointInput,
	CreateCheckpointInput,
	CreateClawInput,
	CreateThreadInput,
	CreateToolCallInput,
	CreateToolResultInput,
	EffectStore,
	EuroclawPlugin,
	MessageRecord,
	ThreadRecord,
	ToolCallRecord,
	ToolCallStatusPatch,
	ToolResultRecord,
	UpdateChannelEndpointByKeyInput,
	UpdateClawInput,
} from "@euroclaw/contracts";
import {
	appendMessageInput,
	approvalStatus,
	channelEndpointLookupInput,
	clawEntity,
	clawRecord,
	configurationError,
	conversationBindingRecord,
	createChannelEndpointInput,
	createCheckpointInput,
	createClawInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	jsonObject,
	RESERVED_CONTEXT_PREFIX,
	stateError,
	threadEntity,
	threadRecord,
	toolCallEntity,
	updateChannelEndpointInput,
	validationError,
} from "@euroclaw/contracts";
import type {
	ClawEngineHandle,
	ClawRunReadModel,
	EngineContinueRunInput,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunRecord,
	EngineStartRunInput,
} from "@euroclaw/engine-core";
import {
	type RunContext,
	type Runtime,
	type RuntimeConfig,
	type RuntimeResult,
	type RuntimeRunOptions,
	recordingFromRuntimeApprovalMetadata,
	runtimeRunOptionsWithRecording,
} from "@euroclaw/runtime";
import { type as ark } from "arktype";
import type { ClawRecordOf, CreateClawInputOf } from "./models";

export type ClawSendInput<Config extends RuntimeConfig = RuntimeConfig> = {
	clawId: string;
	threadId: string;
	message: string;
	ctx?: RunContext<Config>;
	runId?: string;
};

export type ClawSendResult = {
	result: RuntimeResult;
	userMessage: MessageRecord;
};

export const clawCronHandlerSecretConfig = ark({
	"headerName?": "string | undefined",
	"limit?": "number | undefined",
	secret: "string",
});
export type ClawCronHandlerSecretConfig =
	typeof clawCronHandlerSecretConfig.infer;

export const clawCronHandlerUnsafeConfig = ark({
	"headerName?": "string | undefined",
	"limit?": "number | undefined",
	unsafeAllowUnauthenticated: "true",
});
export type ClawCronHandlerUnsafeConfig =
	typeof clawCronHandlerUnsafeConfig.infer;

export type ClawCronHandlerConfig =
	| false
	| ClawCronHandlerSecretConfig
	| ClawCronHandlerUnsafeConfig;

export type ClawContext<Config extends RuntimeConfig = RuntimeConfig> = {
	readonly runtime: Runtime<Config>;
	readonly clawsStore?: ClawsStore;
	readonly cronHandler?: ClawCronHandlerConfig;
	readonly effects?: EffectStore;
	readonly engine?: ClawEngineHandle;
	readonly runs?: ClawRunReadModel;
	readonly plugins?: readonly EuroclawPlugin[];
};

export type ClawApi<Config extends RuntimeConfig = RuntimeConfig> = {
	bindConversation: (
		input: BindConversationInput,
	) => Promise<BindConversationResult>;
	getChannelEndpoint: (
		input: ChannelEndpointLookup,
	) => Promise<ChannelEndpointRecord | null>;
	upsertChannelEndpoint: (
		input: CreateChannelEndpointInput,
	) => Promise<ChannelEndpointRecord>;
	updateChannelEndpoint: (
		input: UpdateChannelEndpointByKeyInput,
	) => Promise<ChannelEndpointRecord | null>;

	// Claw records are config-shaped: host `additionalFields` and plugin `schema` widen both the input
	// and the returned record. Extra fields aren't patchable yet, so `updateClaw` keeps the base patch.
	createClaw: (
		input: CreateClawInputOf<Config>,
	) => Promise<ClawRecordOf<Config>>;
	getClaw: (input: { id: string }) => Promise<ClawRecordOf<Config> | null>;
	updateClaw: (input: {
		id: string;
		patch: UpdateClawInput;
	}) => Promise<ClawRecordOf<Config> | null>;
	archiveClaw: (input: { id: string }) => Promise<ClawRecordOf<Config> | null>;

	createThread: (input: CreateThreadInput) => Promise<ThreadRecord>;
	getThread: (input: { id: string }) => Promise<ThreadRecord | null>;
	listThreads: (input: { clawId: string }) => Promise<ThreadRecord[]>;
	archiveThread: (input: { id: string }) => Promise<ThreadRecord | null>;

	appendMessage: (input: AppendMessageInput) => Promise<MessageRecord>;
	getMessage: (input: { id: string }) => Promise<MessageRecord | null>;
	listMessages: (input: {
		threadId: string;
		afterSequence?: number;
		limit?: number;
	}) => Promise<MessageRecord[]>;
	sendMessage: (input: ClawSendInput<Config>) => Promise<ClawSendResult>;

	createToolCall: (input: CreateToolCallInput) => Promise<ToolCallRecord>;
	getToolCall: (input: { id: string }) => Promise<ToolCallRecord | null>;
	getToolCallByProviderId: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolCallRecord | null>;
	updateToolCallStatus: (input: {
		id: string;
		patch: ToolCallStatusPatch;
	}) => Promise<ToolCallRecord | null>;

	createToolResult: (input: CreateToolResultInput) => Promise<ToolResultRecord>;
	getToolResult: (input: { id: string }) => Promise<ToolResultRecord | null>;
	listToolResults: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolResultRecord[]>;

	createCheckpoint: (input: CreateCheckpointInput) => Promise<CheckpointRecord>;
	getCheckpoint: (input: { id: string }) => Promise<CheckpointRecord | null>;
	getLatestCheckpoint: (input: {
		runId: string;
	}) => Promise<CheckpointRecord | null>;

	run: (input: {
		prompt: string;
		ctx?: RunContext<Config>;
		options?: RuntimeRunOptions;
	}) => Promise<RuntimeResult>;
	continueRun: (input: {
		approvalId: string;
		ctx?: RunContext<Config>;
		options?: RuntimeRunOptions;
	}) => Promise<RuntimeResult | null>;

	grantApproval: (input: {
		approvalId: string;
		by: string;
	}) => Promise<ApprovalRecord | null>;
	denyApproval: (input: {
		approvalId: string;
		by: string;
		reason?: string;
	}) => Promise<ApprovalRecord | null>;
	getApproval: (input: { id: string }) => Promise<ApprovalRecord | null>;
	listApprovals: (input?: {
		status?: ApprovalStatus;
		actor?: string;
	}) => Promise<ApprovalRecord[]>;

	getEffect: (input: { id: string }) => ReturnType<EffectStore["get"]>;

	startRun: (input: EngineStartRunInput) => Promise<EngineRunHandle>;
	continueEngineRun: (
		input: EngineContinueRunInput,
	) => Promise<EngineRunHandle>;
	getRun: (input: { id: string }) => Promise<EngineRunRecord | null>;
	listRunEvents: (input: { runId: string }) => Promise<EngineRunEvent[]>;
};

export type ClawApiMethod = keyof ClawApi;
export type ClawApiHttpMethod = "GET" | "POST";
export type ClawApiInputSchema = (input: unknown) => unknown;
export type ClawApiRouteDefinition<
	Method extends ClawApiMethod = ClawApiMethod,
> = {
	apiMethod: Method;
	httpMethod: ClawApiHttpMethod;
	path: `/${string}`;
	inputSchema: ClawApiInputSchema;
};

const idInput = ark({ id: "string" });
const clawIdInput = ark({ clawId: "string" });
const runIdInput = ark({ runId: "string" });
const runToolCallInput = ark({ runId: "string", toolCallId: "string" });
const jsonObjectOrUndefined = jsonObject.or("undefined");
const runtimeAbortSignalInput = ark({ aborted: "boolean" });
const runtimeRunOptionsInput = ark({
	"abortSignal?": runtimeAbortSignalInput.or("undefined"),
});
const runtimeRunOptionsOrUndefined = runtimeRunOptionsInput.or("undefined");
const engineRunMetadataInput = ark({
	"actor?": "string | undefined",
	"id?": "string | undefined",
	"team?": "string | undefined",
});
const engineRunMetadataOrUndefined = engineRunMetadataInput.or("undefined");
const updateClawPatchInput = clawEntity.schema({
	optional: ["status", "name", "instructions", "context", "memoryNamespace"],
	pick: ["status", "name", "instructions", "context", "memoryNamespace"],
});
const toolCallStatusPatchInput = toolCallEntity.schema({
	optional: ["status", "approvalId", "effectId", "updatedAt"],
	pick: ["status", "approvalId", "effectId", "updatedAt"],
});
export const bindConversationClawInput = clawEntity.schema({
	omit: ["tenantId", "status", "createdAt", "updatedAt"],
	optional: ["id", "context"],
});
export type BindConversationClawInput = Omit<CreateClawInput, "tenantId">;

export const bindConversationThreadInput = threadEntity.schema({
	omit: [
		"clawId",
		"tenantId",
		"status",
		"currentMessageId",
		"currentSequence",
		"createdAt",
		"updatedAt",
	],
	optional: ["id"],
});
export type BindConversationThreadInput = Omit<
	CreateThreadInput,
	"clawId" | "tenantId"
>;
const listMessagesInput = ark({
	"afterSequence?": "number | undefined",
	"limit?": "number | undefined",
	threadId: "string",
});
const sendMessageInput = ark({
	clawId: "string",
	"ctx?": jsonObjectOrUndefined,
	message: "string",
	"runId?": "string | undefined",
	threadId: "string",
});
const runInput = ark({
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
	prompt: "string",
});
const continueRunInput = ark({
	approvalId: "string",
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
});
const grantApprovalInput = ark({ approvalId: "string", by: "string" });
const denyApprovalInput = ark({
	approvalId: "string",
	by: "string",
	"reason?": "string | undefined",
});
const listApprovalsInput = ark({
	"actor?": "string | undefined",
	"status?": approvalStatus.or("undefined"),
});
const startRunInput = ark({
	"ctx?": jsonObjectOrUndefined,
	prompt: "string",
	"run?": engineRunMetadataOrUndefined,
});
const continueEngineRunInput = ark({
	approvalId: "string",
	"ctx?": jsonObjectOrUndefined,
	"run?": engineRunMetadataOrUndefined,
});
export const bindConversationInput = ark({
	"claw?": bindConversationClawInput.or("undefined"),
	"clawId?": "string | undefined",
	"externalActorId?": "string | undefined",
	externalConversationId: "string",
	"metadata?": jsonObjectOrUndefined,
	provider: "string",
	tenantId: "string",
	"thread?": bindConversationThreadInput.or("undefined"),
	"threadId?": "string | undefined",
});
type BindConversationInputFromSchema = typeof bindConversationInput.infer;
export type BindConversationInput = Omit<
	BindConversationInputFromSchema,
	"claw" | "thread"
> & {
	claw?: BindConversationClawInput;
	thread?: BindConversationThreadInput;
};

export const bindConversationResult = ark({
	binding: conversationBindingRecord,
	claw: clawRecord,
	created: "boolean",
	thread: threadRecord,
});
type BindConversationResultFromSchema = typeof bindConversationResult.infer;
export type BindConversationResult = Omit<
	BindConversationResultFromSchema,
	"binding" | "claw" | "thread"
> & {
	binding: ConversationBindingRecord;
	claw: ClawRecord;
	thread: ThreadRecord;
};

const updateChannelEndpointByKeyInput = ark({
	endpointKey: "string",
	patch: updateChannelEndpointInput,
	provider: "string",
	tenantId: "string",
});

export const clawApiInputSchemas = {
	bindConversation: bindConversationInput,
	getChannelEndpoint: channelEndpointLookupInput,
	updateChannelEndpoint: updateChannelEndpointByKeyInput,
	upsertChannelEndpoint: createChannelEndpointInput,
	appendMessage: appendMessageInput,
	archiveClaw: idInput,
	archiveThread: idInput,
	continueEngineRun: continueEngineRunInput,
	continueRun: continueRunInput,
	createCheckpoint: createCheckpointInput,
	createClaw: createClawInput,
	createThread: createThreadInput,
	createToolCall: createToolCallInput,
	createToolResult: createToolResultInput,
	denyApproval: denyApprovalInput,
	getApproval: idInput,
	getCheckpoint: idInput,
	getClaw: idInput,
	getEffect: idInput,
	getLatestCheckpoint: runIdInput,
	getMessage: idInput,
	getRun: idInput,
	getThread: idInput,
	getToolCall: idInput,
	getToolCallByProviderId: runToolCallInput,
	getToolResult: idInput,
	grantApproval: grantApprovalInput,
	listApprovals: listApprovalsInput,
	listMessages: listMessagesInput,
	listRunEvents: runIdInput,
	listThreads: clawIdInput,
	listToolResults: runToolCallInput,
	run: runInput,
	sendMessage: sendMessageInput,
	startRun: startRunInput,
	updateClaw: ark({ id: "string", patch: updateClawPatchInput }),
	updateToolCallStatus: ark({ id: "string", patch: toolCallStatusPatchInput }),
} satisfies { readonly [Method in ClawApiMethod]: ClawApiInputSchema };

function apiMethodPath(method: ClawApiMethod): `/${string}` {
	return `/${method.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function apiHttpMethod(method: ClawApiMethod): ClawApiHttpMethod {
	return method.startsWith("get") || method.startsWith("list") ? "GET" : "POST";
}

function apiRoute<Method extends ClawApiMethod>(
	method: Method,
): ClawApiRouteDefinition<Method> {
	return {
		apiMethod: method,
		httpMethod: apiHttpMethod(method),
		path: apiMethodPath(method),
		inputSchema: clawApiInputSchemas[method],
	};
}

export const clawApiRoutes = Object.fromEntries(
	(Object.keys(clawApiInputSchemas) as ClawApiMethod[]).map((method) => [
		method,
		apiRoute(method),
	]),
) as { readonly [Method in ClawApiMethod]: ClawApiRouteDefinition<Method> };

export const clawApiRouteList = Object.values(clawApiRoutes);

export function parseClawApiInput(method: string, input: unknown): unknown {
	const route = (clawApiRoutes as Record<string, ClawApiRouteDefinition>)[
		method
	];
	if (!route) {
		throw validationError("claw.api input", `unknown api method: ${method}`, {
			method,
		});
	}
	const valid = route.inputSchema(input);
	if (valid instanceof ark.errors) {
		throw validationError(`claw.api.${method} input`, valid.summary, {
			method,
		});
	}
	return valid;
}

function requireClawsStore(store: ClawsStore | undefined): ClawsStore {
	if (!store) {
		throw configurationError("claw.api requires a ClawsStore", {
			reason: "pass database or stores.claws to createClaw",
		});
	}
	return store;
}

function requireEngine(engine: ClawEngineHandle | undefined): ClawEngineHandle {
	if (!engine) {
		throw configurationError("claw.api requires an engine", {
			reason: "pass engine to createClaw",
		});
	}
	return engine;
}

function requireRuns(runs: ClawRunReadModel | undefined): ClawRunReadModel {
	if (!runs) {
		throw configurationError("claw.api requires a run read model", {
			reason: "pass an engine that exposes runs to createClaw",
		});
	}
	return runs;
}

function requireEffects(effects: EffectStore | undefined): EffectStore {
	if (!effects) {
		throw configurationError("claw.api requires an EffectStore", {
			reason: "pass database or stores.effects to createClaw",
		});
	}
	return effects;
}

function assertNoReservedContext(ctx: unknown): void {
	if (ctx === undefined || ctx === null || typeof ctx !== "object") return;
	for (const key of Object.keys(ctx)) {
		if (key.startsWith(RESERVED_CONTEXT_PREFIX)) {
			throw validationError(
				"claw.api context invalid",
				`reserved context key is not accepted: ${key}`,
				{ key },
			);
		}
	}
}

async function requireClawRecord(
	store: ClawsStore,
	id: string,
): Promise<ClawRecord> {
	const claw = await store.claws.get(id);
	if (!claw) throw stateError("claw not found", { id });
	return claw;
}

async function requireThreadRecord(
	store: ClawsStore,
	id: string,
): Promise<ThreadRecord> {
	const thread = await store.threads.get(id);
	if (!thread) throw stateError("thread not found", { id });
	return thread;
}

async function conversationBindingResult(input: {
	store: ClawsStore;
	binding: ConversationBindingRecord;
	created: boolean;
}): Promise<BindConversationResult> {
	const claw = await requireClawRecord(input.store, input.binding.clawId);
	const thread = await requireThreadRecord(input.store, input.binding.threadId);
	const result = {
		binding: input.binding,
		claw,
		created: input.created,
		thread,
	} satisfies BindConversationResult;
	const valid = bindConversationResult(result);
	if (valid instanceof ark.errors) {
		throw validationError("bind conversation result invalid", valid.summary);
	}
	return result;
}

export function createClawApi<Config extends RuntimeConfig>(input: {
	context: ClawContext<Config>;
	newId: (prefix: string) => string;
}): ClawApi<Config> {
	const { context, newId } = input;
	const store = () => requireClawsStore(context.clawsStore);

	const api = {
		async bindConversation(args) {
			const clawsStore = store();
			const existing = await clawsStore.conversationBindings.getByExternal({
				provider: args.provider,
				tenantId: args.tenantId,
				externalConversationId: args.externalConversationId,
			});
			if (existing) {
				return conversationBindingResult({
					binding: existing,
					created: false,
					store: clawsStore,
				});
			}

			const existingThread = args.threadId
				? await requireThreadRecord(clawsStore, args.threadId)
				: undefined;
			const claw = args.clawId
				? await requireClawRecord(clawsStore, args.clawId)
				: existingThread
					? await requireClawRecord(clawsStore, existingThread.clawId)
					: await clawsStore.claws.create({
							...(args.claw ?? {}),
							ownerActorId: args.claw?.ownerActorId ?? args.externalActorId,
							tenantId: args.tenantId,
						});

			if (claw.tenantId !== args.tenantId) {
				throw validationError(
					"bind conversation input invalid",
					"claw tenantId does not match conversation tenantId",
					{ clawTenantId: claw.tenantId, tenantId: args.tenantId },
				);
			}

			const thread = existingThread
				? existingThread
				: await clawsStore.threads.create({
						...(args.thread ?? {}),
						clawId: claw.id,
						ownerActorId: args.thread?.ownerActorId ?? args.externalActorId,
						teamId: args.thread?.teamId ?? claw.teamId,
						tenantId: args.tenantId,
					});

			if (thread.clawId !== claw.id || thread.tenantId !== args.tenantId) {
				throw validationError(
					"bind conversation input invalid",
					"thread does not match conversation claw or tenant",
					{
						clawId: claw.id,
						threadClawId: thread.clawId,
						threadTenantId: thread.tenantId,
						tenantId: args.tenantId,
					},
				);
			}

			const binding = await clawsStore.conversationBindings.create({
				provider: args.provider,
				tenantId: args.tenantId,
				externalConversationId: args.externalConversationId,
				externalActorId: args.externalActorId,
				clawId: claw.id,
				threadId: thread.id,
				metadata: args.metadata,
			});
			return { binding, claw, thread, created: true };
		},

		getChannelEndpoint: (args) => store().channelEndpoints.getByKey(args),
		upsertChannelEndpoint: (args) => store().channelEndpoints.upsert(args),
		updateChannelEndpoint: (args) => store().channelEndpoints.updateByKey(args),

		createClaw: (args) => store().claws.create(args),
		getClaw: ({ id }) => store().claws.get(id),
		updateClaw: ({ id, patch }) => store().claws.update(id, patch),
		archiveClaw: ({ id }) => store().claws.archive(id),

		createThread: (args) => store().threads.create(args),
		getThread: ({ id }) => store().threads.get(id),
		listThreads: ({ clawId }) => store().threads.listForClaw(clawId),
		archiveThread: ({ id }) => store().threads.archive(id),

		appendMessage: (args) => store().messages.append(args),
		getMessage: ({ id }) => store().messages.get(id),
		listMessages: (args) => store().messages.listForThread(args),

		async sendMessage(args) {
			assertNoReservedContext(args.ctx);
			const clawsStore = store();
			const runId = args.runId ?? newId("run");
			const userMessage = await clawsStore.messages.append({
				clawId: args.clawId,
				content: { text: args.message },
				runId,
				role: "user",
				threadId: args.threadId,
				visibility: "user",
			});
			const result = await context.runtime.run(
				args.message,
				args.ctx as never,
				runtimeRunOptionsWithRecording(undefined, {
					clawId: args.clawId,
					runId,
					threadId: args.threadId,
					userMessageId: userMessage.id,
				}),
			);
			return { result, userMessage };
		},

		createToolCall: (args) => store().toolCalls.create(args),
		getToolCall: ({ id }) => store().toolCalls.get(id),
		getToolCallByProviderId: (args) => store().toolCalls.getByToolCallId(args),
		updateToolCallStatus: ({ id, patch }) =>
			store().toolCalls.updateStatus(id, patch),

		createToolResult: (args) => store().toolResults.create(args),
		getToolResult: ({ id }) => store().toolResults.get(id),
		listToolResults: (args) => store().toolResults.listForToolCall(args),

		createCheckpoint: (args) => store().checkpoints.create(args),
		getCheckpoint: ({ id }) => store().checkpoints.get(id),
		getLatestCheckpoint: ({ runId }) => store().checkpoints.latestForRun(runId),

		run: ({ prompt, ctx, options }) => {
			assertNoReservedContext(ctx);
			return context.runtime.run(prompt, ctx as never, options);
		},
		async continueRun({ approvalId, ctx, options }) {
			assertNoReservedContext(ctx);
			const approval = await context.runtime.approvals?.get(approvalId);
			const recording = approval
				? recordingFromRuntimeApprovalMetadata(approval.metadata)
				: undefined;
			if (!recording) {
				return context.runtime.continueRun(approvalId, ctx as never, options);
			}
			return context.runtime.continueRun(
				approvalId,
				ctx as never,
				runtimeRunOptionsWithRecording(options, recording),
			);
		},

		grantApproval: ({ approvalId, by }) =>
			context.runtime.approvals?.grant(approvalId, by) ?? Promise.resolve(null),
		denyApproval: ({ approvalId, by, reason }) =>
			context.runtime.approvals?.deny(approvalId, by, reason) ??
			Promise.resolve(null),
		getApproval: ({ id }) =>
			context.runtime.approvals?.get(id) ?? Promise.resolve(null),
		listApprovals: (args) =>
			context.runtime.approvals?.list(args) ?? Promise.resolve([]),

		getEffect: ({ id }) => requireEffects(context.effects).get(id),

		startRun: (args) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).startRun(args);
		},
		continueEngineRun: (args) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).continueRun(args);
		},
		getRun: ({ id }) => requireRuns(context.runs).get(id),
		listRunEvents: ({ runId }) => requireRuns(context.runs).events(runId),
	} satisfies ClawApi;

	// The claws store is typed against the base claw contract, but at runtime it persists and returns
	// the host/plugin columns merged onto the claw model (see createClawsStore.additionalFields).
	// Re-present those through the config-derived claw types — the single seam between the base-typed
	// store and the config-shaped public api.
	return api as unknown as ClawApi<Config>;
}
