// The QuickJS provider: model-authored JavaScript in an in-process WebAssembly interpreter, wrapping
// `@sebastianwessel/quickjs` (sync variant) with euroclaw's audited hardening posture. The wasm
// dependency is imported at module top HERE ONLY — this subpath keeps it out of the root import
// graph (channels subpath-isolation precedent).

import { configurationError } from "@euroclaw/contracts";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { loadQuickJs, type SandboxOptions } from "@sebastianwessel/quickjs";
import type {
	ExecutionContext,
	ExecutionResult,
	IsolationPosture,
	Sandbox,
	SandboxToolInvoker,
} from "../core/contracts";

export type QuickJsConfig = {
	/** Hard memory cap in bytes. POSITIVE only (0/-1 mean unbounded in the wrapper). Default 64MB. */
	memoryLimitBytes?: number;
	/** Max stack bytes. Default 1MB. */
	maxStackSizeBytes?: number;
	/** Wall-clock kill. Default 5000ms. */
	timeoutMs?: number;
	/** Timer caps (the wrapper's host-backed timers cannot be disabled; cap them low). Default 4 each. */
	maxTimeoutCount?: number;
	maxIntervalCount?: number;
};

const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TIMER_COUNT = 4;

// The guest prelude: builds a `tools` proxy over the env-injected `__invoke`. Property access
// appends a path segment; calling it invokes `__invoke(segments.join("."), args)` and returns its
// (host-bridged) promise. Dependency-free guest JS — no TypeScript.
const PRELUDE = `
const __invoke = env.__invoke;
const __seg = (path) => new Proxy(function () {}, {
	get: (_t, key) => __seg([...path, String(key)]),
	apply: (_t, _self, args) => __invoke(path.join("."), args[0]),
});
const tools = new Proxy({}, { get: (_t, top) => __seg([String(top)]) });
`;

// The wrapper evaluates the body as a module: wrap the model's code in an async IIFE so top-level
// `return` works, and export the awaited result. Model code that needs a module (e.g. node:fs) uses
// dynamic `import()`, which is a valid expression inside the IIFE.
function guestBody(code: string): string {
	return `${PRELUDE}\nexport default await (async () => {\n${code}\n})();\n`;
}

function render(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

// Build an ExecutionResult whose properties are all JSON-safe and never undefined-VALUED: the
// runtime's tool.completed validation rejects undefined-valued properties, so `error`/`logs` are
// absent-if-empty and a missing `result` collapses to null.
function toExecutionResult(input: {
	result: unknown;
	logs: string[];
	error?: string;
}): ExecutionResult {
	return {
		result: input.result === undefined ? null : input.result,
		...(input.logs.length > 0 ? { logs: input.logs } : {}),
		...(input.error !== undefined ? { error: input.error } : {}),
	};
}

// Static per-provider baseline. The per-execution injections (fetchAdapter, mountFs) are visible in
// the ExecutionContext; posture reporting becomes dynamic when the selection registry lands.
const POSTURE: IsolationPosture = {
	kind: "wasm",
	network: "blocked",
	filesystem: "none",
	memoryLimit: true,
	wallClockLimit: true,
};

export function quickjs(config: QuickJsConfig = {}): Sandbox {
	const memoryLimit = config.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
	if (memoryLimit <= 0) {
		throw configurationError("quickjs memoryLimitBytes must be positive", {
			memoryLimitBytes: config.memoryLimitBytes,
			reason:
				"the wrapper treats 0 and -1 as unbounded — a positive cap is required",
		});
	}
	const maxStackSize = config.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;
	const executionTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxTimeoutCount = config.maxTimeoutCount ?? DEFAULT_TIMER_COUNT;
	const maxIntervalCount = config.maxIntervalCount ?? DEFAULT_TIMER_COUNT;

	// loadQuickJs is resource-intensive → load once, lazily, per provider instance.
	let loaded: ReturnType<typeof loadQuickJs> | undefined;
	const load = () => {
		loaded ??= loadQuickJs(variant);
		return loaded;
	};

	return {
		provider: "quickjs",
		posture: POSTURE,

		validate() {
			// Startup validation = "the wasm variant module is present"; a load failure surfaces on
			// first execute.
			if (!variant) {
				throw configurationError("quickjs wasm variant is unavailable", {
					reason: "install @jitl/quickjs-ng-wasmfile-release-sync",
				});
			}
		},

		async execute(input: {
			code: string;
			invoker: SandboxToolInvoker;
			context: ExecutionContext;
		}): Promise<ExecutionResult> {
			const { runSandboxed } = await load();
			const logs: string[] = [];
			const capture =
				(level: string) =>
				(...params: unknown[]) => {
					logs.push(`${level}: ${params.map(render).join(" ")}`);
				};

			const options: SandboxOptions = {
				memoryLimit,
				maxStackSize,
				executionTimeout,
				maxTimeoutCount,
				maxIntervalCount,
				// The ONE host bridge. The wrapper bridges the returned host promise into a guest deferred.
				env: {
					__invoke: (path: string, args: unknown) =>
						input.invoker.invoke({ path, args }),
				},
				// Console is the only overridable ambient injection — route the six levels to the
				// per-execution sink; nothing reaches host stdout.
				console: {
					log: capture("log"),
					warn: capture("warn"),
					error: capture("error"),
					info: capture("info"),
					debug: capture("debug"),
					trace: capture("trace"),
				},
				// Fetch, default-absent. Both flags are required together — the wrapper silently ignores
				// the adapter without allowFetch. Classified seam: the wrapper types the slot as
				// `typeof fetch`; our structural SandboxFetch is the host's governed fetch.
				...(input.context.fetchAdapter
					? {
							allowFetch: true,
							fetchAdapter: input.context
								.fetchAdapter as SandboxOptions["fetchAdapter"],
						}
					: {}),
				// Virtual filesystem, default-absent (memfs; no quota — host bounds size). Classified
				// seam: the wrapper types the tree as NestedDirectoryJSON.
				...(input.context.mountFs
					? {
							allowFs: true,
							mountFs: input.context.mountFs as SandboxOptions["mountFs"],
						}
					: {}),
			};

			const body = guestBody(input.code);
			// Most guest faults come back as `{ ok: false, error }` (syntax error, timeout, thrown fetch
			// stub) — an expected failure VALUE the model reads and fixes. But some abort the underlying
			// wasm runtime and REJECT instead — notably deep recursion, which trips a GC assertion
			// (`list_empty(&rt->gc_obj_list)`) as the aborted context is disposed. That abort is isolated
			// to this one execution (a fresh context is built per call; the module and sibling executions
			// survive — verified), so we catch the throw and convert it to the same failure VALUE rather
			// than letting a host throw escape and fail the whole run_code call.
			try {
				const outcome = await runSandboxed(
					async ({ evalCode }) => evalCode(body),
					options,
				);
				return outcome.ok
					? toExecutionResult({ result: outcome.data, logs })
					: toExecutionResult({
							result: null,
							logs,
							error: outcome.error.message,
						});
			} catch (error) {
				return toExecutionResult({
					result: null,
					logs,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}
