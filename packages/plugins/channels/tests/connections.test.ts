import { memoryAdapter, schemaAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	channelConnections,
	channelConnectionsSchema,
	createChannelConnectionsStore,
} from "../src/connections/index";

// Stores and the configure context take the schema-aware adapter the assembly provides in
// production; tests wrap manually.
const db = () => schemaAdapter(memoryAdapter(), channelConnectionsSchema);

import { type Channel, endpointId } from "../src/index";

const now = () => "2026-01-01T00:00:00.000Z";

function fakeClaw(recorded: { binds: unknown[]; relayed: string[] }) {
	return {
		api: {
			bindConversation: async (input: unknown) => {
				recorded.binds.push(input);
				return {
					binding: { id: "binding-1" },
					claw: { id: "claw-1" },
					thread: { id: "thread-1" },
					created: true,
				};
			},
			sendMessage: async (input: { message: string }) => {
				recorded.relayed.push(input.message);
				return {
					result: { status: "completed", text: `echo:${input.message}` },
					userMessage: { id: "message-1" },
				};
			},
		},
	};
}

function fakeChannel(overrides: Partial<Channel> = {}): Channel {
	return {
		provider: "fake",
		supports: { webhook: true, poll: true },
		mode: "webhook",
		parseInbound: ({ request }) => [
			{ externalConversationId: "chat-1", text: request.rawBody },
		],
		send: async () => {},
		...overrides,
	};
}

/** Configure the plugin against a bare adapter — what the createClaw assembly does. */
function configured(plugin: ReturnType<typeof channelConnections>) {
	const built = plugin.configure?.({ adapter: db() });
	if (!built) throw new Error("expected configure to build the plugin");
	return built;
}

function webhookRequest(input: { body: string; secret?: string }) {
	return {
		method: "POST",
		url: "https://host/channels/fake/connections/acme-bot/webhook",
		headers: {
			get: (name: string) =>
				name === "x-secret" ? (input.secret ?? null) : null,
		},
		json: async () => JSON.parse(input.body) as unknown,
		text: async () => input.body,
	};
}

describe("createChannelConnectionsStore", () => {
	it("registers with a key-derived id, rotates in place, and revokes softly", async () => {
		const store = createChannelConnectionsStore(db(), { now });
		const first = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			mode: "webhook",
			secret: "token-1",
			webhookSecret: "hook-1",
			organizationId: "org-acme",
		});
		expect(first).toMatchObject({
			id: endpointId({ provider: "telegram", endpointKey: "acme-bot" }),
			status: "active",
			secret: "token-1",
			organizationId: "org-acme",
		});

		// re-registration is the trust grant: rotate credentials, stay one row
		const rotated = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			mode: "webhook",
			secret: "token-2",
		});
		expect(rotated.id).toBe(first.id);
		expect(rotated.secret).toBe("token-2");
		await expect(store.list()).resolves.toHaveLength(1);

		const revoked = await store.revoke({
			provider: "telegram",
			endpointKey: "acme-bot",
		});
		expect(revoked?.status).toBe("disabled");

		// registering again re-activates
		const restored = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			mode: "webhook",
			secret: "token-3",
		});
		expect(restored.status).toBe("active");
	});

	it("lists by organization — the organizationId-style link", async () => {
		const store = createChannelConnectionsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			mode: "webhook",
			organizationId: "org-acme",
		});
		await store.register({
			provider: "telegram",
			endpointKey: "globex-bot",
			mode: "webhook",
			organizationId: "org-globex",
		});
		const acme = await store.list({ organizationId: "org-acme" });
		expect(acme.map((row) => row.endpointKey)).toEqual(["acme-bot"]);
	});
});

