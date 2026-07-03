/**
 * The engine protocol — what a durable execution engine IS: the engine-neutral handle
 * (start/continue/optional work), the factory composed by `createClaw`, the run read-model, and
 * the bounded `drainWork` helper cron hosts pump with. Implementations live in `@euroclaw/engine-*`
 * (engine-sql today; a managed-workflow engine implements the same verbs and omits `work`).
 */

import { configurationError } from "@euroclaw/errors";
import type { JsonObject } from "./common";
import type { EuroclawCronFlag, EuroclawPlugin } from "./governance/plugin";

export type EngineRunHandle = {
	id: string;
};

export type EngineRunMetadata = {
	id?: string;
	actor?: string;
	team?: string;
};

export type EngineStartRunInput = {
	prompt: string;
	ctx?: JsonObject;
	run?: EngineRunMetadata;
};

export type EngineContinueRunInput = {
	approvalId: string;
	ctx?: JsonObject;
	run?: EngineRunMetadata;
};

export type EngineWorkResult = unknown;

export type EngineRunRecord = {
	id: string;
	status: string;
	input: JsonObject;
	actor?: string;
	team?: string;
	createdAt: string;
	updatedAt: string;
};

export type EngineRunEvent = {
	id: string;
	runId: string;
	type: string;
	payload: JsonObject;
	createdAt: string;
};

export type ClawRunReadModel = {
	get: (id: string) => Promise<EngineRunRecord | null>;
	events: (runId: string) => Promise<EngineRunEvent[]>;
};

export type ClawEngineHandle<WorkResult = EngineWorkResult> = {
	kind: string;
	startRun: (input: EngineStartRunInput) => Promise<EngineRunHandle>;
	continueRun: (input: EngineContinueRunInput) => Promise<EngineRunHandle>;
	/** Engines with an explicit worker lifecycle expose this; managed engines may omit it. */
	work?: () => Promise<WorkResult>;
};

export type ClawEngineInstance<
	Handle extends ClawEngineHandle = ClawEngineHandle,
	HasCron extends EuroclawCronFlag = "unknown-cron",
> = {
	engine: Handle;
	runs?: ClawRunReadModel;
	plugins?: readonly EuroclawPlugin<HasCron>[];
	$HasCron?: HasCron;
};

export type ClawEngineFactory<
	RuntimeLike = unknown,
	Handle extends ClawEngineHandle = ClawEngineHandle,
	HasCron extends EuroclawCronFlag = "unknown-cron",
> = {
	kind: Handle["kind"];
	create: (runtime: RuntimeLike) => ClawEngineInstance<Handle, HasCron>;
	$HasCron?: HasCron;
};

export type DrainWorkStatus = "idle" | "limit";

export type DrainWorkResult<WorkResult = EngineWorkResult> = {
	processed: number;
	results: WorkResult[];
	status: DrainWorkStatus;
};

export type DrainWorkInput<WorkResult = EngineWorkResult> = {
	work: () => Promise<WorkResult | null | undefined>;
	limit?: number;
	isIdle?: (result: WorkResult | null | undefined) => boolean;
};

function defaultIsIdle<WorkResult>(
	result: WorkResult | null | undefined,
): boolean {
	if (result == null) return true;
	return (
		typeof result === "object" &&
		"status" in result &&
		(result as { status?: unknown }).status === "idle"
	);
}

/** Drain worker ticks until idle or the bounded limit is reached. */
export async function drainWork<WorkResult = EngineWorkResult>(
	input: DrainWorkInput<WorkResult>,
): Promise<DrainWorkResult<WorkResult>> {
	const limit = input.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1) {
		throw configurationError("drainWork limit must be a positive integer", {
			limit,
		});
	}
	const isIdle = input.isIdle ?? defaultIsIdle<WorkResult>;
	const results: WorkResult[] = [];
	for (let i = 0; i < limit; i++) {
		const result = await input.work();
		if (isIdle(result))
			return { processed: results.length, results, status: "idle" };
		results.push(result as WorkResult);
	}
	return { processed: results.length, results, status: "limit" };
}
