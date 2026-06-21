import type {
	ApprovalStore,
	AuditSink,
	EffectStore,
	EuroclawPlugin,
	InferContext,
	JsonObject,
	JsonValue,
	Redactor,
	ToolEffectPolicy,
} from "@euroclaw/core";
import {
	CLAW_ID_CONTEXT_KEY,
	createGovernance,
	jsonValue as jsonValueSchema,
	RESERVED_CONTEXT_PREFIX,
	RUN_ID_CONTEXT_KEY,
	redactionContextFrom,
	THREAD_ID_CONTEXT_KEY,
} from "@euroclaw/core";
import {
	configurationError,
	stateError,
	validationError,
} from "@euroclaw/errors";
import {
	createApprovalStore,
	createEffectStore,
} from "@euroclaw/storage-durable";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ModelMessage, ToolSet, wrapLanguageModel } from "ai";
import { type as ark } from "arktype";
import { runAiSdkLoop, toolResultMessage } from "./ai-sdk-loop";
import {
	composeContext,
	type IdentityResolver,
	type MembershipResolver,
	type TenantResolver,
} from "./context";
import { type RuntimeDatabase, resolveDatabase } from "./database";
import {
	createRuntimeEvent,
	emitRuntimeEvent,
	eventSinksFrom,
	RUNTIME_RECORDING_OPTION,
	type RuntimeEventPayloadInput,
	type RuntimeEventSink,
	type RuntimeRecordingContext,
	runtimeRecordingContext,
} from "./events";
import {
	createRunState,
	modelFacingTools,
	type RunState,
	registerToolGates,
} from "./tools";

export type RuntimeModel = Parameters<typeof wrapLanguageModel>[0]["model"];

export type RuntimeAbortSignal = { readonly aborted: boolean };
export type RuntimeRunOptions = {
	abortSignal?: RuntimeAbortSignal;
	readonly [RUNTIME_RECORDING_OPTION]?: RuntimeRecordingContext;
};

export type RuntimeEnvironment = {
	now?: () => string;
	newId?: (prefix: string) => string;
};

export function defaultRuntimeNewId(prefix: string): string {
	return `${prefix}_${bytesToHex(randomBytes(16))}`;
}

export type RuntimeConfig = {
	model: RuntimeModel;
	tools?: ToolSet;
	system?: string;
	redactor?: Redactor;
	tenant?: TenantResolver;
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	audit?: AuditSink;
	effectStore?: EffectStore;
	effectLeaseTtlMs?: number;
	database?: RuntimeDatabase;
	environment?: RuntimeEnvironment;
	events?: RuntimeEventSink | readonly RuntimeEventSink[];
	plugins?: readonly EuroclawPlugin[];
	maxSteps?: number;
};

const ApprovalIds = ark("string").array();

export const RuntimeCompletedResult = ark({
	status: "'completed'",
	text: "string",
	steps: "number",
});
export type RuntimeCompletedResult = typeof RuntimeCompletedResult.infer;

export const RuntimeWaitingApprovalResult = ark({
	status: "'waiting_approval'",
	text: "string",
	steps: "number",
	"approvalIds?": ApprovalIds.or("undefined"),
});
export type RuntimeWaitingApprovalResult =
	typeof RuntimeWaitingApprovalResult.infer;

export const RuntimeDeniedResult = ark({
	status: "'denied'",
	text: "string",
	steps: "number",
	approvalId: "string",
	"decidedBy?": "string | undefined",
	"reason?": "string | undefined",
	"reasonCode?": "string | undefined",
});
export type RuntimeDeniedResult = typeof RuntimeDeniedResult.infer;

export const RuntimeResult = RuntimeCompletedResult.or(
	RuntimeWaitingApprovalResult,
).or(RuntimeDeniedResult);
export type RuntimeResult = typeof RuntimeResult.infer;

export type RunContext<Config extends RuntimeConfig> = InferContext<Config>;

export type Runtime<Config extends RuntimeConfig = RuntimeConfig> = {
	run: (
		prompt: string,
		ctx?: RunContext<Config>,
		options?: RuntimeRunOptions,
	) => Promise<RuntimeResult>;
	continueRun: (
		id: string,
		ctx?: RunContext<Config>,
		options?: RuntimeRunOptions,
	) => Promise<RuntimeResult | null>;
	readonly audit?: AuditSink;
	readonly approvals?: ApprovalStore;
	readonly effects?: EffectStore;
};

export function runtimeRunOptionsWithRecording(
	options: RuntimeRunOptions | undefined,
	recording: RuntimeRecordingContext,
): RuntimeRunOptions {
	return { ...(options ?? {}), [RUNTIME_RECORDING_OPTION]: recording };
}

