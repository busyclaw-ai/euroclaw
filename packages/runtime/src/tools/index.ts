import {
	type ToolGovernance,
	toolGovernance as toolGovernanceSchema,
	validationError,
} from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { ModelMessage, ToolSet } from "ai";
import { type } from "arktype";
import type { RuntimeRecordingContext } from "../events";
import type { RuntimeAbortSignal } from "../runtime";

export type RunState = {
	currentToolCallId: string;
	currentToolName: string;
	currentToolInput: unknown;
	currentMessages: ModelMessage[];
	currentStep: number;
	currentApprovalWaitId?: string;
	currentEffectId?: string;
	runInstanceId?: string;
	/** Durable run identity (engine run id) — stable across attempts and yield slices. */
	runId?: string;
	currentModelRunner?: () => unknown | Promise<unknown>;
	recording?: RuntimeRecordingContext;
	abortSignal?: RuntimeAbortSignal;
};

export function createRunState(): RunState {
	return {
		currentToolCallId: "",
		currentToolName: "",
		currentToolInput: undefined,
		currentMessages: [],
		currentStep: 0,
	};
}

/**
 * Read the governance stamp `govern()` attached to a tool. The AI-SDK ToolSet type ERASES
 * the `euroclaw` field, so the compiler cannot check what a host attached — this is a real
 * trust boundary, and the contracts schema validates it. A malformed stamp (typo'd
 * idempotency, wrong risk value) must fail loud here, not fail OPEN downstream where a
 * misspelled "none" would silently make an effect auto-retryable.
 */
export function toolGovernance(
	tool: object,
	name: string,
): ToolGovernance | undefined {
	if (!("euroclaw" in tool) || tool.euroclaw === undefined) return undefined;
	const stamp = toolGovernanceSchema(tool.euroclaw);
	if (stamp instanceof type.errors) {
		throw validationError(
			`tool "${name}" carries an invalid governance stamp`,
			stamp.summary,
		);
	}
	return stamp;
}

export function registerToolGates(core: Governance, tools: ToolSet): void {
	for (const [name, tool] of Object.entries(tools)) {
		const gate = toolGovernance(tool, name)?.gate;
		if (gate) {
			core.registerGate({
				id: `tool:${name}`,
				matcher: (call) => call.name === name,
				handler: gate,
			});
		}
	}
}

export function modelFacingTools(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			const {
				euroclaw: _euroclaw,
				execute: _execute,
				...rest
			} = tool as Record<string, unknown>;
			return [name, rest];
		}),
	) as ToolSet;
}

export type { OpenApiExtraction, OpenApiTool } from "./sources/openapi";
export { toolsFromOpenApi } from "./sources/openapi";
