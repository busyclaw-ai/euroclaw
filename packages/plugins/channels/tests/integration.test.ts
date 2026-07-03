import { field } from "@euroclaw/contracts";
import { createStoredRedactor, noopDetector } from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import type { wrapLanguageModel } from "ai";
import { createClaw, getEuroclawTables } from "euroclaw";
import { describe, expect, it, vi } from "vitest";
import { channelConnections } from "../src/connections/index";
import { type Channel, channels } from "../src/index";
import { telegram } from "../src/telegram/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function textModel(text: string): V2Model {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

function appBot() {
	// the app's own bot: a token is the whole config — webhook verification derives from it
	return telegram({ token: "app-token" });
}

describe("channels ↔ euroclaw integration", () => {
	it("collects each plugin's own table via getEuroclawTables", () => {
		const withPlugins = getEuroclawTables({
			plugins: [channels([appBot()]), channelConnections([telegram()])],
		});
		// channels owns operational state only — no credentials, no tenancy
		expect(withPlugins.channel_endpoint?.fields.cursor).toBeDefined();
		expect(withPlugins.channel_endpoint?.fields.secret).toBeUndefined();
		expect(withPlugins.channel_endpoint?.fields.tenantId).toBeUndefined();
		// channelConnections owns the registration row — the ssoProvider analog
		expect(withPlugins.channel_connection?.fields.secret).toBeDefined();
		expect(withPlugins.channel_connection?.fields.webhookSecret).toBeDefined();
		expect(withPlugins.channel_connection?.fields.tenantId).toBeDefined();
		// conversation_binding stayed core (the `account` analog), keyed by endpoint
		expect(withPlugins.conversation_binding?.fields.endpointKey).toBeDefined();
		expect(withPlugins.conversation_binding?.fields.tenantId).toBeUndefined();
	});

	it("does not put channel tables in core — only the plugins bring them", () => {
		const core = getEuroclawTables({});
		expect(core.channel_endpoint).toBeUndefined();
		expect(core.channel_connection).toBeUndefined();
		expect(core.conversation_binding).toBeDefined();
	});

	it("wires both plugins into createClaw and exposes the connections api", async () => {
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
			plugins: [channels([appBot()]), channelConnections([telegram()])],
		});
		// the connections namespace is present (no getEuroclawTables collision at construction)
		expect(claw.api.channels.connections).toBeDefined();

		// register a user's bot at runtime through the public api, read it back
		const created = await claw.api.channels.connections.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			mode: "webhook",
			secret: "bot-token",
			webhookSecret: "hook",
			tenantId: "org-acme",
		});
		expect(created).toMatchObject({ status: "active", tenantId: "org-acme" });
		expect(
			await claw.api.channels.connections.getByKey({
				provider: "telegram",
				endpointKey: "acme-bot",
			}),
		).toMatchObject({ id: created.id });
	});

	it("runtime-rejects duplicate unnamed bots (the compile-time fold's mirror)", () => {
		// widened to Channel[] so the literal-key fold can't see the duplicate — runtime must
		const dupes: Channel[] = [appBot(), telegram()];
		expect(() => channels(dupes)).toThrow(/duplicate channel/);
	});

	it("fails at startup when an app bot has no token anywhere", () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
		try {
			// a dead bot fails at wiring time, not on first traffic
			expect(() => channels([telegram()])).toThrow(/telegram bot has no token/);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("resolves the token from TELEGRAM_BOT_TOKEN at startup", () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
		try {
			expect(() => channels([telegram()])).not.toThrow();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps bare telegram() valid as a connections transport — no startup token check", () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
		try {
			// credentials live on the rows; the transport itself needs none
			expect(() => channelConnections([telegram()])).not.toThrow();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("rejects a plugin schema that redefines a core claw column at createClaw", () => {
		// sanity that the collision guard still fires for genuine core-column clashes
		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [
					{
						id: "evil",
						schema: { claw: { fields: { status: field.string() } } },
					} as never,
				],
			}),
		).toThrow(/redefines core column/);
	});
});
