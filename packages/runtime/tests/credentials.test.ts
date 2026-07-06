import type {
	SecretMaterial,
	SecretRequest,
	SecretResolver,
} from "@euroclaw/contracts";
import { EuroclawError } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	applyCredentials,
	type CredentialContext,
	type HttpRequestPlan,
	type OpenApiBinding,
} from "../src/tools/sources/openapi";

const CTX: CredentialContext = { organizationId: "org-a", source: "petstore" };

const authSchemes: NonNullable<OpenApiBinding["authSchemes"]> = {
	apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
	apiKeyQuery: { type: "apiKey", in: "query", name: "api_key" },
	bearerAuth: { type: "http", scheme: "bearer" },
	basicAuth: { type: "http", scheme: "basic" },
	oauth: { type: "oauth2" },
};

function plan(): HttpRequestPlan {
	return {
		method: "GET",
		url: "https://api.example/v1/pets",
		origin: "https://api.example",
		headers: {},
	};
}

function binding(security: OpenApiBinding["security"]): OpenApiBinding {
	return {
		method: "get",
		path: "/pets",
		server: "https://api.example/v1",
		parameters: [],
		authSchemes,
		...(security !== undefined ? { security } : {}),
	};
}

/** A fake resolver: map scheme → material, or the sentinel "throw" for an infra failure. */
function resolver(table: Record<string, SecretMaterial | "throw">): {
	fn: SecretResolver;
	seen: SecretRequest[];
} {
	const seen: SecretRequest[] = [];
	return {
		seen,
		fn: (request) => {
			seen.push(request);
			const entry = table[request.scheme];
			if (entry === "throw") throw new Error("vault unreachable");
			return entry ?? null;
		},
	};
}

describe("applyCredentials — placement per scheme", () => {
	it("apiKey in header", async () => {
		const { fn } = resolver({
			apiKeyHeader: { kind: "token", value: "sk-123" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyHeader: [] }]),
			fn,
			CTX,
		);
		expect(out.headers["X-API-Key"]).toBe("sk-123");
	});

	it("apiKey in query (appended, encoded)", async () => {
		const { fn } = resolver({
			apiKeyQuery: { kind: "token", value: "a b+c" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyQuery: [] }]),
			fn,
			CTX,
		);
		expect(out.url).toBe("https://api.example/v1/pets?api_key=a%20b%2Bc");
	});

	it("http bearer → Authorization: Bearer", async () => {
		const { fn } = resolver({ bearerAuth: { kind: "token", value: "tok" } });
		const out = await applyCredentials(
			plan(),
			binding([{ bearerAuth: [] }]),
			fn,
			CTX,
		);
		expect(out.headers.authorization).toBe("Bearer tok");
	});

	it("http basic → Authorization: Basic base64(user:pass)", async () => {
		const { fn } = resolver({
			basicAuth: { kind: "basic", username: "alice", password: "s3cret" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ basicAuth: [] }]),
			fn,
			CTX,
		);
		expect(out.headers.authorization).toBe(
			`Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
		);
	});

	it("oauth2 material is placed as a bearer token", async () => {
		const { fn } = resolver({ oauth: { kind: "token", value: "oauth-tok" } });
		const out = await applyCredentials(
			plan(),
			binding([{ oauth: ["pets:read"] }]),
			fn,
			CTX,
		);
		expect(out.headers.authorization).toBe("Bearer oauth-tok");
	});
});

describe("applyCredentials — AND / OR alternatives", () => {
	it("AND: every scheme in one requirement is applied", async () => {
		const { fn } = resolver({
			apiKeyHeader: { kind: "token", value: "key" },
			bearerAuth: { kind: "token", value: "tok" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyHeader: [], bearerAuth: [] }]),
			fn,
			CTX,
		);
		expect(out.headers["X-API-Key"]).toBe("key");
		expect(out.headers.authorization).toBe("Bearer tok");
	});

	it("OR: the first fully satisfiable alternative wins", async () => {
		// Only apiKey is configured; the first (bearer) alternative is unsatisfiable → apiKey wins.
		const { fn } = resolver({
			apiKeyHeader: { kind: "token", value: "key" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ bearerAuth: [] }, { apiKeyHeader: [] }]),
			fn,
			CTX,
		);
		expect(out.headers.authorization).toBeUndefined();
		expect(out.headers["X-API-Key"]).toBe("key");
	});

	it("threads organizationId, source, scopes, and actor into the request — never model args", async () => {
		const { fn, seen } = resolver({
			oauth: { kind: "token", value: "t" },
		});
		await applyCredentials(
			plan(),
			binding([{ oauth: ["pets:read", "pets:write"] }]),
			fn,
			{ organizationId: "org-a", source: "petstore", actor: "alice" },
		);
		expect(seen[0]).toEqual({
			organizationId: "org-a",
			source: "petstore",
			scheme: "oauth",
			scopes: ["pets:read", "pets:write"],
			actor: "alice",
		});
	});
});

describe("applyCredentials — failure modes stay distinguishable", () => {
	it("a required-but-unconfigured scheme fails loud, naming source + scheme", async () => {
		const { fn } = resolver({});
		await expect(
			applyCredentials(plan(), binding([{ apiKeyHeader: [] }]), fn, CTX),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			details: {
				source: "petstore",
				unsatisfied: ["apiKeyHeader (not configured)"],
			},
		});
	});

	it("a resolver THROW propagates as infra failure, NOT missing-credential", async () => {
		const { fn } = resolver({ bearerAuth: "throw" });
		const error = await applyCredentials(
			plan(),
			binding([{ bearerAuth: [] }]),
			fn,
			CTX,
		).catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(EuroclawError); // distinct from the config error above
		expect((error as Error).message).toBe("vault unreachable");
	});

	it("public: undefined and [] security send nothing", async () => {
		const { fn, seen } = resolver({});
		const undef = await applyCredentials(plan(), binding(undefined), fn, CTX);
		const empty = await applyCredentials(plan(), binding([]), fn, CTX);
		expect(undef.headers).toEqual({});
		expect(empty.headers).toEqual({});
		expect(seen).toHaveLength(0); // the resolver was never consulted
	});

	it("a `{}` alternative is explicitly public and short-circuits", async () => {
		const { fn, seen } = resolver({});
		const out = await applyCredentials(
			plan(),
			binding([{}, { apiKeyHeader: [] }]),
			fn,
			CTX,
		);
		expect(out.headers).toEqual({});
		expect(seen).toHaveLength(0);
	});
});
