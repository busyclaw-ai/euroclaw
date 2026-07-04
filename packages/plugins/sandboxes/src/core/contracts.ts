// The sandboxes floor — the Sandbox provider contract, the normalized ExecutionContext view, and
// the two shapes that cross the sandbox→host trust boundary. Every provider and the shared engine
// build on this module; nothing here imports a provider or the wasm dependency.
//
// Schema discipline (the channels precedent): arktype ONLY where untrusted, agent-authored data
// crosses a boundary — the execution result and the invoker input. Ports (Sandbox,
// SandboxToolInvoker) and host-assembled views (ExecutionContext, IsolationPosture) stay plain TS.

import { type } from "arktype";

// UNTRUSTED (sandbox → host): validated by the ENGINE at the boundary. `result` is the value the
// sandboxed code returned; it must be JSON-safe (the host builds it that way — see the provider).
export const executionResult = type({
	result: "unknown",
	"logs?": "string[]",
	"error?": "string",
});
export type ExecutionResult = typeof executionResult.infer;

// What sandboxed code hands the invoker — validated BEFORE it reaches subInvoke. handleToolCall
// re-validates the ToolCall downstream; this catches a malformed/hostile shape at the door with a
// sandbox-legible value.
export const sandboxInvokeInput = type({ path: "string", args: "unknown" });
export type SandboxInvokeInput = typeof sandboxInvokeInput.infer;

/**
 * The governed-fetch seam. Mirrors global fetch structurally so the floor needs no DOM lib (this
 * repo builds without `DOM`; channels' TelegramFetch is the same convention). When present on an
 * ExecutionContext the provider injects it as the sandbox's fetch; absent = fetch stays the
 * wrapper's throwing stub. The host returns the wrapper's mapped-response shape (delegate to
 * getDefaultFetchAdapter or emit it).
 */
export type SandboxFetch = (
	input: string | { readonly href: string },
	init?: unknown,
) => Promise<unknown>;

// PORTS + HOST-ASSEMBLED VIEWS: plain types — no runtime boundary to validate.
export interface Sandbox {
	readonly provider: string;
	/** Two configs of one provider need distinct names — the channels distinct-(provider,name) fold. */
	readonly name?: string;
	/** Self-reported enforcement reality: selection input + strict-mode gate. */
	readonly posture: IsolationPosture;
	/** Assert usable at construction (wasm loadable) — fail at startup, not on first run_code. */
	validate?: () => void;
	execute: (input: {
		code: string; // already normalized by the ENGINE
		invoker: SandboxToolInvoker; // engine-wrapped; routes into handleToolCall
		context: ExecutionContext; // normalized: limits, egress, injected capabilities
	}) => Promise<ExecutionResult>;
	dispose?: () => Promise<void>;
}

export type IsolationPosture = {
	kind: "wasm" | "process" | "isolate"; // quickjs | deno | workerd
	network: "blocked" | "allowlist" | "interceptor";
	filesystem: "none" | "scoped";
	memoryLimit: boolean;
	wallClockLimit: boolean;
};

export type ExecutionContext = {
	timeoutMs?: number;
	memoryLimitBytes?: number;
	/** Egress policy for THIS execution — reserved for the domain-allowlist step; absent/null = the
	 *  provider injects no fetch. The v1 quickjs provider consumes egress only as "fetch or not"
	 *  through `fetchAdapter` below; it does not read `domains`. */
	egress?: { domains?: readonly string[] } | null;
	modules?: Record<string, string>;
	/** The governed fetch the host supplies for this execution (see SandboxFetch). */
	fetchAdapter?: SandboxFetch;
	/** In-memory virtual filesystem tree (the wrapper's memfs NestedDirectoryJSON). No quota exists
	 *  in the wrapper — the host bounds the seeded data size. */
	mountFs?: Record<string, unknown>;
};

export interface SandboxToolInvoker {
	invoke: (input: SandboxInvokeInput) => Promise<unknown>;
}
