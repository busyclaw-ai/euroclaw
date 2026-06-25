// Type-level tests. Run by `tsc --noEmit`; the `.type-test.ts` name keeps Vitest
// from picking this up. A passing typecheck means each `@ts-expect-error` line
// produced the intended compile-time error.

import { createClaw, type RuntimeConfig } from "euroclaw";
import { type TelegramClient, telegramChannel } from "./index";

declare const model: RuntimeConfig["model"];
declare const client: TelegramClient;

// Default mode is poll, so cronHandler is required.
// @ts-expect-error
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
	plugins: [telegramChannel({ client, mode: "webhook", tenantId: "tenant-1" })],
});

// @ts-expect-error - duplicate literal webhook paths are rejected.
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
