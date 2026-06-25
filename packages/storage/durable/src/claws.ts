import {
	type AppendMessageInput,
	appendMessageInput,
	type ChannelEndpointLookup,
	type ChannelEndpointRecord,
	type CheckpointRecord,
	type ClawRecord,
	type ClawsStore,
	type ConversationBindingRecord,
	type CreateChannelEndpointInput,
	type CreateCheckpointInput,
	type CreateClawInput,
	type CreateConversationBindingInput,
	type CreateThreadInput,
	type CreateToolCallInput,
	type CreateToolResultInput,
	channelEndpointLookupInput,
	channelEndpointRecord,
	checkpointRecord,
	clawRecord,
	clawsSchema,
	conversationBindingRecord,
	createChannelEndpointInput,
	createCheckpointInput,
	createClawInput,
	createConversationBindingInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	type MessageRecord,
	messageRecord,
	type ThreadRecord,
	type ToolCallRecord,
	type ToolResultRecord,
	threadRecord,
	toolCallRecord,
	toolResultRecord,
	type UpdateChannelEndpointByKeyInput,
	type UpdateChannelEndpointInput,
	updateChannelEndpointInput,
} from "@euroclaw/core";
import {
	configurationError,
	stateError,
	validationError,
} from "@euroclaw/errors";
import {
	type Adapter,
	schemaAdapter,
	type Where,
} from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type ClawsStoreOptions = {
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

const newId = (): string => bytesToHex(randomBytes(16));

function assertCreateClawInput(input: unknown): CreateClawInput {
	const valid = createClawInput(input) as CreateClawInput | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create claw input invalid", valid.summary);
	}
	return valid;
}

function assertClawRecord(input: unknown): ClawRecord {
	const valid = clawRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("claw record invalid", valid.summary);
	}
	return valid;
}

function assertCreateThreadInput(input: unknown): CreateThreadInput {
	const valid = createThreadInput(input) as CreateThreadInput | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create thread input invalid", valid.summary);
	}
	return valid;
}

function assertThreadRecord(input: unknown): ThreadRecord {
	const valid = threadRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("thread record invalid", valid.summary);
	}
	return valid;
}

function assertAppendMessageInput(input: unknown): AppendMessageInput {
	const valid = appendMessageInput(input) as AppendMessageInput | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("append message input invalid", valid.summary);
	}
	return valid;
}

function assertMessageRecord(input: unknown): MessageRecord {
	const valid = messageRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("message record invalid", valid.summary);
	}
	return valid;
}

function assertCreateToolCallInput(input: unknown): CreateToolCallInput {
	const valid = createToolCallInput(input) as CreateToolCallInput | type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create tool call input invalid", valid.summary);
	}
	return valid;
}

function assertToolCallRecord(input: unknown): ToolCallRecord {
	const valid = toolCallRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("tool call record invalid", valid.summary);
	}
	return valid;
}

function assertCreateToolResultInput(input: unknown): CreateToolResultInput {
	const valid = createToolResultInput(input) as
		| CreateToolResultInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create tool result input invalid", valid.summary);
	}
	return valid;
}

function assertToolResultRecord(input: unknown): ToolResultRecord {
	const valid = toolResultRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("tool result record invalid", valid.summary);
	}
	return valid;
}

function assertCreateCheckpointInput(input: unknown): CreateCheckpointInput {
	const valid = createCheckpointInput(input) as
		| CreateCheckpointInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create checkpoint input invalid", valid.summary);
	}
	return valid;
}

function assertCheckpointRecord(input: unknown): CheckpointRecord {
	const valid = checkpointRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("checkpoint record invalid", valid.summary);
	}
	return valid;
}

function assertCreateConversationBindingInput(
	input: unknown,
): CreateConversationBindingInput {
	const valid = createConversationBindingInput(input) as
		| CreateConversationBindingInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError(
			"create conversation binding input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertConversationBindingRecord(
	input: unknown,
): ConversationBindingRecord {
	const valid = conversationBindingRecord(input) as
		| ConversationBindingRecord
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("conversation binding record invalid", valid.summary);
	}
	return valid;
}

function assertCreateChannelEndpointInput(
	input: unknown,
): CreateChannelEndpointInput {
	const valid = createChannelEndpointInput(input) as
		| CreateChannelEndpointInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError(
			"create channel endpoint input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertChannelEndpointLookup(input: unknown): ChannelEndpointLookup {
	const valid = channelEndpointLookupInput(input) as
		| ChannelEndpointLookup
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("channel endpoint lookup invalid", valid.summary);
	}
	return valid;
}

