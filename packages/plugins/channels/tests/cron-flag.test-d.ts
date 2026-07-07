// Type tests (vitest typecheck mode). Prove that both plugins derive their cron requirement at
// compile time: channels() from the providers' poll flags, channelConnections() from its poll
// option. A passing run means each @ts-expect-error errored.
import { createClaw, type RuntimeConfig } from "euroclaw";
import { describe, test } from "vitest";
import { channelConnections } from "../src/connections/index";
import { type Channel, channels } from "../src/index";
import { telegram } from "../src/telegram/index";

declare const model: RuntimeConfig["model"];

// A second provider for the mixed-registry case (channels() rejects duplicate providers at runtime).
// Webhook-only with an explicit `$poll: false`, so it never contributes the cron requirement.
const hooksOnly = {
	provider: "hooks",
	supports: { webhook: true, poll: false },
	mode: "webhook",
	parseInbound: () => [],
	send: async () => {},
	$poll: false,
} satisfies Channel & { readonly $poll: false };

describe("channels cron-handler requirement", () => {
	test("a webhook-only channel registry needs no cronHandler", () => {
		createClaw({ model, plugins: [channels([telegram()])] });
		createClaw({
			model,
			plugins: [channels([telegram({ mode: "webhook" })])],
		});
	});

	test("a poll channel requires cronHandler, statically", () => {
		// @ts-expect-error — a poll channel contributes cron, so cronHandler is required
		createClaw({
			model,
			plugins: [channels([telegram({ mode: "poll" })])],
		});
		// with a cronHandler it type-checks
		createClaw({
			cronHandler: { secret: "s" },
			model,
			plugins: [channels([telegram({ mode: "poll" })])],
		});
	});

	test("a mixed registry with any poller requires cronHandler", () => {
		// @ts-expect-error — one poll channel in the list is enough to require cronHandler
		createClaw({
			model,
			plugins: [channels([hooksOnly, telegram({ mode: "poll" })])],
		});
		// and the webhook-only fixture alone does not
		createClaw({ model, plugins: [channels([hooksOnly])] });
	});
});

describe("channelConnections cron-handler requirement", () => {
	test("webhook-only connections need no cronHandler", () => {
		createClaw({ model, plugins: [channelConnections([telegram()])] });
		createClaw({
			model,
			plugins: [
				channels([telegram()]),
				channelConnections([telegram()], { poll: false }),
			],
		});
	});

	test("enabling poll requires cronHandler, statically", () => {
		// @ts-expect-error — poll-mode connections need the cron, so cronHandler is required
		createClaw({
			model,
			plugins: [channelConnections([telegram()], { poll: true })],
		});
		// with a cronHandler it type-checks
		createClaw({
			cronHandler: { secret: "s" },
			model,
			plugins: [channelConnections([telegram()], { poll: true })],
		});
	});
});

describe("channel naming requirement", () => {
	test("two bots of one provider need distinct names, statically", () => {
		// @ts-expect-error — duplicate (provider, name) key: both are telegram:default
		channels([telegram({}), telegram({})]);
		// a named second bot compiles (a named bot names its own token via tokenRef)
		channels([telegram({}), telegram({ name: "sales", tokenRef: "SALES" })]);
		// @ts-expect-error — two bots under the same name collide too
		channels([
			telegram({ name: "sales", tokenRef: "A" }),
			telegram({ name: "sales", tokenRef: "B" }),
		]);
	});

	test("a named bot must carry its own tokenRef, statically", () => {
		// @ts-expect-error — a named app bot requires tokenRef, so two named bots can't collide on a secret
		channels([telegram({ name: "sales" })]);
		// with a tokenRef it compiles
		channels([telegram({ name: "sales", tokenRef: "SALES" })]);
	});

	test("a name must be a URL path segment, statically", () => {
		// @ts-expect-error — "/" is not a path-segment character
		channels([telegram({ name: "connections/sneaky", tokenRef: "R" })]);
		// @ts-expect-error — neither is a space
		channels([telegram({ name: "sales bot", tokenRef: "R" })]);
		// the full segment alphabet compiles
		channels([telegram({ name: "Sales_bot-2", tokenRef: "R" })]);
	});
});
