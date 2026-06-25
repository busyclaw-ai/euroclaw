import { type } from "arktype";

export const telegramChannelModeValues = [
	"poll",
	"webhook",
	"both",
	"none",
] as const;

export const telegramChannelMode = type("'poll' | 'webhook' | 'both' | 'none'");

export const telegramId = type("string | number");

export const telegramUser = type({
	id: telegramId,
	"is_bot?": "boolean | undefined",
	"first_name?": "string | undefined",
	"username?": "string | undefined",
});

export const telegramChat = type({
	id: telegramId,
	"type?": "string | undefined",
	"title?": "string | undefined",
	"username?": "string | undefined",
});

export const telegramMessage = type({
	"message_id?": "number | undefined",
	"text?": "string | undefined",
	chat: telegramChat,
	"from?": telegramUser.or("undefined"),
});

export const telegramUpdate = type({
	update_id: "number",
	"message?": telegramMessage.or("undefined"),
});

export const telegramUpdates = telegramUpdate.array();

export const telegramGetUpdatesInput = type({
	"offset?": "number | undefined",
	"limit?": "number | undefined",
	"timeoutSeconds?": "number | undefined",
});

export const telegramSendMessageInput = type({
	chatId: telegramId,
	text: "string",
	"replyToMessageId?": "number | undefined",
});

export const telegramCursor = type({
	"offset?": "number | undefined",
});

export const telegramUpdateProcessedResult = type({
	status: "'processed'",
	clawId: "string",
	threadId: "string",
});

export const telegramUpdateIgnoredResult = type({
	status: "'ignored'",
	reason: "string",
});

export const telegramUpdateResult = telegramUpdateProcessedResult.or(
	telegramUpdateIgnoredResult,
);
