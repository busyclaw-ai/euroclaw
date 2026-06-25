import {
	createStoredRedactor,
	type Detector,
	type EuroclawRouteRequest,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import { createClaw, type RuntimeConfig } from "euroclaw";
import { describe, expect, it } from "vitest";
import {
	handleTelegramUpdate,
	type TelegramClient,
	type TelegramSendMessageInput,
	type TelegramUpdate,
	telegramChannel,
} from "./index";

function textModel(text: string): RuntimeConfig["model"] {
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

function durableRedactor() {
	const db = memoryAdapter();
	const detector: Detector = () => [];
	return {
		db,
		redactor: createStoredRedactor({
			detector,
			mappings: createPiiMappingStore(db),
		}),
	};
}

function fakeClient(updates: TelegramUpdate[] = []) {
	const sent: TelegramSendMessageInput[] = [];
	const getUpdatesInputs: unknown[] = [];
	const client: TelegramClient = {
		getUpdates: async (input) => {
			getUpdatesInputs.push(input);
			return updates;
		},
		sendMessage: async (input) => {
			sent.push(input);
		},
	};
	return { client, getUpdatesInputs, sent };
}

function update(
	input: {
		chatId?: number;
		messageId?: number;
		text?: string;
		updateId?: number;
		userId?: number;
	} = {},
): TelegramUpdate {
	return {
		update_id: input.updateId ?? 1,
		message: {
			message_id: input.messageId ?? 10,
			text: input.text ?? "hello",
			chat: { id: input.chatId ?? 123, title: "Test chat" },
			from: { id: input.userId ?? 456, first_name: "Alice" },
		},
	};
}

describe("telegramChannel", () => {
	it("handles a text update through conversation binding and sendMessage", async () => {
		const { db, redactor } = durableRedactor();
		const fake = fakeClient();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redactor,
		});

		const result = await handleTelegramUpdate({
			claw,
			config: { client: fake.client, tenantId: "tenant-1" },
			update: update(),
		});

		expect(result).toMatchObject({ status: "processed" });
		expect(fake.sent).toEqual([
			{ chatId: 123, replyToMessageId: 10, text: "done" },
		]);
		const messages = await claw.api.listMessages({
			threadId: result.status === "processed" ? result.threadId : "missing",
		});
		expect(messages).toMatchObject([
			{ content: { text: "hello" }, role: "user" },
			{ content: { text: "done" }, role: "assistant" },
		]);
	});

	it("polls updates from cron and persists cursor state", async () => {
		const { db, redactor } = durableRedactor();
		const fake = fakeClient([
			update({ updateId: 40, text: "first" }),
			update({ updateId: 41, text: "second" }),
		]);
		const channel = telegramChannel({
			client: fake.client,
			now: () => "2026-01-01T00:00:00.000Z",
			tenantId: "tenant-1",
		});
		const claw = createClaw({
			cronHandler: { unsafeAllowUnauthenticated: true },
			database: db,
			model: textModel("done"),
			plugins: [channel],
			redactor,
		});

		const task = channel.cron?.[0];
		if (!task) throw new Error("expected poll cron task");
		await expect(task.handler({ claw, limit: 5 })).resolves.toMatchObject({
			processed: 2,
			status: "processed",
		});

		expect(fake.getUpdatesInputs).toEqual([
			{ limit: 5, offset: undefined, timeoutSeconds: undefined },
		]);
		await expect(
			claw.api.getChannelEndpoint({
				endpointKey: "default",
				provider: "telegram",
				tenantId: "tenant-1",
			}),
		).resolves.toMatchObject({
			cursor: { offset: 42 },
			lastPolledAt: "2026-01-01T00:00:00.000Z",
			mode: "poll",
			status: "validated",
		});
	});

	it("validates webhook secret and records endpoint receipt", async () => {
		const { db, redactor } = durableRedactor();
		const fake = fakeClient();
		const channel = telegramChannel({
			client: fake.client,
			mode: "webhook",
			now: () => "2026-01-01T00:00:00.000Z",
			tenantId: "tenant-1",
			webhook: { path: "/telegram/test/webhook", secret: "secret" },
		});
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			plugins: [channel],
			redactor,
		});
		const route = channel.routes?.[0];
		if (!route) throw new Error("expected webhook route");
		const request = (secret?: string) =>
			({
				headers: {
					get: (name: string) =>
						name === "x-telegram-bot-api-secret-token"
							? (secret ?? null)
							: null,
				},
				json: async () => update({ text: "webhook" }),
				method: "POST",
				text: async () => "",
				url: "https://app.test/api/euroclaw/telegram/test/webhook",
			}) satisfies EuroclawRouteRequest;

		await expect(
			route.handler({ claw, params: {}, request: request() }),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			route.handler({ claw, params: {}, request: request("secret") }),
		).resolves.toMatchObject({ body: { ok: true } });
		await expect(
			claw.api.getChannelEndpoint({
				endpointKey: "default",
				provider: "telegram",
				tenantId: "tenant-1",
			}),
		).resolves.toMatchObject({
			lastReceivedAt: "2026-01-01T00:00:00.000Z",
			mode: "webhook",
			status: "validated",
		});
	});
});