function assertUpdateChannelEndpointInput(
	input: unknown,
): UpdateChannelEndpointInput {
	const valid = updateChannelEndpointInput(input) as
		| UpdateChannelEndpointInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError(
			"update channel endpoint input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertChannelEndpointRecord(input: unknown): ChannelEndpointRecord {
	const valid = channelEndpointRecord(input) as
		| ChannelEndpointRecord
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("channel endpoint record invalid", valid.summary);
	}
	return valid;
}

function channelEndpointWhere(input: ChannelEndpointLookup): Where[] {
	return [
		{ field: "provider", value: input.provider },
		{ field: "tenantId", value: input.tenantId, connector: "AND" },
		{ field: "endpointKey", value: input.endpointKey, connector: "AND" },
	];
}

function channelEndpointPatchFromCreate(
	input: CreateChannelEndpointInput,
): UpdateChannelEndpointInput {
	const patch: UpdateChannelEndpointInput = { mode: input.mode };
	if (input.status !== undefined) patch.status = input.status;
	if (input.externalId !== undefined) patch.externalId = input.externalId;
	if (input.url !== undefined) patch.url = input.url;
	if (input.secretRef !== undefined) patch.secretRef = input.secretRef;
	if (input.cursor !== undefined) patch.cursor = input.cursor;
	if (input.metadata !== undefined) patch.metadata = input.metadata;
	if (input.lastError !== undefined) patch.lastError = input.lastError;
	if (input.validatedAt !== undefined) patch.validatedAt = input.validatedAt;
	if (input.provisionedAt !== undefined)
		patch.provisionedAt = input.provisionedAt;
	if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
	if (input.lastReceivedAt !== undefined)
		patch.lastReceivedAt = input.lastReceivedAt;
	if (input.lastPolledAt !== undefined) patch.lastPolledAt = input.lastPolledAt;
	return patch;
}

