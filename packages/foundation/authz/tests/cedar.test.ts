import { describe, expect, it } from "vitest";
import {
	actionEntitiesFromModel,
	buildAuthzModel,
	entitiesToCedarJson,
	modelToCedarSchema,
	projectArgs,
} from "../src/index";

describe("projectArgs — JSON-Schema → Cedar, lossy-but-safe", () => {
	const schema = {
		type: "object",
		properties: {
			amount: { type: "integer" },
			note: { type: "string" },
			urgent: { type: "boolean" },
			price: { type: "number" }, // float — must NOT project
			tags: { type: "array", items: { type: "string" } },
			meta: {
				type: "object",
				properties: { region: { type: "string" } },
				required: ["region"],
			},
		},
		required: ["amount"],
	};

	it("projects primitives, enums-as-strings, sets, and nested records; drops floats", () => {
		const p = projectArgs(schema);
		expect(p).toBeDefined();
		expect(p?.cedarType).toContain('"amount": Long');
		expect(p?.cedarType).toContain('"note"?: String');
		expect(p?.cedarType).toContain('"urgent"?: Bool');
		expect(p?.cedarType).toContain('"tags"?: Set<String>');
		expect(p?.cedarType).toContain('"meta"?: {"region": String}');
		expect(p?.cedarType).not.toContain("price");
	});

	it("the filter drops unprojected and unknown keys, recursively — same walker as the render", () => {
		const p = projectArgs(schema);
		const filtered = p?.filter({
			amount: 100,
			note: "hi",
			price: 19.99, // dropped: float didn't project
			hack: "extra", // dropped: never in the schema
			meta: { region: "eu", secret: "x" }, // nested unknown dropped
		});
		expect(filtered).toEqual({
			amount: 100,
			note: "hi",
			meta: { region: "eu" },
		});
	});

	it("returns undefined when nothing projects — the action then has no args in Cedar", () => {
		expect(
			projectArgs({
				type: "object",
				properties: { ratio: { type: "number" } },
			}),
		).toBeUndefined();
		expect(projectArgs({ type: "string" })).toBeUndefined();
	});
});

describe("modelToCedarSchema — the model rendered as Cedar schema text", () => {
	const model = buildAuthzModel([
		{
			id: "refund",
			source: "tool",
			governance: { access: "write", groups: ["payments:all"] },
			args: {
				type: "object",
				properties: { amount: { type: "integer" } },
				required: ["amount"],
			},
		},
		{
			id: "lookup",
			source: "tool",
			governance: { access: "read", resource: "Candidate" },
		},
	]);

	it("declares principals, entity types with tags, groups, and typed actions", () => {
		const text = modelToCedarSchema(model);
		expect(text).toContain("entity User tags String;");
		expect(text).toContain("entity Tool tags String;");
		expect(text).toContain("entity Candidate tags String;");
		expect(text).toContain('action "writes";');
		expect(text).toContain('action "reads";');
		expect(text).toContain('action "payments:all";');
		expect(text).toContain('action "refund" in ["payments:all", "writes"]');
		expect(text).toContain('args?: {"amount": Long}');
		expect(text).toContain("resource: [Candidate]");
		expect(text).toContain("confirmationUsed: Bool");
		expect(text).toContain("runMode?: String");
	});

	it("renders parents and namespaces; declares referenced-but-undeclared parents", () => {
		const withParents = {
			...model,
			entityTypes: [{ type: "Tool", parents: ["McpServer"] }],
		};
		const text = modelToCedarSchema(withParents, { namespace: "Euroclaw" });
		expect(text).toContain("namespace Euroclaw {");
		expect(text).toContain("entity Tool in [McpServer] tags String;");
		expect(text).toContain("entity McpServer tags String;");
	});
});

describe("entity JSON renderings", () => {
	it("entitiesToCedarJson defaults attrs/parents and keeps tags", () => {
		expect(
			entitiesToCedarJson([
				{
					uid: { type: "Tool", id: "mcp:github:create_issue" },
					parents: [{ type: "McpServer", id: "github" }],
					tags: { access: "write" },
				},
			]),
		).toEqual([
			{
				uid: { type: "Tool", id: "mcp:github:create_issue" },
				attrs: {},
				parents: [{ type: "McpServer", id: "github" }],
				tags: { access: "write" },
			},
		]);
	});

	it("actionEntitiesFromModel emits the action hierarchy for evaluation-time `action in`", () => {
		const model = buildAuthzModel([
			{ id: "refund", source: "tool", governance: { access: "write" } },
		]);
		const entities = actionEntitiesFromModel(model);
		expect(entities).toContainEqual({
			uid: { type: "Action", id: "writes" },
			attrs: {},
			parents: [],
		});
		expect(entities).toContainEqual({
			uid: { type: "Action", id: "refund" },
			attrs: {},
			parents: [{ type: "Action", id: "writes" }],
		});
	});
});
