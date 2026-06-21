import type { EuroclawPlugin } from "@euroclaw/core";
import type {
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	EngineContinueRunInput,
	EngineRunHandle,
	EngineStartRunInput,
} from "@euroclaw/engine-core";
import { drainWork as drainEngineWork } from "@euroclaw/engine-core";
import type { Runtime } from "@euroclaw/runtime";
import type { SqlEngineStore } from "./store";
import type { SqlEngineWorkerConfig, WorkerTickResult } from "./worker";
import {
	createSqlEngineWorker,
	RUNTIME_CONTINUE_RUN_TASK,
	RUNTIME_RUN_TASK,
} from "./worker";

export type SqlEngineConfig = {
	store: SqlEngineStore;
	workerId?: string;
	leaseTtlMs?: number;
	cron?: false | { limit?: number };
};

type SqlEngineCronFlag<Config extends SqlEngineConfig> = Config extends {
	cron: false;
}
	? "no-cron"
	: "has-cron";

export type SqlEngineHandle = ClawEngineHandle<WorkerTickResult> & {
	kind: "sql";
	work: () => Promise<WorkerTickResult>;
};

function createSqlEngineHandle(input: {
	config: SqlEngineConfig;
	runtime: Runtime;
}): SqlEngineHandle {
	const worker = createSqlEngineWorker({
		leaseTtlMs: input.config.leaseTtlMs,
		runtime: input.runtime,
		store: input.config.store,
		workerId: input.config.workerId ?? "euroclaw-worker",
	} satisfies SqlEngineWorkerConfig);
	return {
		kind: "sql",
		async startRun(startInput: EngineStartRunInput): Promise<EngineRunHandle> {
			const run = await input.config.store.transaction(async (store) => {
				const run = await store.createRun({
					...startInput.run,
					input: { prompt: startInput.prompt, ctx: startInput.ctx ?? {} },
				});
				await store.enqueueTask({
					kind: RUNTIME_RUN_TASK,
					payload: {
						prompt: startInput.prompt,
						...(startInput.ctx ? { ctx: startInput.ctx } : {}),
					},
					runId: run.id,
				});
				return run;
			});
			return { id: run.id };
		},
		async continueRun(
			continueInput: EngineContinueRunInput,
		): Promise<EngineRunHandle> {
			const run = await input.config.store.transaction(async (store) => {
				const run = await store.createRun({
					...continueInput.run,
					input: {
						approvalId: continueInput.approvalId,
						ctx: continueInput.ctx ?? {},
					},
				});
				await store.enqueueTask({
					kind: RUNTIME_CONTINUE_RUN_TASK,
					payload: {
						approvalId: continueInput.approvalId,
						...(continueInput.ctx ? { ctx: continueInput.ctx } : {}),
					},
					runId: run.id,
				});
				return run;
			});
			return { id: run.id };
		},
		work: () => worker.tick(),
	};
}

function sqlCronPlugin<const Config extends SqlEngineConfig>(
	config: Config,
	engine: SqlEngineHandle,
): EuroclawPlugin<SqlEngineCronFlag<Config>> {
	return {
		id: "engine-sql",
		cron:
			config.cron === false
				? []
				: [
						{
							id: "engine-sql:work",
							handler: ({ limit }) =>
								drainEngineWork({
									limit:
										limit ??
										(config.cron === false ? undefined : config.cron?.limit),
									work: engine.work,
								}),
						},
					],
	};
}

export function sqlEngine<const Config extends SqlEngineConfig>(
	config: Config,
): ClawEngineFactory<Runtime, SqlEngineHandle, SqlEngineCronFlag<Config>> {
	return {
		kind: "sql",
		create: (
			runtime,
		): ClawEngineInstance<SqlEngineHandle, SqlEngineCronFlag<Config>> => {
			const engine = createSqlEngineHandle({ config, runtime });
			return {
				engine,
				plugins: [sqlCronPlugin(config, engine)],
				runs: {
					get: (id) => config.store.getRun(id),
					events: (runId) => config.store.events(runId),
				},
			};
		},
	};
}
