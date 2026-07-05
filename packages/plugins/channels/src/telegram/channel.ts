import {
	configurationError,
	errorMessage,
	validationError,
} from "@euroclaw/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	APP_ENDPOINT_KEY,
	type Channel,
	type ChannelEndpointMode,
	type EndpointContext,
	type InboundMessage,
} from "../core/contracts";
import {
	createTelegramClient,
	type TelegramClient,
	type TelegramFetch,
} from "./client";

// ── Telegram wire format (the untrusted-boundary schemas the adapter parses into normalized messages) ─
const telegramId = type("string | number");
const telegramUser = type({
	id: telegramId,
	"is_bot?": "boolean | undefined",
	"first_name?": "string | undefined",
	"username?": "string | undefined",
});
const telegramChat = type({
	id: telegramId,
	"type?": "string | undefined",
	"title?": "string | undefined",
	"username?": "string | undefined",
});
const telegramMessage = type({
	"message_id?": "number | undefined",
	"text?": "string | undefined",
	chat: telegramChat,
	"from?": telegramUser.or("undefined"),
});
const telegramUpdate = type({
	update_id: "number",
	"message?": telegramMessage.or("undefined"),
});
const telegramUpdates = telegramUpdate.array();
const telegramCursor = type({ "offset?": "number | undefined" });

type TelegramUpdate = typeof telegramUpdate.infer;

export type TelegramConfig = {
	/** Bot token for the app's own bot; defaults to the TELEGRAM_BOT_TOKEN environment variable. */
	token?: string;
	/** Transport for the app's own bot; defaults to webhook (poll is opt-in and contributes the cron). */
	mode?: ChannelEndpointMode;
	/**
	 * Distinguishes multiple app bots — becomes the bot's endpoint key and webhook path segment
	 * (/channels/telegram/webhook/:name). A provider's only bot needs none; channels() demands
	 * distinct names when two telegram bots are registered (compile-time + runtime).
	 */
	name?: string;
	/** Bot API base URL for a self-hosted server; defaults to https://api.telegram.org. */
	apiBaseUrl?: string;
	/** Fetch implementation override (proxies, tests); defaults to global fetch. */
	fetch?: TelegramFetch;
	poll?: { limit?: number; timeoutSeconds?: number };
};

/**
 * The webhook secret for a bot — derived from its token (domain-separated hash), so verification
 * needs no second credential: telegraf's secretPathComponent precedent, on Telegram's official
 * secret_token mechanism. Pass this value as `secret_token` when you call setWebhook; `verify`
 * expects it in the X-Telegram-Bot-Api-Secret-Token header. A connection row's explicit
 * webhookSecret overrides the derivation.
 */
export function telegramWebhookSecret(token: string): string {
	return bytesToHex(
		sha256(utf8ToBytes(`euroclaw:telegram:webhook-secret:${token}`)),
	);
}

function envToken(): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string> } })
		.process?.env;
	return env?.TELEGRAM_BOT_TOKEN;
}

function parseUpdate(input: unknown): TelegramUpdate {
	const valid = telegramUpdate(input);
	if (valid instanceof type.errors) {
		throw validationError("telegram update invalid", valid.summary);
	}
	return valid;
}

function parseUpdates(input: unknown): TelegramUpdate[] {
	const valid = telegramUpdates(input);
	if (valid instanceof type.errors) {
		throw validationError("telegram updates invalid", valid.summary);
	}
	return valid;
}

function cursorOffset(cursor: unknown): number | undefined {
	if (cursor === undefined) return undefined;
	const valid = telegramCursor(cursor);
	return valid instanceof type.errors ? undefined : valid.offset;
}

// A telegram update → a normalized inbound message, or null when there's nothing to relay.
function inboundFrom(update: TelegramUpdate): InboundMessage | null {
	const message = update.message;
	if (!message?.text) return null;
	return {
		externalConversationId: String(message.chat.id),
		externalActorId:
			message.from?.id !== undefined ? String(message.from.id) : undefined,
		text: message.text,
		conversationTitle: message.chat.title ?? message.chat.username,
		replyContext:
			message.message_id !== undefined
				? { messageId: message.message_id }
				: undefined,
	};
}

function replyMessageId(replyContext: unknown): number | undefined {
	if (replyContext === null || typeof replyContext !== "object")
		return undefined;
	const id = (replyContext as { messageId?: unknown }).messageId;
	return typeof id === "number" ? id : undefined;
}

/** Compile-time poll flag: a channel contributes cron only when it declares a poll endpoint. */
type TelegramPoll<Config> = Config extends { mode: "poll" } ? true : false;

/** The literal bot name (feeds channels()'s distinct-key fold), or undefined for the unnamed bot. */
type TelegramName<Config> = Config extends { name: infer N extends string }
	? N
	: undefined;