describe("channelConnections plugin", () => {
	it("rejects registration for a provider that is not in the registry", async () => {
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		await expect(
			api.channels.connections.register({
				provider: "slack",
				endpointKey: "x",
				mode: "webhook",
			}),
		).rejects.toThrow(/unknown channel provider/);
	});

	it("binds even a connection named 'default' disjointly from the app bot", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		// no reserved words: the connections/ namespace makes any key safe
		await api.channels.connections.register({
			provider: "fake",
			endpointKey: "default",
			mode: "webhook",
		});
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the connections webhook route");
		const ok = await route.handler({
			claw: fakeClaw(recorded),
			params: { endpointKey: "default", provider: "fake" },
			request: webhookRequest({ body: "hello" }),
		});
		expect(ok.status).toBe(200);
		// the app bot's unnamed key is "default"; this binding lives elsewhere
		expect(recorded.binds).toMatchObject([
			{ endpointKey: "connections/default" },
		]);
	});

	it("rejects a connection key that is not a URL path segment", async () => {
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		await expect(
			api.channels.connections.register({
				provider: "fake",
				endpointKey: "acme/bot",
				mode: "webhook",
			}),
		).rejects.toThrow(/invalid connection key/);
	});

	it("rejects poll-mode registration unless poll is enabled", async () => {
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		await expect(
			api.channels.connections.register({
				provider: "fake",
				endpointKey: "poller",
				mode: "poll",
			}),
		).rejects.toThrow(/poll is disabled/);
	});

	it("serves a registered connection on its own webhook URL with row-driven bind scope", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const channel = fakeChannel({
			verify: ({ request, endpoint }) =>
				request.headers.get("x-secret") === endpoint.webhookSecret,
		});
		const plugin = configured(channelConnections([channel]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		await api.channels.connections.register({
			provider: "fake",
			endpointKey: "acme-bot",
			mode: "webhook",
			webhookSecret: "hook-1",
			organizationId: "org-acme",
			claw: { name: "Acme bot" },
		});
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the connections webhook route");

		const denied = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake", endpointKey: "acme-bot" },
			request: webhookRequest({ body: "hello", secret: "wrong" }),
		});
		expect(denied.status).toBe(401);

		const ok = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake", endpointKey: "acme-bot" },
			request: webhookRequest({ body: "hello", secret: "hook-1" }),
		});
		expect(ok.status).toBe(200);
		expect(recorded.relayed).toEqual(["hello"]);
		// the row's organization + claw defaults drove the bind — tenancy never touched transport identity,
		// and the binding key is namespaced so it can never collide with an app bot's
		expect(recorded.binds).toMatchObject([
			{
				provider: "fake",
				endpointKey: "connections/acme-bot",
				claw: { organizationId: "org-acme", name: "Acme bot" },
			},
		]);
	});

	it("hides unknown and revoked connections identically (404)", async () => {
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: {
					register: (input: unknown) => Promise<unknown>;
					revoke: (input: unknown) => Promise<unknown>;
				};
			};
		};
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the connections webhook route");

		const unknown = await route.handler({
			claw: fakeClaw({ binds: [], relayed: [] }),
			params: { provider: "fake", endpointKey: "ghost" },
			request: webhookRequest({ body: "hello" }),
		});
		expect(unknown.status).toBe(404);

		await api.channels.connections.register({
			provider: "fake",
			endpointKey: "acme-bot",
			mode: "webhook",
		});
		await api.channels.connections.revoke({
			provider: "fake",
			endpointKey: "acme-bot",
		});
		const revoked = await route.handler({
			claw: fakeClaw({ binds: [], relayed: [] }),
			params: { provider: "fake", endpointKey: "acme-bot" },
			request: webhookRequest({ body: "hello" }),
		});
		expect(revoked.status).toBe(404);
	});

	it("polls active poll connections and persists the cursor on the row", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const seenSecrets: Array<string | undefined> = [];
		const channel = fakeChannel({
			poll: async ({ endpoint, cursor }) => {
				seenSecrets.push(endpoint.secret);
				const offset = (cursor as { offset?: number } | undefined)?.offset ?? 0;
				return {
					messages:
						offset === 0
							? [{ externalConversationId: "chat-1", text: "from-db" }]
							: [],
					cursor: { offset: offset + 1 },
				};
			},
		});
		const plugin = configured(channelConnections([channel], { poll: true }));
		const api = plugin.api?.({}) as {
			channels: {
				connections: {
					register: (input: unknown) => Promise<unknown>;
					getByKey: (input: unknown) => Promise<{ cursor?: unknown } | null>;
				};
			};
		};
		await api.channels.connections.register({
			provider: "fake",
			endpointKey: "db-bot",
			mode: "poll",
			secret: "bot-token-abc",
			organizationId: "org-acme",
		});
		const cron = plugin.cron?.[0];
		if (!cron) throw new Error("expected the connections poll cron");

		const first = await cron.handler({ claw: fakeClaw(recorded) });
		expect(first).toMatchObject({ processed: 1, status: "processed" });
		expect(recorded.relayed).toEqual(["from-db"]);
		// the channel read the credential straight off the connection row
		expect(seenSecrets).toEqual(["bot-token-abc"]);
		await expect(
			api.channels.connections.getByKey({
				provider: "fake",
				endpointKey: "db-bot",
			}),
		).resolves.toMatchObject({ cursor: { offset: 1 } });

		const second = await cron.handler({ claw: fakeClaw(recorded) });
		expect(second).toMatchObject({ processed: 0, status: "idle" });
	});

	it("binds organizationless connections fine — tenancy is opt-in row data", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = configured(channelConnections([fakeChannel()]));
		const api = plugin.api?.({}) as {
			channels: {
				connections: { register: (input: unknown) => Promise<unknown> };
			};
		};
		await api.channels.connections.register({
			provider: "fake",
			endpointKey: "personal-bot",
			mode: "webhook",
			claw: { name: "Personal bot" },
		});
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the connections webhook route");
		const result = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake", endpointKey: "personal-bot" },
			request: webhookRequest({ body: "hello" }),
		});
		expect(result.status).toBe(200);
		expect(recorded.binds).toMatchObject([{ claw: { name: "Personal bot" } }]);
	});
});
