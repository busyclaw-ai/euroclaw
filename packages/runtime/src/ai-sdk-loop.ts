import type { Governance } from "@euroclaw/core";
import { configurationError, stateError } from "@euroclaw/errors";
import type { ModelMessage, ToolSet } from "ai";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import type { RuntimeEventPayloadInput } from "./events";
import { modelMiddleware } from "./model-middleware";
import type {
	RuntimeAbortSignal,
	RuntimeModel,
	RuntimeResult,
} from "./runtime";
import type { RunState } from "./tools";

export type AiSdkLoopInput = {
	model: RuntimeModel;
	tools: ToolSet;
	system?: string;
	prompt?: string;
	messages?: ModelMessage[];
	startStep?: number;
	ctx?: Record<string, unknown>;
	resolvedCtx: Record<string, unknown>;
	core: Governance;
	state: RunState;
	maxSteps: number;
	now: () => string;
	abortSignal?: RuntimeAbortSignal;
	emitEvent?: (payload: RuntimeEventPayloadInput) => Promise<void>;
	redactEventValue?: <T>(value: T) => Promise<T>;
};

function abortIfNeeded(signal: RuntimeAbortSignal | undefined): void {
	if (signal?.aborted) throw stateError("runtime aborted");
}

export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	output: unknown,
): ModelMessage {
	const value = serializeToolOutput(output);
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: {
					type: "text",
					value,
				},
			},
		],
	};
}

function serializeToolOutput(output: unknown): string {
	if (typeof output === "string") return output;
	try {
		const value = JSON.stringify(output);
		if (typeof value === "string") return value;
	} catch (err) {
		throw stateError("tool output is not JSON-serializable", {
			reason: err instanceof Error ? err.message : String(err),
		});
	}
	throw stateError("tool output is not JSON-serializable", {
		reason: "JSON.stringify returned undefined",
	});
}

async function redactForEvent<T>(input: AiSdkLoopInput, value: T): Promise<T> {
	return input.redactEventValue ? await input.redactEventValue(value) : value;
}

export async function runAiSdkLoop(
	input: AiSdkLoopInput,
): Promise<RuntimeResult> {
	const model = wrapLanguageModel({
		model: input.model,
		middleware: modelMiddleware(
			input.core,
			input.model,
			input.ctx,
			input.resolvedCtx,
			input.state,
		),
	});
	const messages: ModelMessage[] = input.messages
		? [...input.messages]
		: [{ role: "user", content: input.prompt ?? "" }];

	for (let step = input.startStep ?? 0; step < input.maxSteps; step++) {
		abortIfNeeded(input.abortSignal);
		const res = await generateText({
			model,
			tools: input.tools,
			system: input.system,
			messages,
			stopWhen: stepCountIs(1),
			...(input.abortSignal ? { abortSignal: input.abortSignal as never } : {}),
		});
		abortIfNeeded(input.abortSignal);
		messages.push(...res.response.messages);

		if (res.toolCalls.length === 0) {
			return {
				status: "completed",
				text: res.text,
				steps: step + 1,
			};
		}
		if (res.toolCalls.length > 1) {
			throw stateError(
				"euroclaw runtime currently supports one tool call per model step",
				{ toolCallCount: res.toolCalls.length },
			);
		}

		input.state.currentMessages = await redactForEvent(input, messages);
		const toolMessages: ModelMessage[] = [];
		for (const toolCall of res.toolCalls) {
			abortIfNeeded(input.abortSignal);
			const redactedToolInput = await redactForEvent(input, toolCall.input);
			input.state.currentToolCallId = toolCall.toolCallId;
			input.state.currentToolName = toolCall.toolName;
			input.state.currentToolInput = redactedToolInput;
			input.state.currentStep = step;
			input.state.currentEffectId = undefined;
			input.state.currentApprovalWaitId = `${input.now()}:${toolCall.toolCallId}`;
			const pendingBefore = new Set(
				(await input.core.approvals?.list({ status: "pending" }))?.map(
					(approval) => approval.id,
				) ?? [],
			);
			await input.emitEvent?.({
				args: redactedToolInput,
				step,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				type: "tool.called",
			});
			let result: Awaited<ReturnType<Governance["handleToolCall"]>>;
			try {
				result = await input.core.handleToolCall(
					{ name: toolCall.toolName, args: redactedToolInput },
					input.ctx,
				);
			} catch (err) {
				await input.emitEvent?.({
					error:
						err instanceof Error
							? { name: err.name, message: err.message }
							: { message: String(err) },
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.failed",
				});
				throw err;
			}
			if (result.status === "needs-approval") {
				if (!input.core.approvals) {
					throw configurationError(
						"runtime cannot wait for approval without a durable approval store",
						{ toolName: toolCall.toolName, toolCallId: toolCall.toolCallId },
					);
				}
				const pendingAfter =
					(await input.core.approvals.list({ status: "pending" })) ?? [];
				const approvalIds = pendingAfter
					.filter(
						(approval) =>
							approval.metadata?.waitId === input.state.currentApprovalWaitId,
					)
					.map((approval) => approval.id);
				if (approvalIds.length === 0) {
					const fallbackIds = pendingAfter
						.map((approval) => approval.id)
						.filter((id) => !pendingBefore.has(id));
					throw stateError(
						"approval was parked without runtime checkpoint metadata",
						{
							toolName: toolCall.toolName,
							toolCallId: toolCall.toolCallId,
							approvalIds: fallbackIds,
						},
					);
				}
				await input.emitEvent?.({
					approvalIds,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.waiting_approval",
				});
				return {
					status: "waiting_approval",
					text: "",
					steps: step + 1,
					approvalIds,
				};
			}
			const output =
				result.status === "ok"
					? result.output
					: {
							__governance: result.status,
							reason: result.reason,
							reasonCode: result.reasonCode,
						};
			if (result.status === "ok") {
				const redactedOutput = input.redactEventValue
					? await input.redactEventValue(result.output)
					: result.output;
				await input.emitEvent?.({
					...(input.state.currentEffectId !== undefined
						? { effectId: input.state.currentEffectId }
						: {}),
					...(redactedOutput !== undefined ? { output: redactedOutput } : {}),
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.completed",
				});
			} else if (result.status === "denied") {
				await input.emitEvent?.({
					reason: result.reason,
					reasonCode: result.reasonCode,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.denied",
				});
			}
			toolMessages.push(
				toolResultMessage(toolCall.toolCallId, toolCall.toolName, output),
			);
		}
		messages.push(...toolMessages);
	}

	throw stateError(
		`euroclaw: maxSteps (${input.maxSteps}) exceeded before the agent reached a final answer`,
		{ maxSteps: input.maxSteps },
	);
}
