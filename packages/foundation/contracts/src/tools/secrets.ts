// The secret-resolution PORT — how the invoker (slice 6a) obtains credential material for a
// registered tool's security requirements. Ports are behaviour, not data — plain types, no
// schema; the resolver is host-wired code, not something that crosses a boundary as data.
//
// euroclaw stores NO secrets. The host wires this seam to wherever credentials actually live —
// env vars, AWS SSM, Infisical, Vault, a DB-backed credential entity later — each an ADAPTER
// behind the one port, added without touching the invoker or each other. The resolver returns
// secret MATERIAL only; HOW to apply it (apiKey-in-header-named-X, bearer, basic) is read from
// the registered spec's own `securitySchemes` (the specBlob is kept claim-check style for
// exactly this). Token-minting flows (OAuth client-credentials, refresh) live INSIDE a resolver
// implementation — it returns a fresh token like any other material.
// See docs/plans/authz-blueprint-plan.md (slice 6a, secrets ruling).

/** One security requirement to satisfy. Extensible object on purpose — new facts (a per-user
 *  credential, a scope narrowing) must never be a breaking signature change. */
export type SecretRequest = {
	organizationId: string;
	/** The registration source slug. Part of the KEY: security scheme names are LOCAL to a spec
	 *  document — two registered specs may both declare a scheme called "apiKey". */
	source: string;
	/** The scheme name exactly as the spec declares it (its `securitySchemes` key). One scheme =
	 *  one credential, per OpenAPI's own model; AND-ed requirements resolve scheme by scheme. */
	scheme: string;
	/** The scopes the operation's security requirement asks for — a token-minting resolver
	 *  (OAuth client-credentials) requests exactly these, nothing broader. */
	scopes?: readonly string[];
	/** The acting principal, when the host resolves per-USER credentials — borrowed authority
	 *  down to the credential: the claw calls out with the actor's own token, not an org-wide one. */
	actor?: string;
};

/** Secret material, shaped by what schemes need — never how to apply it (the spec knows that). */
export type SecretMaterial =
	| { kind: "token"; value: string }
	| { kind: "basic"; username: string; password: string };

/**
 * Resolve the credential material for one security requirement. The two failure modes must stay
 * distinguishable all the way to the audit: return `null` for "no credential configured for this
 * request" (the invoker fails the call loud when the requirement was mandatory — an actionable
 * configure-your-credential error, not a mystery); THROW for infrastructure failure (vault
 * unreachable) — a resolver must never coerce an outage into a missing credential.
 */
export type SecretResolver = (
	request: SecretRequest,
) => SecretMaterial | null | Promise<SecretMaterial | null>;
