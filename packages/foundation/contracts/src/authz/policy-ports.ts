// The slice-6b store PORTS — the behavioural protocol (verbs) the durable stores satisfy, kept apart
// from the entity/schema declarations (mirrors tools/registry-ports.ts). Types only; the impls live
// in @euroclaw/storage-durable (createRegistryStores).

import type { AuthzChangeAppend, AuthzChangeRecord } from "./change-log";
import type { PolicySliceRecord, PolicySliceUpsert } from "./policy-slice";

/** A customer's Cedar policy slices; replace-by-(organizationId, name). */
export type PolicySliceStore = {
	listByOrganization: (organizationId: string) => Promise<PolicySliceRecord[]>;
	upsert: (input: PolicySliceUpsert) => Promise<PolicySliceRecord>;
	/** Org-scoped delete: a slice is removed only when the id belongs to `organizationId`, so a
	 *  caller in one org can never delete another org's slice by id (defense in depth). No-op when
	 *  absent. */
	delete: (organizationId: string, id: string) => Promise<void>;
};

/** The append-only authz change log. `count` is the cheap per-decision read the org router keys on;
 *  `listByOrganization` is the (deferred-use) read-side history. */
export type AuthzChangeStore = {
	append: (input: AuthzChangeAppend) => Promise<AuthzChangeRecord>;
	count: (organizationId: string) => Promise<number>;
	listByOrganization: (organizationId: string) => Promise<AuthzChangeRecord[]>;
};
