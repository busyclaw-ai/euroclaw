// @euroclaw/sandboxes — governed code execution behind pluggable isolation providers. This root
// export is the floor contracts, the shared engine, and the run_code tool factory.
//
// Deliberately NOT re-exported here (subpath isolation keeps the wasm dependency out of the root
// import graph):
//   import { quickjs } from "@euroclaw/sandboxes/quickjs"

export type {
	ExecutionContext,
	ExecutionResult,
	IsolationPosture,
	Sandbox,
	SandboxFetch,
	SandboxInvokeInput,
	SandboxToolInvoker,
} from "./core/contracts";
export { executionResult, sandboxInvokeInput } from "./core/contracts";
export { executeInSandbox, normalizeCode } from "./core/engine";
export { runCodeTool } from "./runcode";