/**
 * The Telegram channel. With a token it is the app's own bot (channels plugin) — webhook
 * verification derives from the token, so nothing else is required. Bare `telegram()` is the pure
 * transport for channelConnections: every endpoint-specific value (token, webhook secret, organization,
 * defaults) resolves from the connection row via the EndpointContext. The `$poll` marker lets
 * `channels()` derive its cron requirement at compile time; the overloads keep it a literal without
 * a cast.
 */
export function telegram(): Channel & {
	readonly provider: "telegram";
	readonly name: undefined;
	readonly $poll: false;
};
export function telegram<const Config extends TelegramConfig>(
	config: Config,
): Channel & {
	readonly provider: "telegram";
	readonly name: TelegramName<Config>;
	readonly $poll: TelegramPoll<Config>;
};
export function telegram(
	config: TelegramConfig = {},
): Channel & { readonly $poll: boolean } {
	const mode: ChannelEndpointMode = config.mode ?? "webhook";
	const key = config.name ?? APP_ENDPOINT_KEY;
	const codeToken = config.token ?? envToken();

	// The token for one endpoint: the code token for THIS bot's key, otherwise the one stored on
	// the connection row (the sso model — read the credential back). Missing everywhere is a setup
	// gap the caller surfaces.
	const tokenFor = (endpoint: EndpointContext): string | undefined =>
		codeToken && endpoint.endpointKey === key ? codeToken : endpoint.secret;

	const clientFor = (endpoint: EndpointContext): TelegramClient => {
		const token = tokenFor(endpoint);
		if (!token) {
			throw configurationError("telegram endpoint has no credentials", {
				endpointKey: endpoint.endpointKey,
				reason:
					"pass token in code, or register the connection with a stored secret",
			});
		}
		return createTelegramClient({
			apiBaseUrl: config.apiBaseUrl,
			fetch: config.fetch,
			token,
		});
	};

	return {
		provider: "telegram",
		name: config.name,
		supports: { webhook: true, poll: true },
		mode,
		// Phantom-ish marker read by channels() at the type level; its runtime value tracks the mode.
		$poll: mode === "poll",

		validate() {
			// Called by channels() only: an app bot without a token (config or TELEGRAM_BOT_TOKEN) can
			// never send, poll, or verify — refuse at startup instead of erroring on first traffic.
			if (!codeToken) {
				throw configurationError("telegram bot has no token", {
					...(config.name !== undefined ? { name: config.name } : {}),
					reason:
						"pass telegram({ token }) or set the TELEGRAM_BOT_TOKEN environment variable",
				});
			}
		},

		verify({ request, endpoint }) {
			// A connection row's explicit webhookSecret wins; otherwise the secret derives from the bot
			// token (telegramWebhookSecret) — no second credential to configure. No token at all fails
			// CLOSED — an open webhook would relay attacker text straight into a model run — and loudly:
			// a missing credential is a setup gap, not a bad request.
			const token = tokenFor(endpoint);
			const secret =
				endpoint.webhookSecret ??
				(token !== undefined ? telegramWebhookSecret(token) : undefined);
			if (!secret) {
				throw configurationError("telegram webhook endpoint has no secret", {
					endpointKey: endpoint.endpointKey,
					reason:
						"pass a bot token (the secret_token derives from it) or set webhookSecret on the connection",
				});
			}
			return request.headers.get("x-telegram-bot-api-secret-token") === secret;
		},

		parseInbound({ request }) {
			let body: unknown;
			try {
				body = JSON.parse(request.rawBody);
			} catch (err) {
				// a validation error, not a raw SyntaxError — junk bytes are the caller's fault, not a crash
				throw validationError(
					"telegram webhook body invalid JSON",
					errorMessage(err),
				);
			}
			const update = parseUpdate(body);
			const message = inboundFrom(update);
			return message ? [message] : [];
		},

		async send({ message, endpoint }) {
			await clientFor(endpoint).sendMessage({
				chatId: message.externalConversationId,
				text: message.text,
				replyToMessageId: replyMessageId(message.replyContext),
			});
		},

		async poll({ endpoint, cursor, limit }) {
			const offset = cursorOffset(cursor);
			const updates = parseUpdates(
				await clientFor(endpoint).getUpdates({
					offset,
					limit: limit ?? config.poll?.limit,
					timeoutSeconds: config.poll?.timeoutSeconds,
				}),
			);
			let nextOffset = offset;
			const messages: InboundMessage[] = [];
			for (const update of updates) {
				nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
				const message = inboundFrom(update);
				if (message) messages.push(message);
			}
			return {
				messages,
				cursor: nextOffset === undefined ? undefined : { offset: nextOffset },
			};
		},
	};
}
