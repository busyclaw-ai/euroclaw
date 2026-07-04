// The run_code tool factory: an AI-SDK-shaped tool the host adds to createClaw/createRuntime
// ({ tools }). It rides the runtime's invoker seam — its execute receives `subInvoke`, which routes
// every tool call the sandboxed script makes through the full governance pipeline.

import { govern, type HandleResult, stateError } from "@euroclaw/contracts";
import { jsonSchema, type ToolSet, tool } from "ai";
import type {
	ExecutionContext,
	Sandbox,
	SandboxToolInvoker,
} from "./core/contracts";
import { executeInSandbox } from "./core/engine";

// The governed nested-invoke seam the runtime hands invoker-stamped tools. Typed locally (its shape
// mirrors @euroclaw/runtime's SubInvoke) so this factory needs no runtime dependency.
type SubInvoke = (
	name: string,
	args: Record<string, unknown>,
	ctx?: Record<string, unknown>,
) => Promise<HandleResult>;
type InvokerExecuteOptions = { toolCallId: string; subInvoke?: SubInvoke };

const DEFAULT_DESCRIPTION =
	"Run JavaScript in an isolated sandbox. Call tools with `await tools.<name>(args)` " +
	"(use dotted paths for namespaced tools, e.g. `tools.github.issues.list(args)`); each call is " +
	"individually governed and returns a result object you can read. `console.log` output is " +
	"captured. The value you `return` is the result.";

export function runCodeTool(input: {
	sandbox: Sandbox;
	/** Per-execution context assembly. Host-supplied; may close over integration/actor to build a
	 *  governed fetchAdapter. Default: {} (no fetch, no fs, defaults-only bounds). */
	context?: (options: { toolCallId: string }) => ExecutionContext;
	description?: string;
}): ToolSet[string] {
	const theTool = tool({
		description: input.description ?? DEFAULT_DESCRIPTION,
		inputSchema: jsonSchema<{ code: string }>({
			type: "object",
			properties: {
				code: {
					type: "string",
					description:
						"JavaScript source. Use `await tools.<path>(args)` to call tools; `return` the result.",
				},
			},
			required: ["code"],
		}),
		execute: async ({ code }, options) => {
			// Blessed seam cast: the AI-SDK ToolCallOptions type is closed; the runtime extends it with
			// `subInvoke` for invoker-stamped tools only (runtime.ts). Absent = the stamp is missing.
			const { subInvoke, toolCallId } =
				options as unknown as InvokerExecuteOptions;
			if (!subInvoke) {
				throw stateError("run_code requires the runtime subInvoke seam");
			}
			const invoker: SandboxToolInvoker = {
				// The HandleResult VALUE (ok/denied) round-trips to the sandbox as JSON so model code can
				// read status/reason. handleToolCall re-validates args downstream, so the guest object
				// crosses as-is here.
				invoke: ({ path, args }) =>
					subInvoke(path, args as Record<string, unknown>),
			};
			const context = input.context?.({ toolCallId }) ?? {};
			return executeInSandbox({
				sandbox: input.sandbox,
				code,
				invoker,
				context,
			});
		},
	});

	// Forced stamp (sandboxes-plan invariant #8): the script is one atomic effect — idempotency/output
	// "none" so a half-run script is never replayed or double-fired. NOT configurable.
	return govern(theTool, {
		invoker: true,
		effect: {
			idempotency: "none",
			output: "none",
			risk: "high",
			kind: "external",
		},
	});
}
