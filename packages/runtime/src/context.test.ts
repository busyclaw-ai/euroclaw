import {
	ACTOR_CONTEXT_KEY,
	type ContextResolver,
	ROLE_CONTEXT_KEY,
	TENANT_CONTEXT_KEY,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createTeamStore } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import { composeContext, roleMembership, sessionIdentity } from "./index";

function resolverFor(
	parts: Parameters<typeof composeContext>[0],
): ContextResolver {
	const resolver = composeContext(parts);
	if (!resolver) throw new Error("expected a resolver");
	return resolver;
}

describe("runtime context", () => {
	it("resolves actor from a swappable session function", async () => {
		const resolve = resolverFor({
			identity: sessionIdentity({
				getSession: async ({ headers }) =>
					headers === "tok" ? { user: { id: "alice" } } : null,
			}),
		});
		expect((await resolve({ headers: "tok" }))[ACTOR_CONTEXT_KEY]).toBe(
			"alice",
		);
	});

	it("resolves membership role through any roleOf lookup", async () => {
		const team = createTeamStore(memoryAdapter());
		const invite = await team.invite({
			team: "acme",
			email: "bob@x.com",
			role: "approver",
		});
		await team.accept(invite.id, "bob");

		const resolve = resolverFor({
			identity: () => "bob",
			membership: roleMembership({ roleOf: team.roleOf }),
		});
		const ctx = await resolve({ team: "acme" });

		expect(ctx[ACTOR_CONTEXT_KEY]).toBe("bob");
		expect(ctx[ROLE_CONTEXT_KEY]).toBe("approver");
	});

	it("resolves tenant through a trusted resolver", async () => {
		const resolve = resolverFor({
			tenant: () => "tenant-1",
		});

		expect((await resolve({}))[TENANT_CONTEXT_KEY]).toBe("tenant-1");
	});
});
