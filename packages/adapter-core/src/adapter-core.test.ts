import type { EuroclawPlugin } from "@euroclaw/core";
import type { Claw } from "euroclaw";
import { describe, expect, it } from "vitest";
import { createClawClient, toRequestHandler } from "./index";

describe("@euroclaw/adapter-core", () => {
	it("dispatches claw api calls through derived routes", async () => {
		const claw = {
			api: {
				createClaw: async (input: unknown) => input,
				getClaw: async (input: unknown) => input,
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);
		const post = await handler(
			new Request("https://app.test/api/euroclaw/create-claw", {
				body: JSON.stringify({ id: "claw-1", tenantId: "tenant-1" }),
				method: "POST",
			}),
		);

		expect(post.status).toBe(200);
		await expect(post.json()).resolves.toMatchObject({
			data: { id: "claw-1", tenantId: "tenant-1" },
			ok: true,
		});
		const get = await handler(
			new Request("https://app.test/api/euroclaw/get-claw?id=claw-1", {
				method: "GET",
			}),
		);

		expect(get.status).toBe(200);
		await expect(get.json()).resolves.toMatchObject({
			data: { id: "claw-1" },
			ok: true,
		});
		await expect(
			handler(
				new Request("https://app.test/api/euroclaw/work", { method: "POST" }),
			).then((response) => response.status),
		).resolves.toBe(404);
	});

	it("supports plugin routes and rejects conflicts", async () => {
		const plugin: EuroclawPlugin = {
			id: "telegram",
			routes: [
				{
					method: "POST",
					path: "/telegram/webhook",
					handler: async () => ({ body: { ok: true, route: "telegram" } }),
				},
			],
		};
		const claw = { api: {} } as unknown as Claw;
		const handler = toRequestHandler(claw, { plugins: [plugin] });

		const response = await handler(
			new Request("https://app.test/api/euroclaw/telegram/webhook", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			route: "telegram",
		});
		expect(() =>
			toRequestHandler(claw, {
				plugins: [
					plugin,
					{
						id: "other",
						routes: plugin.routes,
					},
				],
			}),
		).toThrow(/route conflict/);
	});

	it("runs plugin cron tasks through the built-in cron route", async () => {
		const seen: Array<{ id: string; limit?: number }> = [];
		const plugin: EuroclawPlugin = {
			id: "channel:telegram",
			cron: [
				{
					id: "channel:telegram:poll",
					handler: ({ limit }) => {
						seen.push({ id: "channel:telegram:poll", limit });
						return {
							data: { provider: "telegram" },
							processed: 2,
							status: "processed",
						};
					},
				},
			],
		};
		const claw = {
			api: {},
			$context: {
				cronHandler: { limit: 7, secret: "secret" },
				plugins: [plugin],
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		const unauthorized = await handler(
			new Request("https://app.test/api/euroclaw/cron", { method: "POST" }),
		);
		const authorized = await handler(
			new Request("https://app.test/api/euroclaw/cron", {
				headers: { "x-euroclaw-cron-secret": "secret" },
				method: "POST",
			}),
		);

		expect(unauthorized.status).toBe(401);
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toEqual({
			data: {
				tasks: [
					{
						data: { provider: "telegram" },
						id: "channel:telegram:poll",
						processed: 2,
						status: "processed",
					},
				],
			},
			ok: true,
		});
		expect(seen).toEqual([{ id: "channel:telegram:poll", limit: 7 }]);
	});

	it("validates derived route input before dispatch", async () => {
		const claw = {
			api: {
				createClaw: async () => {
					throw new Error("should not dispatch invalid input");
				},
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		const response = await handler(
			new Request("https://app.test/api/euroclaw/create-claw", {
				body: JSON.stringify({ id: "claw-1" }),
				method: "POST",
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: {
				message: expect.stringContaining("claw.api.createClaw input"),
			},
			ok: false,
		});
	});

	it("creates a typed client for manifest-derived routes", async () => {
		let fetches = 0;
		const claw = {
			api: {
				getClaw: async (input: unknown) => input,
				listMessages: async (input: unknown) => [input],
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);
		const client = createClawClient({
			baseUrl: "https://app.test/api/euroclaw",
			fetch: (input, init) => {
				fetches++;
				return handler(new Request(input, init));
			},
		});

		await expect(client.getClaw({ id: "claw-1" })).resolves.toEqual({
			id: "claw-1",
		});
		await expect(
			client.listMessages({ afterSequence: 2, limit: 5, threadId: "thread-1" }),
		).resolves.toEqual([{ afterSequence: 2, limit: 5, threadId: "thread-1" }]);
		expect(fetches).toBe(2);
	});

	it("client validates input before fetch", async () => {
		const client = createClawClient({
			fetch: () => {
				throw new Error("should not fetch invalid input");
			},
		});

		await expect(client.createClaw({ id: "claw-1" } as never)).rejects.toThrow(
			/claw\.api\.createClaw input/,
		);
	});
});
