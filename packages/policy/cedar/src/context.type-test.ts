// Type-level tests. Run by `tsc --noEmit` (the existing `typecheck` script); the `.type-test.ts`
// name keeps vitest's runner from picking them up. A *passing* typecheck means every
// `@ts-expect-error` line genuinely errored — so this file is the executable spec for the request
// context Cedar declares (`{ principal }`) being folded onto, and required by, governed calls.

import { createGovernance } from "@euroclaw/core";
import { cedar } from "./index";

// A core governed by Cedar → its `{ principal }` context is folded on.
const governed = createGovernance({ plugins: [cedar({ policies: "" })] });

// ✅ principal accepted (string).
void governed.handleToolCall({ name: "x", args: {} }, { principal: "alice" });

// ❌ approval state is derived server-side, not caller-provided.
// @ts-expect-error
void governed.handleToolCall(
	{ name: "x", args: {} },
	{ principal: "alice", confirmationUsed: true },
);

// ❌ principal must be a string, not a number.
// @ts-expect-error
void governed.handleToolCall({ name: "x", args: {} }, { principal: 123 });

// ❌ principal is required once Cedar is installed.
// @ts-expect-error
const missingPrincipal: Parameters<typeof governed.handleToolCall>[1] = {
	notPrincipal: "alice",
};
void governed.handleToolCall({ name: "x", args: {} }, missingPrincipal);

// A core with NO policy plugin → nothing is required; the context stays a free bag.
const ungoverned = createGovernance({});
void ungoverned.handleToolCall({ name: "x", args: {} }, {});
