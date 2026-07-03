// @euroclaw/contracts — the euroclaw protocol: the governance boundary + plugin contracts, the
// entity schema DSL, and the port/schema definitions every euroclaw package speaks. One explicit
// public surface (no `export *`); the engine that runs these contracts is @euroclaw/core.

// ── errors ───────────────────────────────────────────────────────────────────
export type { EuroclawErrorCode, EuroclawErrorInput } from "@euroclaw/errors";
export {
	configurationError,
	EuroclawError,
	errorMessage,
	stateError,
	unsupportedOperationError,
	validationError,
} from "@euroclaw/errors";

// ── claws (conversational/agent-state domain) ────────────────────────────────
export type {
	AppendMessageInput,
	BindConversationClawInput,
	BindConversationInput,
	BindConversationResult,
	BindConversationThreadInput,
	CheckpointKind,
	CheckpointRecord,
	CheckpointStore,
	ClawRecord,
	ClawStatus,
	ClawStore,
	ClawsStore,
	ConversationBindingLookup,
	ConversationBindingRecord,
	ConversationBindingStore,
	CreateCheckpointInput,
	CreateClawInput,
	CreateConversationBindingInput,
	CreateThreadInput,
	CreateToolCallInput,
	CreateToolResultInput,
	MessageRecord,
	MessageRole,
	MessageStore,
	MessageVisibility,
	ThreadRecord,
	ThreadStatus,
	ThreadStore,
	ToolCallRecord,
	ToolCallStatus,
	ToolCallStatusPatch,
	ToolCallStore,
	ToolResultOutputMode,
	ToolResultRecord,
	ToolResultStatus,
	ToolResultStore,
	UpdateClawInput,
} from "./claws/contracts";
export {
	appendMessageInput,
	bindConversationClawInput,
	bindConversationInput,
	bindConversationResult,
	bindConversationThreadInput,
	checkpointEntity,
	checkpointFields,
	checkpointKind,
	checkpointRecord,
	clawEntity,
	clawFields,
	clawRecord,
	clawStatus,
	clawsSchema,
	conversationBindingEntity,
	conversationBindingFields,
	conversationBindingRecord,
	createCheckpointInput,
	createClawInput,
	createClawInputOptions,
	createConversationBindingInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	messageEntity,
	messageFields,
	messageRecord,
	messageRole,
	messageVisibility,
	threadEntity,
	threadFields,
	threadRecord,
	threadStatus,
	toolCallEntity,
	toolCallFields,
	toolCallRecord,
	toolCallStatus,
	toolResultEntity,
	toolResultFields,
	toolResultOutputMode,
	toolResultRecord,
	toolResultStatus,
} from "./claws/schema";

// ── primitives: json + the entity schema DSL ─────────────────────────────────
export type { JsonObject, JsonPrimitive, JsonValue } from "./common";
export { jsonObject, jsonValue } from "./common";
// ── cross-cutting ports: effects, events, per-tool governance ────────────────
export type {
	EffectClaim,
	EffectCompensation,
	EffectRecord,
	EffectStatus,
	EffectStore,
} from "./effects";
export {
	effectCompensation,
	effectEntity,
	effectFields,
	effectRecord,
	effectSchema,
	effectStatus,
	effectStorageEntity,
	effectStorageFields,
} from "./effects";
// ── the engine protocol: engine-neutral durable execution (impls in @euroclaw/engine-*) ──────
export type {
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	ClawRunReadModel,
	DrainWorkInput,
	DrainWorkResult,
	DrainWorkStatus,
	EngineContinueRunInput,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunMetadata,
	EngineRunRecord,
	EngineStartRunInput,
	EngineWorkResult,
} from "./engine";
export { drainWork } from "./engine";
export type {
	EntityField,
	EntityFieldMeta,
	EntityFieldType,
	EntityInput,
	EntityRecord,
	EntitySchemaInput,
	EntitySchemaOptions,
	EntityUpdateInput,
} from "./entity";
export { entity, field } from "./entity";
export type { Event, EventSink } from "./events";
export { event } from "./events";
export type { ToolEffectPolicy, ToolGovernance } from "./govern";
export { govern } from "./govern";
// ── governance ports: approval, audit, redaction (impls live in @euroclaw/core) ─
export type {
	ApprovalMetadataResolver,
	ApprovalRecord,
	ApprovalStatus,
	ApprovalStore,
	NewApproval,
} from "./governance/approval";
export {
	approvalEntity,
	approvalFields,
	approvalRecord,
	approvalSchema,
	approvalStatus,
	newApproval,
} from "./governance/approval";
export type {
	AnchorProof,
	AuditChainProblem,
	AuditChainVerification,
	AuditEntry,
	AuditHead,
	AuditInput,
	AuditSink,
} from "./governance/audit";
export {
	anchorProof,
	auditEntry,
	auditHead,
	auditInput,
} from "./governance/audit";
// ── governance: the boundary, plugin contract, reason codes, and gate ports ──
export type {
	AfterGate,
	BoundaryCall,
	BoundaryGate,
	ContextResolver,
	Gate,
	GateDecision,
	HandleResult,
	ModelCall,
	ModelMessage,
	ModelRunner,
	Outcome,
	ToolBoundary,
	ToolCall,
	ToolRunner,
	TurnContext,
} from "./governance/boundary";
export {
	ACTOR_CONTEXT_KEY,
	CLAW_ID_CONTEXT_KEY,
	gateDecision,
	handleResult,
	MEMORY_NAMESPACE_CONTEXT_KEY,
	modelCall,
	modelMessage,
	RESERVED_CONTEXT_PREFIX,
	ROLE_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	TENANT_CONTEXT_KEY,
	THREAD_ID_CONTEXT_KEY,
	toolCall,
} from "./governance/boundary";
export type {
	EuroclawCronContext,
	EuroclawCronFlag,
	EuroclawCronResult,
	EuroclawCronStatus,
	EuroclawCronTask,
	EuroclawHttpMethod,
	EuroclawPlugin,
	EuroclawPluginConfigureContext,
	EuroclawRoute,
	EuroclawRouteContext,
	EuroclawRouteRequest,
	EuroclawRouteResult,
	InferContext,
	InferPluginApi,
	InferPluginSchema,
	InferPlugins,
	InferReasonCodes,
	UnionToIntersection,
} from "./governance/plugin";
export type { ReasonCode } from "./governance/reason-codes";
export { defineReasonCodes } from "./governance/reason-codes";
export type {
	Detector,
	PiiKind,
	PiiMapping,
	PiiMappingStore,
	PiiSpan,
	PiiSpanSource,
	PiiSpans,
	RedactionContext,
	Redactor,
	RehydrationContext,
} from "./governance/redact";
export {
	piiKind,
	piiMapping,
	piiMappingEntity,
	piiMappingFields,
	piiMappingSchema,
	piiSpan,
	piiSpanSource,
	piiSpans,
	redactionContext,
	redactionContextFrom,
	rehydrationContext,
} from "./governance/redact";
export type {
	NewRunCheckpoint,
	RunCheckpointRecord,
	RunCheckpointStatus,
	RunCheckpointStore,
} from "./run-checkpoint";
export {
	newRunCheckpoint,
	runCheckpointEntity,
	runCheckpointFields,
	runCheckpointRecord,
	runCheckpointSchema,
	runCheckpointStatus,
} from "./run-checkpoint";
// ── the storage protocol (implementations live in @euroclaw/storage-*) ────────
export type {
	Adapter,
	FieldAttribute,
	FieldType,
	SchemaDeclaration,
	SortBy,
	TableSchema,
	Where,
	WhereOperator,
} from "./storage";
