// The ApprovalStore port + the approval after-gate — durable, single-use human approvals for the
// needs-approval gate. NO storage import: the port is behaviour-only, the SQL-backed impl lives in
// @euroclaw/storage-durable (createApprovalStore over the Adapter). The after-gate mirrors auditGate
// exactly — governance auto-registers it when you provide a store, so handleToolCall only DECIDES and the
// persistence is a pluggable observer. The record stores the REDACTED call so it can be re-run on
// resume (see Governance.continueRun). See docs/architecture/07-approval-and-audit.md.

import { type } from "arktype";
import type { JsonObject as JsonObjectType } from "../common";
import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";
import {
	ACTOR_CONTEXT_KEY,
	type AfterGate,
	type HandleResult,
	type ToolCall,
	type TurnContext,
} from "./boundary";

const approvalStatusValues = [
	"pending",
	"approved",
	"denied",
	"consumed",
] as const;

export const approvalStatus = type(
	"'pending' | 'approved' | 'denied' | 'consumed'",
);
export type ApprovalStatus = (typeof approvalStatusValues)[number];

export const approvalFields = {
	id: field.string({ required: true, unique: true }),
	status: field.enum(approvalStatusValues, { required: true }),
	gateId: field.string({ required: true }),
	toolName: field.string({ required: true, index: true }),
	args: field.jsonObject({ required: true, pii: "redacted" }),
	reasonCode: field.string({ index: true }),
	actor: field.string({ index: true }),
	reason: field.string(),
	metadata: field.jsonObject(),
	decidedBy: field.string(),
	createdAt: field.string({ required: true }),
	expiresAt: field.string({ index: true }),
} as const;

export const approvalEntity = entity("approval", approvalFields);
export const approvalRecord = approvalEntity.record;
export type ApprovalRecord = EntityRecord<typeof approvalFields>;

export const newApproval = approvalEntity.schema({
	omit: ["id", "status", "decidedBy"],
});
export type NewApproval = EntityInput<
	typeof approvalFields,
	"id" | "status" | "decidedBy"
>;

/** The storage schema backing the ApprovalStore. */
export const approvalSchema = approvalEntity.storage;

export type ApprovalMetadataResolver = (
	call: ToolCall,
	ctx: TurnContext,
	outcome: Extract<HandleResult, { status: "needs-approval" }>,
) => JsonObjectType | undefined;

/**
 * Durable home for human approvals. The single-use guarantee is `consume`: under concurrent
 * resumes of the same approval, exactly one caller gets the record, the rest get null.
 */
export type ApprovalStore = {
	/** Open a pending approval. Returns the stored record (with its assigned `id`). */
	create: (input: NewApproval) => Promise<ApprovalRecord>;
	/** Read an approval without consuming it. */
	get: (id: string) => Promise<ApprovalRecord | null>;
	/** Mark a pending approval approved. Returns the updated record, or null if it wasn't pending. */
	grant: (id: string, by: string) => Promise<ApprovalRecord | null>;
	/** Mark a pending approval denied. Returns the updated record, or null if it wasn't pending. */
	deny: (
		id: string,
		by: string,
		reason?: string,
	) => Promise<ApprovalRecord | null>;
	/**
	 * Atomically take the single-use APPROVED record by id (race-safe). Returns null if it's absent,
	 * not approved, expired, or already consumed. This is what makes resume run exactly once.
	 */
	consume: (id: string) => Promise<ApprovalRecord | null>;
	/** List approvals, optionally filtered — the human-review queue reads `{ status: "pending" }`. */
	list: (filter?: {
		status?: ApprovalStatus;
		actor?: string;
	}) => Promise<ApprovalRecord[]>;
};

/**
 * The approval after-gate: persists every needs-approval outcome to the ApprovalStore, with the
 * REDACTED call so resume can replay it. A plain after-gate (like auditGate) — it observes, the
 * pipeline decides.
 */
export function approvalGate(
	store: ApprovalStore,
	now: () => string,
	metadata?: ApprovalMetadataResolver,
): AfterGate {
	return {
		id: "approval",
		matcher: (call) => call.boundary === "tool",
		handler: async (call, ctx, outcome) => {
			if (outcome.status !== "needs-approval") return;
			if (call.boundary !== "tool") return;
			await store.create({
				gateId: outcome.gateId,
				toolName: call.toolCall.name,
				args: call.toolCall.args,
				reasonCode: outcome.reasonCode,
				actor:
					typeof ctx[ACTOR_CONTEXT_KEY] === "string"
						? ctx[ACTOR_CONTEXT_KEY]
						: undefined,
				reason: outcome.reason,
				metadata: metadata?.(call.toolCall, ctx, outcome),
				createdAt: now(),
			});
		},
	};
}
