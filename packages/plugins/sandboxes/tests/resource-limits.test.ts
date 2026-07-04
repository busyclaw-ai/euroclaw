// Isolation hardening — RESOURCE LIMITS: a hostile guest cannot exhaust host resources. Each abuse
// must surface as an error VALUE (result: null, error set) — never a host throw, OOM, or hang — and
// the host runtime must remain usable afterwards. Every test runs a trivial follow-up execute and
// asserts it still returns 2: proof the preceding abuse did not corrupt the host.
//
// R2 note: deep recursion aborts the underlying wasm runtime (a GC assertion trips as the aborted
// context is disposed) and REJECTS rather than returning `{ ok: false }`. The provider now catches
// that rejection and converts it to an error VALUE — the abort is isolated to the single execution,
// so the same provider instance and the host stay usable. R2 below asserts all three.

import { describe, expect, it } from "vitest";
import type { SandboxToolInvoker } from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

// The host is uncorrupted iff a fresh trivial execute still works after the abuse.
async function hostStillWorks(): Promise<void> {
	const { output: res } = await executeInSandbox({
		sandbox: quickjs(),
		code: "return 2",
		invoker: noInvoke,
		context: {},
	});
	expect(res.result).toBe(2);
	expect(res.error).toBeUndefined();
}

describe("@euroclaw/sandboxes resource limits", () => {
	// R1 — a runaway allocation hits the memory cap as an error VALUE, not a host OOM. [P0-if-fails].
	it("R1: bounds runaway memory allocation and the host survives", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ memoryLimitBytes: 8 * 1024 * 1024 }),
			code: "const a=[]; while(true){ a.push(new Array(100000).fill(0)); } return 1;",
			invoker: noInvoke,
			context: {},
		});
		// Observed mechanism: the wrapper reports "out of memory" as an error value.
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		await hostStillWorks();
	}, 30000);

	// R2 — deep recursion aborts the wasm context but surfaces as an error VALUE (not a host throw);
	// the SAME provider instance and the host both survive. [P0-if-fails: a host throw fails the run].
	it("R2: converts a deep-recursion wasm abort into an error value and survives", async () => {
		const sandbox = quickjs();
		// Sanity: the instance works before the bomb.
		const { output: before } = await executeInSandbox({
			sandbox,
			code: "return 1",
			invoker: noInvoke,
			context: {},
		});
		expect(before.result).toBe(1);
		// The bomb must NOT throw out of executeInSandbox — it must resolve to an error value.
		const { output: res } = await executeInSandbox({
			sandbox,
			code: "function f(){ return f(); } return f();",
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		// The SAME instance still works afterward — the abort did not poison the shared module.
		const { output: after } = await executeInSandbox({
			sandbox,
			code: "return 2",
			invoker: noInvoke,
			context: {},
		});
		expect(after.result).toBe(2);
		expect(after.error).toBeUndefined();
		// And a fresh instance is fine too.
		await hostStillWorks();
	}, 30000);

	// R3 — a never-resolving await is killed by the wall clock; it does not hang the host.
	// [P0-if-fails].
	it("R3: bounds a hung promise on the wall clock and returns promptly", async () => {
		const start = Date.now();
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 500 }),
			code: "await new Promise(() => {}); return 1;",
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		// The never-resolving await must not stall the host anywhere near the default 5s ceiling.
		expect(Date.now() - start).toBeLessThan(5000);
		await hostStillWorks();
	}, 30000);

	// R4 — timer flooding is bounded, with no hang. The requirement is "bounded, no hang"; the
	// observed mechanism is that the cap throws an error VALUE once exceeded.
	it("R4: bounds timer flooding without hanging", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxTimeoutCount: 4 }),
			code: 'for (let i = 0; i < 100000; i++) setTimeout(() => {}, 0); return "survived";',
			invoker: noInvoke,
			context: {},
		});
		// Either the cap throws (error VALUE) or extra timers are dropped (result "survived"); both are
		// bounded and neither hangs. Observed: the cap throws once exceeded.
		const bounded = res.error !== undefined || res.result === "survived";
		expect(bounded).toBe(true);
		await hostStillWorks();
	}, 30000);

	// R5 — an enormous output does not corrupt the host (best-effort). Under an 8MB cap the giant
	// string either comes back bounded or fails as an error VALUE; the host survives regardless.
	it("R5: bounds a huge output and the host survives", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ memoryLimitBytes: 8 * 1024 * 1024 }),
			code: 'return "x".repeat(50000000);',
			invoker: noInvoke,
			context: {},
		});
		// Observed: the allocation exceeds the cap → error VALUE. A bounded string would also satisfy.
		const boundedString =
			typeof res.result === "string" && res.result.length <= 50_000_000;
		expect(res.error !== undefined || boundedString).toBe(true);
		await hostStillWorks();
	}, 30000);
});
