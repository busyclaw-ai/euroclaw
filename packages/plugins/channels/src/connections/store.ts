import {
	type Adapter,
	type EntityRecord,
	type EntitySchemaInput,
	validationError,
	type Where,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { ChannelEndpointMode, EndpointEvent } from "../core/contracts";
import { endpointId } from "../core/id";
import {
	type channelConnectionFields,
	channelConnectionLookupInput,
	channelConnectionRecord,
	type channelConnectionStatusValues,
	registerChannelConnectionInput,
	type registerChannelConnectionInputOptions,
	updateChannelConnectionInput,
} from "./schema";

export type ChannelConnectionStatus =
	(typeof channelConnectionStatusValues)[number];
export type ChannelConnectionRecord = EntityRecord<
	typeof channelConnectionFields
>;
export type RegisterChannelConnectionInput = EntitySchemaInput<
	typeof channelConnectionFields,
	typeof registerChannelConnectionInputOptions
>;
export type ChannelConnectionLookup = {
	provider: string;
	endpointKey: string;
};
export type ChannelConnectionListFilter = {
	provider?: string;
	organizationId?: string;
	mode?: ChannelEndpointMode;
	status?: ChannelConnectionStatus;
};

export type ChannelConnectionsStore = {
	/**
	 * Register (or re-register) a connection — the sso `registerSSOProvider` analog. Idempotent on the
	 * (provider, endpointKey) natural key: re-registering rotates credentials/defaults in place and
	 * re-activates a revoked connection (registration is the trust grant).
	 */
	register: (
		input: RegisterChannelConnectionInput,
	) => Promise<ChannelConnectionRecord>;
	get: (id: string) => Promise<ChannelConnectionRecord | null>;
	getByKey: (
		input: ChannelConnectionLookup,
	) => Promise<ChannelConnectionRecord | null>;
	list: (
		filter?: ChannelConnectionListFilter,
	) => Promise<ChannelConnectionRecord[]>;
	/** Soft-disable: the connection stops resolving but the row survives. */
	revoke: (
		input: ChannelConnectionLookup,
	) => Promise<ChannelConnectionRecord | null>;
	/** Map a dispatch event onto the connection's state columns. */
	record: (
		key: ChannelConnectionLookup,
		event: EndpointEvent,
	) => Promise<ChannelConnectionRecord | null>;
};

export type ChannelConnectionsStoreOptions = {
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

function assertRegisterInput(input: unknown): RegisterChannelConnectionInput {
	const valid = registerChannelConnectionInput(input);
	if (valid instanceof type.errors) {
		throw validationError("register channel connection invalid", valid.summary);
	}
	return valid;
}

function assertLookup(input: unknown): ChannelConnectionLookup {
	const valid = channelConnectionLookupInput(input);
	if (valid instanceof type.errors) {
		throw validationError("channel connection lookup invalid", valid.summary);
	}
	return valid;
}

function assertConnectionRecord(input: unknown): ChannelConnectionRecord {
	const valid = channelConnectionRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("channel connection record invalid", valid.summary);
	}
	return valid;
}

function listWhere(filter: ChannelConnectionListFilter): Where[] {
	const where: Where[] = [];
	const add = (fieldName: string, value: string): void => {
		where.push(
			where.length === 0
				? { field: fieldName, value }
				: { field: fieldName, value, connector: "AND" },
		);
	};
	if (filter.provider !== undefined) add("provider", filter.provider);
	if (filter.organizationId !== undefined)
		add("organizationId", filter.organizationId);
	if (filter.mode !== undefined) add("mode", filter.mode);
	if (filter.status !== undefined) add("status", filter.status);
	return where;
}

/** The connection registry — user-registered bots persisted through a schema-aware adapter. */
export function createChannelConnectionsStore(
	// The schema-aware adapter the assembly hands through the configure context; tests wrap manually.
	db: Adapter,
	options: ChannelConnectionsStoreOptions = {},
): ChannelConnectionsStore {
	const now = options.now ?? (() => new Date().toISOString());

	const patchByKey = async (
		lookup: ChannelConnectionLookup,
		patch: Record<string, unknown>,
	): Promise<ChannelConnectionRecord | null> => {
		const valid = updateChannelConnectionInput(patch);
		if (valid instanceof type.errors) {
			throw validationError("channel connection patch invalid", valid.summary);
		}
		const row = await db.update<ChannelConnectionRecord>({
			model: "channel_connection",
			where: [{ field: "id", value: endpointId(lookup) }],
			update: { ...valid, updatedAt: now() },
		});
		return row ? assertConnectionRecord(row) : null;
	};

	return {
		async register(input) {
			const valid = assertRegisterInput(input);
			const { provider, endpointKey, ...rest } = valid;
			const lookup = { provider, endpointKey };
			// Re-registration is the trust grant: rotate credentials/defaults and re-activate.
			const existing = await this.getByKey(lookup);
			if (existing) {
				const updated = await patchByKey(lookup, { ...rest, status: "active" });
				if (updated) return updated;
			}
			const ts = now();
			const record = assertConnectionRecord({
				...valid,
				id: endpointId(lookup),
				status: "active",
				createdAt: ts,
				updatedAt: ts,
			});
			try {
				await db.create({ model: "channel_connection", data: record });
				return record;
			} catch (err) {
				// create raced another register onto the same natural key (id is its hash) — fall through
				// to patching the winner's row.
				const raced = await patchByKey(lookup, { ...rest, status: "active" });
				if (raced) return raced;
				throw err;
			}
		},

		get(id) {
			return db.findOne<ChannelConnectionRecord>({
				model: "channel_connection",
				where: [{ field: "id", value: id }],
			});
		},

		getByKey(input) {
			const lookup = assertLookup(input);
			return this.get(endpointId(lookup));
		},

		list(filter = {}) {
			return db.findMany<ChannelConnectionRecord>({
				model: "channel_connection",
				where: listWhere(filter),
			});
		},

		revoke(input) {
			const lookup = assertLookup(input);
			return patchByKey(lookup, { status: "disabled" });
		},

		record(key, event) {
			const lookup = assertLookup(key);
			switch (event.kind) {
				case "received":
					return patchByKey(lookup, {
						lastError: null,
						lastReceivedAt: now(),
					});
				case "polled":
					return patchByKey(lookup, {
						cursor: event.cursor,
						lastError: null,
						lastPolledAt: now(),
					});
				case "poll-error":
					return patchByKey(lookup, {
						lastError: event.error,
						lastPolledAt: now(),
					});
			}
		},
	};
}
