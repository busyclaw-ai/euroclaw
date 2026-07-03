import { describe, expect, it } from "vitest";
import {
	dispatchWebhook,
	type EndpointContext,
	type EndpointEvent,
} from "../src/index";
import {
	type TelegramFetch,
	telegram,
	telegramWebhookSecret,
} from "../src/telegram/index";

const endpoint: EndpointContext = {
	provider: "telegram",
	endpointKey: "default",
	mode: "webhook",
};

/** A fake Bot API server: records every call and serves canned getUpdates results. */
function fakeApi() {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const api = {
		calls,
		updates: [] as unknown[],
		fetch: (async (url, init) => {
			const body = init?.body
				? (JSON.parse(init.body) as Record<string, unknown>)
				: {};
			calls.push({ url, body });
			const result = url.endsWith("/getUpdates") ? api.updates : {};
			return { ok: true, json: async () => ({ ok: true, result }) };
		}) as TelegramFetch,
	};
	return api;
}

function update(overrides: Record<string, unknown> = {}) {
	return {
		update_id: 10,
		message: { message_id: 1, text: "hello", chat: { id: 123 }, ...overrides },
	};
}

describe("telegram channel", () => {
	it("parses a text update into a normalized inbound message", () => {
		const channel = telegram();
		const messages = channel.parseInbound({
			request: {
				headers: { get: () => null },
				rawBody: JSON.stringify(update()),
			},
			endpoint,
		});
		expect(messages).toEqual([
			{
				externalConversationId: "123",
				externalActorId: undefined,
				text: "hello",
				conversationTitle: undefined,
				replyContext: { messageId: 1 },
			},
		]);
	});

	it("ignores updates without a text message", () => {
		const channel = telegram();
		const noText = channel.parseInbound({
			request: {
				headers: { get: () => null },
				rawBody: JSON.stringify({
					update_id: 11,
					message: { chat: { id: 1 } },
				}),
			},
			endpoint,
		});
		expect(noText).toEqual([]);
	});

	it("rejects a non-JSON webhook body as a validation error, not a crash", () => {
		const channel = telegram();
		expect(() =>
			channel.parseInbound({
				request: { headers: { get: () => null }, rawBody: "not-json{" },
				endpoint,
			}),
		).toThrow(/invalid JSON/);
	});

	it("verifies against the secret derived from the bot token — no second credential", () => {
		const channel = telegram({ token: "app-token", fetch: fakeApi().fetch });
		const headers = (value: string | null) => ({
			request: { headers: { get: () => value }, rawBody: "{}" },
			endpoint,
		});
		expect(channel.verify?.(headers(telegramWebhookSecret("app-token")))).toBe(
			true,
		);
		expect(channel.verify?.(headers("wrong"))).toBe(false);
	});

	it("derives a registered connection's secret from its row token, unless webhookSecret overrides", () => {
		const channel = telegram(); // bare transport — nothing configured in code
		const row = (
			overrides: Partial<EndpointContext>,
		): ((value: string | null) => {
			request: { headers: { get: () => string | null }; rawBody: string };
			endpoint: EndpointContext;
		}) => {
			const connection: EndpointContext = {
				provider: "telegram",
				endpointKey: "acme-bot",
				mode: "webhook",
				...overrides,
			};
			return (value) => ({
				request: { headers: { get: () => value }, rawBody: "{}" },
				endpoint: connection,
			});
		};

		// derived from the row's bot token
		const derived = row({ secret: "row-token" });
		expect(channel.verify?.(derived(telegramWebhookSecret("row-token")))).toBe(
			true,
		);
		expect(channel.verify?.(derived("wrong"))).toBe(false);

		// an explicit webhookSecret on the row wins over derivation
		const explicit = row({ secret: "row-token", webhookSecret: "chosen" });
		expect(channel.verify?.(explicit("chosen"))).toBe(true);
		expect(channel.verify?.(explicit(telegramWebhookSecret("row-token")))).toBe(
			false,
		);
	});

	it("fails closed when there is no token to derive a secret from", () => {
		const channel = telegram();
		expect(() =>
			channel.verify?.({
				request: { headers: { get: () => null }, rawBody: "{}" },
				endpoint,
			}),
		).toThrow(/no secret/);
	});

	it("sends a reply through the Bot API with the reply-to message id", async () => {
		const api = fakeApi();
		const channel = telegram({ token: "app-token", fetch: api.fetch });
		await channel.send({
			message: {
				externalConversationId: "123",
				text: "hi back",
				replyContext: { messageId: 7 },
			},
			endpoint,
		});
		expect(api.calls).toMatchObject([
			{
				url: "https://api.telegram.org/botapp-token/sendMessage",
				body: { chat_id: "123", text: "hi back", reply_to_message_id: 7 },
			},
		]);
	});

	it("polls updates and advances the cursor past the highest update id", async () => {
		const api = fakeApi();
		api.updates = [
			update({ text: "one" }),
			{ update_id: 12, message: { text: "two", chat: { id: 9 } } },
		];
		const channel = telegram({
			mode: "poll",
			token: "app-token",
			fetch: api.fetch,
		});
		const result = await channel.poll?.({
			endpoint: { ...endpoint, mode: "poll" },
			cursor: { offset: 5 },
		});
		expect(result?.messages.map((m) => m.text)).toEqual(["one", "two"]);
		expect(result?.cursor).toEqual({ offset: 13 });
		expect(api.calls[0]?.body).toMatchObject({ offset: 5 });
	});

	it("uses the connection row's token for registered bots", async () => {
		const api = fakeApi();
		const channel = telegram({ fetch: api.fetch }); // transport only — no code token
		await channel.send({
			message: { externalConversationId: "9", text: "reply" },
			endpoint: {
				provider: "telegram",
				endpointKey: "acme-bot",
				mode: "webhook",
				secret: "row-token",
			},
		});
		// the credential came straight off the row and onto the wire
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botrow-token/sendMessage",
		);
	});

	it("never serves a connection with the app bot's token, even under a colliding key", async () => {
		const api = fakeApi();
		// the transport carries a code token (allowed as a fallback config) — the adversarial case
		const channel = telegram({ fetch: api.fetch, token: "app-token" });
		await channel.send({
			message: { externalConversationId: "9", text: "reply" },
			endpoint: {
				provider: "telegram",
				// a connection registered as "default" arrives under the namespaced binding key, so it can
				// never satisfy the code-key comparison — the row credential wins
				endpointKey: "connections/default",
				mode: "webhook",
				secret: "row-token",
			},
		});
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botrow-token/sendMessage",
		);
	});

	it("errors clearly on an endpoint with neither a code token nor a stored secret", async () => {
		const channel = telegram({ token: "app-token", fetch: fakeApi().fetch });
		// a key the code token doesn't cover, and no row credential to fall back on
		const unknown: EndpointContext = {
			provider: "telegram",
			endpointKey: "other-bot",
			mode: "poll",
		};
		await expect(
			channel.poll?.({ endpoint: unknown, cursor: undefined }),
		).rejects.toThrow(/no credentials/);
	});

	it("relays a telegram webhook end to end and replies through the Bot API", async () => {
		const api = fakeApi();
		const channel = telegram({ token: "app-token", fetch: api.fetch });
		const events: EndpointEvent[] = [];
		const claw = {
			api: {
				bindConversation: async () => ({
					binding: { id: "b" },
					claw: { id: "claw-1" },
					thread: { id: "thread-1" },
					created: true,
				}),
				sendMessage: async () => ({
					result: { status: "completed", text: "pong" },
					userMessage: { id: "m" },
				}),
			},
		};

		const result = await dispatchWebhook({
			claw,
			channel,
			endpoint,
			request: {
				headers: {
					get: (name) =>
						name === "x-telegram-bot-api-secret-token"
							? telegramWebhookSecret("app-token")
							: null,
				},
				rawBody: JSON.stringify(update({ text: "ping", message_id: 4 })),
			},
			persist: async (event) => {
				events.push(event);
			},
		});

		expect(result.status).toBe(200);
		expect(api.calls).toMatchObject([
			{
				url: "https://api.telegram.org/botapp-token/sendMessage",
				body: { chat_id: "123", text: "pong", reply_to_message_id: 4 },
			},
		]);
		expect(events).toEqual([{ kind: "received" }]);
	});
});
