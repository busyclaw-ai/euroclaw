// The code-owned system posture (@euroclaw/authz) compiled through the reference Cedar engine — the
// posture is a plain string in authz (no cedar dep there); this is where it meets cedar-wasm. Proves
// it parses at construction and yields reads-run / writes-confirm / autonomous-floor decisions.

import {
	type AuthzActionInput,
	actionEntitiesFromModel,
	buildAuthzModel,
	SYSTEM_POSTURE,
} from "@euroclaw/authz";
import type { PolicyRequest } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { cedarEngine } from "../src/index";

const model = buildAuthzModel([
	{ id: "readDoc", source: "tool", governance: { access: "read" } },
	{ id: "writeDoc", source: "tool", governance: { access: "write" } },
] satisfies AuthzActionInput[]);

function engine(policies: string) {
	return cedarEngine({
		policies,
		entities: actionEntitiesFromModel(model) as never,
	});
}

const req = (
	action: string,
	context: Record<string, unknown> = {},
): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: action },
	resource: { type: "Tool", id: action },
	context,
});

describe("SYSTEM_POSTURE through cedar", () => {
	it("parses at construction (no configurationError on the seeded text)", () => {
		expect(() => engine(SYSTEM_POSTURE)).not.toThrow();
	});

	it("reads run", async () => {
		const e = engine(SYSTEM_POSTURE);
		expect((await e.authorize(req("readDoc"))).decision).toBe("permit");
	});

	it("writes need confirmation — needs-approval, never a silent permit", async () => {
		const e = engine(SYSTEM_POSTURE);
		const result = await e.authorize(
			req("writeDoc", { runMode: "interactive" }),
		);
		expect(result.decision).toBe("needs-approval");
	});

	it("an unconditional customer permit still can't run an UNCONFIRMED write — any run mode", async () => {
		// A customer slice that tries to permit writes outright, laid over the sealed posture. The
		// confirmation-only floor forbids every unconfirmed write regardless of mode; confirming would
		// unblock it → needs-approval, NEVER a silent ok. Crucially this holds even with runMode ABSENT
		// (the production reality — nothing stamps euroclaw__runMode), the fail-open escalation case.
		const withPermit = `${SYSTEM_POSTURE}\npermit(principal, action in Action::"writes", resource);`;
		const e = engine(withPermit);
		for (const context of [
			{ runMode: "interactive" },
			{ runMode: "autonomous" },
			{}, // runMode ABSENT — production
		]) {
			expect((await e.authorize(req("writeDoc", context))).decision).toBe(
				"needs-approval",
			);
		}
	});
});
