import {
	configurationError,
	type EuroclawRoute,
	type EuroclawRouteContext,
	errorMessage,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type { Claw } from "euroclaw";
import type {
	TelegramChannel,
	TelegramChannelConfig,
	TelegramChannelMode,
	TelegramChat,
	TelegramClient,
	TelegramCursor,
	TelegramFetch,
	TelegramMessage,
	TelegramUpdate,
	TelegramUpdateResult,
} from "./contracts";
import {
	telegramCursor,
	telegramUpdate,
	telegramUpdateResult,
	telegramUpdates,
} from "./schema";

export type {
	TelegramChannel,
	TelegramChannelConfig,
	TelegramChannelMode,
	TelegramChat,
	TelegramClient,
	TelegramCursor,
	TelegramFetch,
	TelegramGetUpdatesInput,
	TelegramMessage,
	TelegramSendMessageInput,
	TelegramUpdate,
	TelegramUpdateResult,
} from "./contracts";
export {
	telegramChannelMode,
	telegramChat,
	telegramCursor,
	telegramGetUpdatesInput,
	telegramId,
	telegramMessage,
	telegramSendMessageInput,
	telegramUpdate,
	telegramUpdateIgnoredResult,
	telegramUpdateProcessedResult,
	telegramUpdateResult,
	telegramUpdates,
	telegramUser,
} from "./schema";

function modeFrom(config: TelegramChannelConfig): TelegramChannelMode {
	return config.mode ?? "poll";
}

function endpointKeyFrom(config: TelegramChannelConfig): string {
	return config.endpointKey ?? "default";
}

function endpointKeyForMode(
	config: TelegramChannelConfig,
	mode: "poll" | "webhook",
): string {
	const key = endpointKeyFrom(config);
	return config.mode === "both" ? `${key}:${mode}` : key;
}

function nowFrom(config: TelegramChannelConfig): string {
	return (config.now ?? (() => new Date().toISOString()))();
}

function parseTelegramUpdate(input: unknown): TelegramUpdate {
	const valid = telegramUpdate(input);
	if (valid instanceof ark.errors) {
		throw validationError("telegram update invalid", valid.summary);
	}
	return valid;
}

function parseTelegramUpdates(input: unknown): TelegramUpdate[] {
	const valid = telegramUpdates(input);
	if (valid instanceof ark.errors) {
		throw validationError("telegram updates invalid", valid.summary);
	}
	return valid;
}

function parseTelegramCursor(input: unknown): TelegramCursor | undefined {
	if (input === undefined) return undefined;
	const valid = telegramCursor(input);
	if (valid instanceof ark.errors) return undefined;
	return valid;
}

function assertTelegramUpdateResult(
	input: TelegramUpdateResult,
): TelegramUpdateResult {
	const valid = telegramUpdateResult(input);
	if (valid instanceof ark.errors) {
		throw validationError("telegram update result invalid", valid.summary);
	}
	return input;
}

function cursorOffset(cursor: unknown): number | undefined {
	return parseTelegramCursor(cursor)?.offset;
}

function messageFrom(update: TelegramUpdate): TelegramMessage | undefined {
	return update.message;
}

function chatTitle(chat: TelegramChat): string | undefined {
	return chat.title ?? chat.username;
}

export async function handleTelegramUpdate(input: {
	claw: Claw;
	config: TelegramChannelConfig;
	update: TelegramUpdate;
}): Promise<TelegramUpdateResult> {
	const update = parseTelegramUpdate(input.update);
	const message = messageFrom(update);
	if (!message) {
		return assertTelegramUpdateResult({
			status: "ignored",
			reason: "unsupported update",
		});
	}
	if (!message.text) {
		return assertTelegramUpdateResult({
			status: "ignored",
			reason: "non-text message",
		});
	}

	const binding = await input.claw.api.bindConversation({
		provider: "telegram",
		tenantId: input.config.tenantId,
		externalConversationId: String(message.chat.id),
		externalActorId:
			message.from?.id !== undefined ? String(message.from.id) : undefined,
		claw: input.config.claw,
		thread: {
			...input.config.thread,
			title: input.config.thread?.title ?? chatTitle(message.chat),
		},
	});
	const sent = await input.claw.api.sendMessage({
		clawId: binding.claw.id,
		message: message.text,
		threadId: binding.thread.id,
	});
	if (sent.result.status === "completed" && sent.result.text) {
		await input.config.client.sendMessage({
			chatId: message.chat.id,
			replyToMessageId: message.message_id,
			text: sent.result.text,
		});
	}
	return assertTelegramUpdateResult({
		status: "processed",
		clawId: binding.claw.id,
		threadId: binding.thread.id,
	});
}

async function pollTelegram(input: {
	claw: Claw;
	config: TelegramChannelConfig;
	limit?: number;
}) {
	const endpointKey = endpointKeyForMode(input.config, "poll");
	const endpoint = await input.claw.api.getChannelEndpoint({
		provider: "telegram",
		tenantId: input.config.tenantId,
		endpointKey,
	});
	const offset = cursorOffset(endpoint?.cursor);
	try {
		const updates = parseTelegramUpdates(
			await input.config.client.getUpdates({
				offset,
				limit: input.limit ?? input.config.poll?.limit,
				timeoutSeconds: input.config.poll?.timeoutSeconds,
			}),
		);
		let processed = 0;
		let nextOffset = offset;
		for (const update of updates) {
			nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
			const result = await handleTelegramUpdate({
				claw: input.claw,
				config: input.config,
				update,
			});
			if (result.status === "processed") processed++;
		}
		await input.claw.api.upsertChannelEndpoint({
			provider: "telegram",
			tenantId: input.config.tenantId,
			endpointKey,
			mode: "poll",
			status: "validated",
			cursor: nextOffset === undefined ? undefined : { offset: nextOffset },
			lastError: null,
			lastPolledAt: nowFrom(input.config),
		});
		return {
			processed,
			status: updates.length === 0 ? ("idle" as const) : ("processed" as const),
			data: { updates: updates.length },
		};
	} catch (error) {
		await input.claw.api.upsertChannelEndpoint({
			provider: "telegram",
			tenantId: input.config.tenantId,
			endpointKey,
			mode: "poll",
			status: "error",
			lastError: { message: errorMessage(error) },
			lastPolledAt: nowFrom(input.config),
		});
		throw error;
	}
}

function webhookRoute(config: TelegramChannelConfig): EuroclawRoute {
	const path = config.webhook?.path ?? "/telegram/webhook";
	return {
		id: `channel:telegram:${endpointKeyFrom(config)}:webhook`,
		method: "POST" as const,
		path,
		handler: async ({ claw, request }: EuroclawRouteContext) => {
			const routeClaw = claw as Claw;
			const headerName =
				config.webhook?.headerName ?? "x-telegram-bot-api-secret-token";
			if (
				config.webhook?.secret &&
				request.headers.get(headerName) !== config.webhook.secret
			) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			const update = parseTelegramUpdate(await request.json());
			const result = await handleTelegramUpdate({
				claw: routeClaw,
				config,
				update,
			});
			await routeClaw.api.upsertChannelEndpoint({
				provider: "telegram",
				tenantId: config.tenantId,
				endpointKey: endpointKeyForMode(config, "webhook"),
				mode: "webhook",
				status: "validated",
				lastError: null,
				lastReceivedAt: nowFrom(config),
			});
			return { body: { ok: true, data: result } };
		},
	};
}

export function telegramChannel<const Config extends TelegramChannelConfig>(
	config: Config,
): TelegramChannel<Config> {
	const mode = modeFrom(config);
	const endpointKey = endpointKeyFrom(config);
	return {
		id: `channel:telegram:${endpointKey}`,
		kind: "channel",
		provider: "telegram",
		cron:
			mode === "poll" || mode === "both"
				? [
						{
							id: `channel:telegram:${endpointKey}:poll`,
							handler: ({ claw, limit }) =>
								pollTelegram({ claw: claw as Claw, config, limit }),
						},
					]
				: [],
		routes: mode === "webhook" || mode === "both" ? [webhookRoute(config)] : [],
	};
}

export function createTelegramClient(input: {
	botToken: string;
	fetch?: TelegramFetch;
	apiBaseUrl?: string;
}): TelegramClient {
	const globalFetch = (globalThis as { fetch?: TelegramFetch }).fetch;
	const resolvedFetch = input.fetch ?? globalFetch?.bind(globalThis);
	if (!resolvedFetch) {
		throw configurationError("Telegram fetch implementation is unavailable", {
			reason: "pass fetch or run in an environment with global fetch",
		});
	}
	const fetcher: TelegramFetch = resolvedFetch;
	const baseUrl = input.apiBaseUrl ?? "https://api.telegram.org";
	async function call(method: string, body: Record<string, unknown>) {
		const response = await fetcher(
			`${baseUrl}/bot${input.botToken}/${method}`,
			{
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
		);
		const data = (await response.json()) as { ok?: boolean; result?: unknown };
		if (!response.ok || data.ok === false) {
			throw stateError("Telegram API request failed", {
				method,
				status: response.status,
				telegramOk: data.ok,
			});
		}
		return data.result;
	}
	return {
		getUpdates: async ({ offset, limit, timeoutSeconds }) =>
			(await call("getUpdates", {
				offset,
				limit,
				timeout: timeoutSeconds,
			})) as TelegramUpdate[],
		sendMessage: ({ chatId, text, replyToMessageId }) =>
			call("sendMessage", {
				chat_id: chatId,
				text,
				reply_to_message_id: replyToMessageId,
			}),
	};
}
