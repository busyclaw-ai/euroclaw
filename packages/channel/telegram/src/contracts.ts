import type { EuroclawPlugin } from "@euroclaw/contracts";
import type {
	BindConversationClawInput,
	BindConversationThreadInput,
} from "euroclaw";
import type {
	telegramChannelMode,
	telegramChat,
	telegramCursor,
	telegramGetUpdatesInput,
	telegramMessage,
	telegramSendMessageInput,
	telegramUpdate,
	telegramUpdateResult,
	telegramUser,
} from "./schema";

export type TelegramChannelMode = typeof telegramChannelMode.infer;
export type TelegramUser = typeof telegramUser.infer;
export type TelegramChat = typeof telegramChat.infer;
export type TelegramMessage = typeof telegramMessage.infer;
export type TelegramUpdate = typeof telegramUpdate.infer;
export type TelegramGetUpdatesInput = typeof telegramGetUpdatesInput.infer;
export type TelegramSendMessageInput = typeof telegramSendMessageInput.infer;
export type TelegramUpdateResult = typeof telegramUpdateResult.infer;
export type TelegramCursor = typeof telegramCursor.infer;

export type TelegramFetchResponse = {
	ok: boolean;
	status?: number;
	json: () => Promise<unknown>;
};

export type TelegramFetch = (
	input: string,
	init?: {
		body?: string;
		headers?: Record<string, string>;
		method?: string;
	},
) => Promise<TelegramFetchResponse>;

export type TelegramClient = {
	getUpdates: (input: TelegramGetUpdatesInput) => Promise<TelegramUpdate[]>;
	sendMessage: (input: TelegramSendMessageInput) => Promise<unknown>;
};

export type TelegramChannelConfig = {
	tenantId: string;
	client: TelegramClient;
	endpointKey?: string;
	mode?: TelegramChannelMode;
	claw?: BindConversationClawInput;
	thread?: BindConversationThreadInput;
	now?: () => string;
	poll?: {
		limit?: number;
		timeoutSeconds?: number;
	};
	webhook?: {
		path?: `/${string}`;
		secret?: string;
		headerName?: string;
	};
};

export type ModeOf<Config> = Config extends { mode: infer Mode }
	? Mode extends TelegramChannelMode
		? Mode
		: "poll"
	: "poll";

export type TelegramHasCron<Config> =
	ModeOf<Config> extends "both" | "poll" ? "has-cron" : "no-cron";

export type TelegramWebhookPath<Config> = Config extends {
	webhook: { path: infer Path };
}
	? Path extends `/${string}`
		? Path
		: "/telegram/webhook"
	: "/telegram/webhook";

export type TelegramRoutePaths<Config> =
	ModeOf<Config> extends "both" | "webhook"
		? [TelegramWebhookPath<Config>]
		: [];

export type TelegramChannel<Config extends TelegramChannelConfig> =
	EuroclawPlugin<TelegramHasCron<Config>, TelegramRoutePaths<Config>> & {
		kind: "channel";
		provider: "telegram";
	};