export function createClawsStore(
	adapter: Adapter,
	options: ClawsStoreOptions = {},
): ClawsStore {
	const now = options.now ?? (() => new Date().toISOString());
	const db = schemaAdapter(adapter, clawsSchema);

	return {
		channelEndpoints: {
			async create(input) {
				const valid = assertCreateChannelEndpointInput(input);
				const ts = now();
				const record = assertChannelEndpointRecord({
					id: valid.id ?? newId(),
					provider: valid.provider,
					tenantId: valid.tenantId,
					endpointKey: valid.endpointKey,
					mode: valid.mode,
					status: valid.status ?? "pending",
					externalId: valid.externalId,
					url: valid.url,
					secretRef: valid.secretRef,
					cursor: valid.cursor,
					metadata: valid.metadata,
					lastError: valid.lastError,
					validatedAt: valid.validatedAt,
					provisionedAt: valid.provisionedAt,
					expiresAt: valid.expiresAt,
					lastReceivedAt: valid.lastReceivedAt,
					lastPolledAt: valid.lastPolledAt,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "channel_endpoint", data: record });
				return record;
			},

			async upsert(input) {
				const valid = assertCreateChannelEndpointInput(input);
				const lookup = {
					endpointKey: valid.endpointKey,
					provider: valid.provider,
					tenantId: valid.tenantId,
				};
				const existing = await this.getByKey(lookup);
				if (!existing) return this.create(valid);
				const updated = await this.updateByKey({
					...lookup,
					patch: channelEndpointPatchFromCreate(valid),
				});
				return updated ?? existing;
			},

			get(id) {
				return db.findOne<ChannelEndpointRecord>({
					model: "channel_endpoint",
					where: [{ field: "id", value: id }],
				});
			},

			getByKey(input) {
				const lookup = assertChannelEndpointLookup(input);
				return db.findOne<ChannelEndpointRecord>({
					model: "channel_endpoint",
					where: channelEndpointWhere(lookup),
				});
			},

			async updateByKey(input: UpdateChannelEndpointByKeyInput) {
				const lookup = assertChannelEndpointLookup({
					endpointKey: input.endpointKey,
					provider: input.provider,
					tenantId: input.tenantId,
				});
				const patch = assertUpdateChannelEndpointInput(input.patch);
				const row = await db.update<ChannelEndpointRecord>({
					model: "channel_endpoint",
					where: channelEndpointWhere(lookup),
					update: { ...patch, updatedAt: now() },
				});
				return row ? assertChannelEndpointRecord(row) : null;
			},
		},

		claws: {
			async create(input) {
				const valid = assertCreateClawInput(input);
				const ts = now();
				const record = assertClawRecord({
					id: valid.id ?? newId(),
					tenantId: valid.tenantId,
					teamId: valid.teamId,
					ownerActorId: valid.ownerActorId,
					status: "active",
					name: valid.name,
					instructions: valid.instructions,
					context: valid.context ?? {},
					memoryNamespace: valid.memoryNamespace,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "claw", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ClawRecord>({
					model: "claw",
					where: [{ field: "id", value: id }],
				});
			},

			async update(id, patch) {
				const update: Record<string, unknown> = { updatedAt: now() };
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.name !== undefined) update.name = patch.name;
				if (patch.instructions !== undefined)
					update.instructions = patch.instructions;
				if (patch.context !== undefined) update.context = patch.context;
				if (patch.memoryNamespace !== undefined)
					update.memoryNamespace = patch.memoryNamespace;

				const row = await db.update<ClawRecord>({
					model: "claw",
					where: [{ field: "id", value: id }],
					update,
				});
				return row ? assertClawRecord(row) : null;
			},

			archive(id) {
				return this.update(id, {
					status: "archived",
				});
			},
		},

		threads: {
			async create(input) {
				const valid = assertCreateThreadInput(input);
				const ts = now();
				const record = assertThreadRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					tenantId: valid.tenantId,
					teamId: valid.teamId,
					ownerActorId: valid.ownerActorId,
					title: valid.title,
					status: "active",
					currentSequence: 0,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "thread", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ThreadRecord>({
					model: "thread",
					where: [{ field: "id", value: id }],
				});
			},

			listForClaw(clawId) {
				return db.findMany<ThreadRecord>({
					model: "thread",
					where: [{ field: "clawId", value: clawId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			archive(id) {
				return db.update<ThreadRecord>({
					model: "thread",
					where: [{ field: "id", value: id }],
					update: { status: "archived", updatedAt: now() },
				});
			},
		},

		messages: {
			async append(input) {
				const valid = assertAppendMessageInput(input);
				if (!adapter.transaction) {
					throw configurationError(
						"ClawsStore message append requires a transactional adapter",
						{ adapter: adapter.id },
					);
				}

				return adapter.transaction(async (tx) => {
					const txDb = schemaAdapter(tx, clawsSchema);
					const thread = await txDb.findOne<ThreadRecord>({
						model: "thread",
						where: [{ field: "id", value: valid.threadId }],
					});
					if (!thread) {
						throw stateError("thread not found", { threadId: valid.threadId });
					}
					if (thread.clawId !== valid.clawId) {
						throw validationError(
							"append message input invalid",
							"clawId does not match thread",
							{ clawId: valid.clawId, threadClawId: thread.clawId },
						);
					}

					const sequence = valid.sequence ?? thread.currentSequence + 1;
					if (sequence !== thread.currentSequence + 1) {
						throw validationError(
							"append message input invalid",
							"must append at current thread cursor",
							{
								currentSequence: thread.currentSequence,
								sequence,
							},
						);
					}

					const ts = now();
					const record = assertMessageRecord({
						id: valid.id ?? newId(),
						clawId: valid.clawId,
						threadId: valid.threadId,
						runId: valid.runId,
						parentMessageId: valid.parentMessageId ?? thread.currentMessageId,
						sequence,
						role: valid.role,
						content: valid.content,
						visibility: valid.visibility ?? "user",
						createdAt: ts,
					});

					await txDb.create({ model: "message", data: record });
					const updatedThread = await txDb.update<ThreadRecord>({
						model: "thread",
						where: [
							{ field: "id", value: valid.threadId },
							{
								field: "currentSequence",
								value: thread.currentSequence,
								connector: "AND",
							},
						],
						update: {
							currentMessageId: record.id,
							currentSequence: sequence,
							updatedAt: ts,
						},
					});
					if (!updatedThread) {
						throw stateError("thread cursor changed during append", {
							threadId: valid.threadId,
						});
					}
					return record;
				});
			},

			get(id) {
				return db.findOne<MessageRecord>({
					model: "message",
					where: [{ field: "id", value: id }],
				});
			},

			listForThread(input) {
				const where: Where[] = [{ field: "threadId", value: input.threadId }];
				if (input.afterSequence !== undefined) {
					where.push({
						field: "sequence",
						operator: "gt",
						value: input.afterSequence,
						connector: "AND",
					});
				}
				return db.findMany<MessageRecord>({
					model: "message",
					where,
					limit: input.limit,
					sortBy: { field: "sequence", direction: "asc" },
				});
			},
		},

		toolCalls: {
			async create(input) {
				const valid = assertCreateToolCallInput(input);
				const ts = now();
				const record = assertToolCallRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					assistantMessageId: valid.assistantMessageId,
					toolCallId: valid.toolCallId,
					toolName: valid.toolName,
					args: valid.args,
					status: valid.status ?? "proposed",
					approvalId: valid.approvalId,
					effectId: valid.effectId,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "tool_call", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ToolCallRecord>({
					model: "tool_call",
					where: [{ field: "id", value: id }],
				});
			},

			getByToolCallId(input) {
				return db.findOne<ToolCallRecord>({
					model: "tool_call",
					where: [
						{ field: "runId", value: input.runId },
						{
							field: "toolCallId",
							value: input.toolCallId,
							connector: "AND",
						},
					],
				});
			},

			async updateStatus(id, patch) {
				const update: Record<string, unknown> = {
					updatedAt: patch.updatedAt ?? now(),
				};
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.approvalId !== undefined)
					update.approvalId = patch.approvalId;
				if (patch.effectId !== undefined) update.effectId = patch.effectId;

				const row = await db.update<ToolCallRecord>({
					model: "tool_call",
					where: [{ field: "id", value: id }],
					update,
				});
				return row ? assertToolCallRecord(row) : null;
			},
		},

		toolResults: {
			async create(input) {
				const valid = assertCreateToolResultInput(input);
				const record = assertToolResultRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					toolCallId: valid.toolCallId,
					status: valid.status,
					output: valid.output,
					error: valid.error,
					outputMode: valid.outputMode,
					createdAt: now(),
				});
				await db.create({ model: "tool_result", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ToolResultRecord>({
					model: "tool_result",
					where: [{ field: "id", value: id }],
				});
			},

			listForToolCall(input) {
				return db.findMany<ToolResultRecord>({
					model: "tool_result",
					where: [
						{ field: "runId", value: input.runId },
						{
							field: "toolCallId",
							value: input.toolCallId,
							connector: "AND",
						},
					],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		checkpoints: {
			async create(input) {
				const valid = assertCreateCheckpointInput(input);
				const record = assertCheckpointRecord({
					id: valid.id ?? newId(),
					runId: valid.runId,
					clawId: valid.clawId,
					threadId: valid.threadId,
					parentCheckpointId: valid.parentCheckpointId,
					kind: valid.kind,
					step: valid.step,
					state: valid.state,
					messageCursor: valid.messageCursor,
					toolCallId: valid.toolCallId,
					createdAt: now(),
				});
				await db.create({ model: "checkpoint", data: record });
				return record;
			},

			get(id) {
				return db.findOne<CheckpointRecord>({
					model: "checkpoint",
					where: [{ field: "id", value: id }],
				});
			},

			async latestForRun(runId) {
				const [latest] = await db.findMany<CheckpointRecord>({
					model: "checkpoint",
					where: [{ field: "runId", value: runId }],
					limit: 1,
					sortBy: { field: "createdAt", direction: "desc" },
				});
				return latest ?? null;
			},
		},

		conversationBindings: {
			async create(input) {
				const valid = assertCreateConversationBindingInput(input);
				const ts = now();
				const record = assertConversationBindingRecord({
					id: valid.id ?? newId(),
					provider: valid.provider,
					tenantId: valid.tenantId,
					externalConversationId: valid.externalConversationId,
					externalActorId: valid.externalActorId,
					clawId: valid.clawId,
					threadId: valid.threadId,
					metadata: valid.metadata,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "conversation_binding", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ConversationBindingRecord>({
					model: "conversation_binding",
					where: [{ field: "id", value: id }],
				});
			},

			getByExternal(input) {
				return db.findOne<ConversationBindingRecord>({
					model: "conversation_binding",
					where: [
						{ field: "provider", value: input.provider },
						{ field: "tenantId", value: input.tenantId, connector: "AND" },
						{
							field: "externalConversationId",
							value: input.externalConversationId,
							connector: "AND",
						},
					],
				});
			},

			listForThread(threadId) {
				return db.findMany<ConversationBindingRecord>({
					model: "conversation_binding",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},
	};
}
