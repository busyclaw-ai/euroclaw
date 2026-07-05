// The entity DIRECTORY — the instance side of the authorization model: concrete Tool/McpServer
// entities with attributes, parents, and tags, plus (later) principals synced from external
// systems (better-auth orgs, IdPs, SAP role assignments). Entities are DERIVED, rebuildable data —
// no persisted table; the assembly rebuilds them from the catalog on boot and on sync.

import type { JsonObject } from "../common";
import type { EntityRef } from "./request";

/** One directory entity. `parents` places it in the hierarchy (`resource in McpServer::"github"`);
 *  `tags` carry string facts policies match (`resource.getTag("access") == "write"` in Cedar). */
export type AuthzEntity = {
	uid: EntityRef;
	attrs?: JsonObject;
	parents?: readonly EntityRef[];
	tags?: Record<string, string>;
};

/**
 * The directory PORT — a provider, not a construction-time snapshot, because the directory changes
 * at runtime (MCP catalog sync, external principal syncers). Engines call it per evaluation or
 * cache-and-invalidate; the assembly owns wiring and refresh. Synced external state is bounded-
 * stale by nature — the staleness window is a documented property, never hidden.
 */
export type EntityDirectory = () => Promise<readonly AuthzEntity[]>;
