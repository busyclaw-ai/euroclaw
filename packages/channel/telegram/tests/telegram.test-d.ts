// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` produced the
// intended compile-time error — telegramChannel's cron/webhook requirements are enforced at createClaw.
import { createClaw, type RuntimeConfig } from "euroclaw";
import { describe, test } from "vitest";
import { type TelegramClient, telegramChannel } from "../src/index";

declare const model: RuntimeConfig["model"];
declare const client: TelegramClient;

describe("telegramChannel createClaw wiring", () => {
	test("poll mode (default) requires cronHandler; webhook mode does not", () => {
		// @ts-expect-error — default mode is poll, so cronHandler is required
		createClaw({
			model,
			plugins: [telegramChannel({ client, tenantId: "tenant-1" })],
		});
		createClaw({
			cronHandler: { secret: "secret" },
			model,
			plugins: [telegramChannel({ client, tenantId: "tenant-1" })],
		});
		createClaw({
			model,
			plugins: [
				telegramChannel({ client, mode: "webhook", tenantId: "tenant-1" }),
			],
		});
	});

	test("duplicate literal webhook paths are rejected", () => {
		// @ts-expect-error — duplicate literal webhook paths are rejected
		createClaw({
			model,
			plugins: [
				telegramChannel({
					client,
					mode: "webhook",
					tenantId: "tenant-1",
					webhook: { path: "/telegram/same" },
				}),
				telegramChannel({
					client,
					mode: "webhook",
					tenantId: "tenant-1",
					webhook: { path: "/telegram/same" },
				}),
			],
		});
	});
});