function stripReserved(ctx: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(ctx)) {
		if (!key.startsWith(RESERVED_CONTEXT_PREFIX)) out[key] = value;
	}
	return out;
}

function hashEffectInput(value: unknown): string {
	return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

function errorPayload(err: unknown): Record<string, unknown> {
	return err instanceof Error
		? { name: err.name, message: err.message }
		: { message: String(err) };
}

function toJsonValue(value: unknown, label: string): JsonValue {
	let parsed: unknown;
	try {
		const json = JSON.stringify(value);
		if (typeof json !== "string") {
			throw validationError(label, "must be JSON-serializable");
		}
		parsed = JSON.parse(json) as unknown;
	} catch (err) {
		if (err instanceof Error && err.name === "EuroclawError") throw err;
		throw validationError(
			label,
			err instanceof Error ? err.message : String(err),
		);
	}
	const valid = jsonValueSchema(parsed);
	if (valid instanceof ark.errors) {
		throw validationError(label, valid.summary);
	}
	return valid;
}

function effectOutputMode(
	policy: ToolEffectPolicy | undefined,
): "none" | "redacted" | "full" {
	return (
		policy?.output ?? (policy?.idempotency === "none" ? "none" : "redacted")
	);
}

function abortIfNeeded(signal: RuntimeAbortSignal | undefined): void {
	if (signal?.aborted) throw stateError("runtime aborted");
}

function combinedAbortSignal(
	first: RuntimeAbortSignal | undefined,
	second: RuntimeAbortSignal | undefined,
): RuntimeAbortSignal | undefined {
	if (!first) return second;
	if (!second) return first;
	return {
		get aborted() {
			return first.aborted || second.aborted;
		},
	};
}

type EffectAbortController = {
	signal: { aborted: boolean };
	abort: () => void;
};

function createEffectAbortController(): EffectAbortController {
	const Controller = (
		globalThis as { AbortController?: new () => EffectAbortController }
	).AbortController;
	if (Controller) return new Controller();
	const signal = { aborted: false };
	return {
		signal,
		abort: () => {
			signal.aborted = true;
		},
	};
}

function startEffectHeartbeat(input: {
	store: EffectStore;
	effectId: string;
	leaseToken: string;
	leaseTtlMs?: number;
	now: () => string;
	abortController: EffectAbortController;
}): () => void {
	const ttl = input.leaseTtlMs ?? 60_000;
	const intervalMs = Math.max(250, Math.floor(ttl / 2));
	const timers = globalThis as typeof globalThis & {
		setInterval: (fn: () => void, ms: number) => { unref?: () => void };
		clearInterval: (timer: unknown) => void;
	};
	let stopped = false;
	const timer = timers.setInterval(() => {
		void input.store
			.heartbeat({
				id: input.effectId,
				leaseToken: input.leaseToken,
				leaseTtlMs: input.leaseTtlMs,
				now: input.now(),
			})
			.then((record) => {
				if (!record && !stopped) input.abortController.abort();
			})
			.catch(() => {
				if (!stopped) input.abortController.abort();
			});
	}, intervalMs) as { unref?: () => void };
	timer.unref?.();
	return () => {
		if (stopped) return;
		stopped = true;
		timers.clearInterval(timer);
	};
}

const runtimeModelMessage = ark({ role: "string", content: "unknown" }).narrow(
	(value): value is ModelMessage => value.role.length > 0,
);

export const runtimeApprovalMetadata = ark({
	version: "'runtime.ai-sdk.v1'",
	waitId: "string",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	toolInput: "unknown",
	messages: runtimeModelMessage.array(),
	"recording?": runtimeRecordingContext.or("undefined"),
});
export type RuntimeApprovalMetadata = typeof runtimeApprovalMetadata.infer;

export function parseRuntimeApprovalMetadata(
	metadata: unknown,
): RuntimeApprovalMetadata {
	const valid = runtimeApprovalMetadata(metadata) as
		| RuntimeApprovalMetadata
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("runtime approval metadata invalid", valid.summary);
	}
	return valid;
}

export function recordingFromRuntimeApprovalMetadata(
	metadata: unknown,
): RuntimeRecordingContext | undefined {
	const valid = parseRuntimeApprovalMetadata(metadata);
	return valid.recording;
}

