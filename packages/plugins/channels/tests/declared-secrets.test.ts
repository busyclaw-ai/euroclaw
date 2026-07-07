// Each telegram app bot declares its own token secret name; the `channels` plugin aggregates those
// into `plugin.secrets`, so the assembly's required-names list enumerates them. `channelConnections`
// declares nothing — a connection's token lives in its row, not under a `secrets.get` name.
import { collectSecretDeclarations } from "euroclaw";
import { describe, expect, it } from "vitest";
import { channelConnections } from "../src/connections/index";
import { channels } from "../src/index";
import { telegram } from "../src/telegram/index";

describe("channels — telegram secret declarations", () => {
	it("declares the unnamed app bot's canonical token name", () => {
		const plugin = channels([telegram()]);
		expect(plugin.secrets).toEqual([
			{ name: "TELEGRAM_BOT_TOKEN", description: "Telegram app-bot token" },
		]);
	});

	it("declares a named bot under its own tokenRef", () => {
		const plugin = channels([
			telegram({ name: "sales", tokenRef: "SALES_TOKEN" }),
		]);
		expect(plugin.secrets).toEqual([
			{ name: "SALES_TOKEN", description: 'Telegram bot token for "sales"' },
		]);
	});

	it("aggregates every app bot's declaration across the registry", () => {
		const plugin = channels([
			telegram({}),
			telegram({ name: "sales", tokenRef: "SALES_TOKEN" }),
		]);
		expect(plugin.secrets).toEqual([
			{ name: "TELEGRAM_BOT_TOKEN", description: "Telegram app-bot token" },
			{ name: "SALES_TOKEN", description: 'Telegram bot token for "sales"' },
		]);
	});

	it("surfaces the declaration through the assembly's collected declarations", () => {
		// collectSecretDeclarations is what createClaw runs to build the required-names set.
		const collected = collectSecretDeclarations([
			channels([telegram({ tokenRef: "X" })]),
		]);
		expect(collected).toContainEqual({
			name: "X",
			description: "Telegram app-bot token",
		});
	});

	it("channelConnections declares NOTHING — connection tokens live in the row", () => {
		expect(channelConnections([telegram()]).secrets).toBeUndefined();
	});
});
