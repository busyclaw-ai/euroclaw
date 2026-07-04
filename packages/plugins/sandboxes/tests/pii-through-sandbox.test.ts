// Isolation hardening — PII THROUGH THE SANDBOX: the euroclaw-defining property. A model-authored
// script reasons on placeholders; the real value is reattached only at a trusted tool boundary, and
// the audit trail stays PII-free. The scripted model mirrors runtime.test.ts: it extracts the
// {{pii:...}} token from the redacted prompt and emits a run_code call whose `code` embeds that
// token, so the run exercises the full ingest→sandbox→nested-tool→audit path.
//
// Scope note: this file commits the CONFIRMED-safe properties (P1 rehydration-at-the-edge, P2
// PII-free audit). The nested-output-confidentiality probes (P3/P4) are tracked as open findings in
// the suite report rather than committed here — they currently observe rehydrated PII reaching the
// untrusted script, which is a boundary decision for the maintainer, not a test to weaken or commit
// red.

import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createMemoryAudit, createMemoryRedactor } from "@euroclaw/core";
import { createRuntime } from "@euroclaw/runtime";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { runCodeTool } from "../src/index";
import { quickjs } from "../src/quickjs/index";

// Known-good email detector, copied verbatim from runtime.test.ts.
const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

// Step 0 extracts the {{pii:...}} token from the redacted prompt and emits a run_code call whose
// `code` is built from that token via `makeCode`; step 1 finishes with "done". Mirrors the
// placeholder-matching scripted model in runtime.test.ts.
function runCodeModel(makeCode: (token: string) => string): V2Model {
	let step = 0;
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const promptText = JSON.stringify(options.prompt);
			const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
			if (step++ === 0) {
				const token =
					promptText.match(/\{\{pii:[a-z0-9]+\}\}/)?.[0] ?? "NOTOKEN";
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "run_code",
							input: JSON.stringify({ code: makeCode(token) }),
						},
					],
					finishReason: "tool-calls",
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: "stop",
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const emailInputSchema = jsonSchema<{ to: string }>({
	type: "object",
	properties: { to: { type: "string" } },
	required: ["to"],
});

describe("@euroclaw/sandboxes PII through the sandbox", () => {
	// P1 — rehydration at the edge works THROUGH the sandbox: the script passes only the placeholder,
	// yet the real value is reattached inside the tool, downstream of the sandbox boundary. (P5: this
	// also confirms the run completes — the token embedded in `code` survived ingest and resolved in
	// the nested call.)
	it("P1: the real value is rehydrated inside the tool, downstream of the sandbox", async () => {
		let captured = "";
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`return await tools.send_email({ to: ${JSON.stringify(token)} });`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async ({ to }) => {
						captured = to;
						return { sent: true };
					},
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(captured).toBe("alice@personal.com");
	}, 30000);

	// P2 — the audit trail is PII-free: the audit is written from redacted text at every boundary
	// (model, run_code, and the nested send_email), so no raw email is ever recorded.
	it("P2: the audit trail contains no raw PII", async () => {
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`return await tools.send_email({ to: ${JSON.stringify(token)} });`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async () => ({ sent: true }),
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(JSON.stringify(runtime.audit?.entries() ?? [])).not.toContain(
			"alice@personal.com",
		);
	}, 30000);
});