export function createRuntime<const Config extends RuntimeConfig>(
	config: Config,
): Runtime<Config> {
	const now = config.environment?.now ?? (() => new Date().toISOString());
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const maxSteps = config.maxSteps ?? 8;
	const tools = config.tools ?? {};
	const eventSinks = eventSinksFrom(config.events);
	const adapter = config.database
		? resolveDatabase(config.database)
		: undefined;
	if (adapter && config.redactor?.durable !== true) {
		throw configurationError(
			"database-backed runtime approvals require a durable redactor",
		);
	}
	const approvalStore = adapter ? createApprovalStore(adapter) : undefined;
	const effectStore =
		config.effectStore ?? (adapter ? createEffectStore(adapter) : undefined);
	const resolveContext = composeContext({
		identity: config.identity,
		membership: config.membership,
		tenant: config.tenant,
	});
	const modelTools = modelFacingTools(tools);
	const emitEvent = (
		recording: RuntimeRecordingContext | undefined,
		payload: RuntimeEventPayloadInput,
	) =>
		emitRuntimeEvent(
			eventSinks,
			createRuntimeEvent({
				createdAt: now(),
				id: newId("evt"),
				payload,
				recording,
			}),
		);

	const redactEventValue = async <T>(
		value: T,
		ctx: Record<string, unknown>,
	): Promise<T> =>
		config.redactor
			? config.redactor.redactValue(value, redactionContextFrom(ctx))
			: value;

	const createRunCore = (
		state: RunState,
		approvalStoreOverride = approvalStore,
	) => {
		const resolveGovernanceContext = async (
			ctx: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			const resolved = resolveContext ? await resolveContext(ctx) : ctx;
			if (state.recording) {
				resolved[CLAW_ID_CONTEXT_KEY] = state.recording.clawId;
				resolved[THREAD_ID_CONTEXT_KEY] = state.recording.threadId;
				if (state.recording.runId !== undefined) {
					resolved[RUN_ID_CONTEXT_KEY] = state.recording.runId;
				}
			}
			return resolved;
		};
		const core = createGovernance({
			redactor: config.redactor,
			audit: config.audit,
			approvalStore: approvalStoreOverride,
			approvalMetadata: () => {
				const metadata: Record<string, unknown> = {
					version: "runtime.ai-sdk.v1",
					waitId: state.currentApprovalWaitId ?? "",
					step: state.currentStep,
					toolCallId: state.currentToolCallId,
					toolName: state.currentToolName,
					toolInput: toJsonValue(
						state.currentToolInput,
						"runtime approval tool input invalid",
					),
					messages: toJsonValue(
						state.currentMessages,
						"runtime approval messages invalid",
					),
				};
				if (state.recording !== undefined) metadata.recording = state.recording;
				return metadata as JsonObject;
			},
			resolveContext: resolveGovernanceContext,
			plugins: config.plugins,
			callModel: async () => {
				if (!state.currentModelRunner) {
					throw stateError("runtime model boundary missing model runner");
				}
				return state.currentModelRunner();
			},
			runTool: async (call, _ctx, { rehydrate }) => {
				abortIfNeeded(state.abortSignal);
				const tool = tools[call.name];
				if (!tool || typeof tool.execute !== "function") {
					throw stateError(`euroclaw: no executable tool "${call.name}"`, {
						toolName: call.name,
					});
				}
				const executeTool = tool.execute;
				const args = await rehydrate(call.args);
				const execute = (abortSignal?: unknown) =>
					executeTool(args, {
						toolCallId: state.currentToolCallId,
						messages: state.currentMessages,
						abortSignal: abortSignal as never,
					});
				const effectPolicy = (
					tool as { euroclaw?: { effect?: ToolEffectPolicy } }
				).euroclaw?.effect;
				const outputMode = effectOutputMode(effectPolicy);
				if (!effectStore) return execute(state.abortSignal);
				state.currentEffectId ??= `run:${state.recording?.runId ?? state.currentApprovalWaitId ?? newId("run")}:tool:${state.currentToolCallId || call.name}`;
				const inputHash = hashEffectInput({
					toolName: call.name,
					args: call.args,
				});
				const claim = await effectStore.claim({
					id: state.currentEffectId,
					toolName: call.name,
					inputHash,
					compensation: effectPolicy?.compensation,
					now: now(),
					leaseTtlMs: config.effectLeaseTtlMs,
					reclaimExpired: effectPolicy?.idempotency !== "none",
				});
				if (claim.record.inputHash !== inputHash) {
					throw stateError("effect id reused with different input", {
						effectId: state.currentEffectId,
					});
				}
				if (claim.status === "completed") {
					if (claim.record.output === undefined) {
						throw stateError("completed effect output is unavailable", {
							effectId: state.currentEffectId,
							outputMode,
						});
					}
					return claim.record.output;
				}
				if (claim.status === "in_progress") {
					throw stateError("effect is already in progress", {
						effectId: state.currentEffectId,
						leaseExpiresAt: claim.leaseExpiresAt,
					});
				}
				if (claim.status === "uncertain") {
					throw stateError(
						"effect outcome is unknown and cannot be retried without idempotency",
						{
							effectId: state.currentEffectId,
							leaseExpiresAt: claim.leaseExpiresAt,
						},
					);
				}
				if (claim.status === "unavailable") {
					throw stateError("effect is not claimable", {
						effectId: state.currentEffectId,
						status: claim.record.status,
					});
				}
				const abortController = createEffectAbortController();
				const stopHeartbeat = startEffectHeartbeat({
					store: effectStore,
					effectId: state.currentEffectId,
					leaseToken: claim.leaseToken,
					leaseTtlMs: config.effectLeaseTtlMs,
					now,
					abortController,
				});
				const abortSignal = combinedAbortSignal(
					state.abortSignal,
					abortController.signal,
				);
				try {
					const output = await execute(abortSignal);
					abortIfNeeded(state.abortSignal);
					if (abortController.signal.aborted) {
						throw stateError("effect lease lost before completion", {
							effectId: state.currentEffectId,
						});
					}
					const persistedOutput =
						outputMode === "none"
							? undefined
							: toJsonValue(
									outputMode === "redacted" && config.redactor
										? await config.redactor.redactValue(
												output,
												redactionContextFrom(_ctx),
											)
										: output,
									"effect output invalid",
								);
					await effectStore.complete({
						id: state.currentEffectId,
						leaseToken: claim.leaseToken,
						...(persistedOutput !== undefined
							? { output: persistedOutput }
							: {}),
						now: now(),
					});
					return output;
				} catch (err) {
					try {
						await effectStore.fail({
							id: state.currentEffectId,
							leaseToken: claim.leaseToken,
							error: errorPayload(err),
							now: now(),
						});
					} catch {
						// Preserve the tool/lease error; fail() can also lose the lease.
					}
					throw err;
				} finally {
					stopHeartbeat();
				}
			},
		});
		registerToolGates(core, tools);
		return core;
	};

	const resolveRunContext = async (
		ctxInput: Record<string, unknown> | undefined,
	): Promise<Record<string, unknown>> => {
		const ctx = stripReserved(ctxInput ?? {});
		return resolveContext ? await resolveContext(ctx) : ctx;
	};

	const run = async (
		prompt: string,
		ctx?: Record<string, unknown>,
		options?: RuntimeRunOptions,
	): Promise<RuntimeResult> => {
		const state = createRunState();
		state.abortSignal = options?.abortSignal;
		abortIfNeeded(options?.abortSignal);
		const recording = options?.[RUNTIME_RECORDING_OPTION];
		state.recording = recording;
		const core = createRunCore(state);
		const resolvedCtx = await resolveRunContext(ctx);
		await emitEvent(recording, {
			prompt: String(await redactEventValue(prompt, resolvedCtx)),
			type: "run.started",
		});
		const result = await runAiSdkLoop({
			model: config.model,
			tools: modelTools,
			system: config.system,
			prompt,
			ctx,
			resolvedCtx,
			core,
			state,
			maxSteps,
			now,
			abortSignal: options?.abortSignal,
			emitEvent: (payload) => emitEvent(recording, payload),
			redactEventValue: (value) => redactEventValue(value, resolvedCtx),
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError("runtime.run result invalid", valid.summary);
		}
		if (valid.status === "completed") {
			await emitEvent(recording, {
				steps: valid.steps,
				text: valid.text,
				type: "run.completed",
			});
		} else if (valid.status === "waiting_approval") {
			await emitEvent(recording, {
				approvalIds: valid.approvalIds,
				steps: valid.steps,
				text: valid.text,
				type: "run.waiting_approval",
			});
		}
		return valid;
	};

	const continueRun = async (
		id: string,
		ctx?: Record<string, unknown>,
		options?: RuntimeRunOptions,
	): Promise<RuntimeResult | null> => {
		abortIfNeeded(options?.abortSignal);
		const recording = options?.[RUNTIME_RECORDING_OPTION];
		if (!approvalStore) return null;
		const record = await approvalStore.get(id);
		if (!record) return null;

		const checkpoint = parseRuntimeApprovalMetadata(record.metadata);
		const effectiveRecording = recording ?? checkpoint.recording;
		if (record.status === "denied") {
			const text = record.reason ?? "approval denied";
			await emitEvent(effectiveRecording, {
				decidedBy: record.decidedBy,
				reason: text,
				reasonCode: record.reasonCode,
				step: checkpoint.step,
				toolCallId: checkpoint.toolCallId,
				toolName: checkpoint.toolName,
				type: "tool.denied",
			});
			const result = {
				approvalId: id,
				decidedBy: record.decidedBy,
				reason: text,
				reasonCode: record.reasonCode,
				status: "denied",
				steps: checkpoint.step + 1,
				text,
			};
			const valid = RuntimeDeniedResult(result);
			if (valid instanceof ark.errors) {
				throw validationError(
					"runtime.continueRun denied result invalid",
					valid.summary,
				);
			}
			await emitEvent(effectiveRecording, {
				approvalId: valid.approvalId,
				decidedBy: valid.decidedBy,
				reasonCode: valid.reasonCode,
				steps: valid.steps,
				text: valid.text,
				type: "run.denied",
			});
			return valid;
		}
		if (record.status !== "approved" && record.status !== "consumed")
			return null;
		const resolvedCtx = await resolveRunContext(ctx);

		const state = createRunState();
		state.abortSignal = options?.abortSignal;
		state.recording = effectiveRecording;
		state.currentToolCallId = checkpoint.toolCallId;
		state.currentToolName = checkpoint.toolName;
		state.currentToolInput = checkpoint.toolInput;
		const checkpointMessages = checkpoint.messages;
		state.currentMessages = checkpointMessages;
		state.currentStep = checkpoint.step;
		state.currentApprovalWaitId = checkpoint.waitId;
		state.currentEffectId = `approval:${id}:tool:${checkpoint.toolCallId}`;

		const core = createRunCore(
			state,
			record.status === "consumed"
				? {
						...approvalStore,
						consume: async (approvalId) => (approvalId === id ? record : null),
					}
				: approvalStore,
		);
		const toolResult = await core.continueRun(id, ctx);
		if (!toolResult) return null;
		if (toolResult.status === "needs-approval") {
			throw stateError("approval resume required another approval", {
				approvalId: id,
				gateId: toolResult.gateId,
			});
		}

		const output =
			toolResult.status === "ok"
				? toolResult.output
				: {
						__governance: toolResult.status,
						reason: toolResult.reason,
						reasonCode: toolResult.reasonCode,
					};
		if (toolResult.status === "ok") {
			const redactedOutput = config.redactor
				? await config.redactor.redactValue(
						toolResult.output,
						redactionContextFrom(resolvedCtx),
					)
				: toolResult.output;
			await emitEvent(effectiveRecording, {
				...(state.currentEffectId !== undefined
					? { effectId: state.currentEffectId }
					: {}),
				...(redactedOutput !== undefined ? { output: redactedOutput } : {}),
				step: checkpoint.step,
				toolCallId: checkpoint.toolCallId,
				toolName: checkpoint.toolName,
				type: "tool.completed",
			});
		} else {
			await emitEvent(effectiveRecording, {
				reason: toolResult.reason,
				reasonCode: toolResult.reasonCode,
				step: checkpoint.step,
				toolCallId: checkpoint.toolCallId,
				toolName: checkpoint.toolName,
				type: "tool.denied",
			});
		}
		const messages = [
			...checkpointMessages,
			toolResultMessage(checkpoint.toolCallId, checkpoint.toolName, output),
		];

		const resumeState = createRunState();
		resumeState.abortSignal = options?.abortSignal;
		resumeState.recording = effectiveRecording;
		const result = await runAiSdkLoop({
			model: config.model,
			tools: modelTools,
			system: config.system,
			messages,
			startStep: checkpoint.step + 1,
			ctx,
			resolvedCtx,
			core: createRunCore(resumeState),
			state: resumeState,
			maxSteps,
			now,
			abortSignal: options?.abortSignal,
			emitEvent: (payload) => emitEvent(effectiveRecording, payload),
			redactEventValue: async (value) =>
				config.redactor
					? config.redactor.redactValue(
							value,
							redactionContextFrom(resolvedCtx),
						)
					: value,
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError(
				"runtime.continueRun result invalid",
				valid.summary,
			);
		}
		if (valid.status === "completed") {
			await emitEvent(effectiveRecording, {
				steps: valid.steps,
				text: valid.text,
				type: "run.completed",
			});
		} else if (valid.status === "waiting_approval") {
			await emitEvent(effectiveRecording, {
				approvalIds: valid.approvalIds,
				steps: valid.steps,
				text: valid.text,
				type: "run.waiting_approval",
			});
		}
		return valid;
	};

	return {
		audit: config.audit,
		approvals: approvalStore,
		continueRun,
		effects: effectStore,
		run,
	};
}
