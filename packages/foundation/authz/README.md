# @euroclaw/authz

The euroclaw authz toolkit. The protocol (the `PolicyEngine` port, the PARC request contracts, the
authorization-model types) lives in `@euroclaw/contracts`; the hot-path enforcement lives in
`@euroclaw/core`; the engines live in `@euroclaw/policy-*`. This package is the machinery between
them:

- `createPolicyPlugin` — adapt any `PolicyEngine` into a euroclaw plugin: a cross-cutting,
  deny-by-default before-gate (`mapCall → engine.authorize → GateDecision`).
- `buildAuthzModel` — assemble the canonical authorization model (actions, groups, entity types,
  a content-pinned version) from stamped tool definitions and hand-authored domain verbs.

Planned here (the blueprint pipeline): the shared spec-projection helpers the OpenAPI/MCP
extractors stamp tools with (verb/hint → access, JSON-Schema → policy-visible args subset), the
Cedar schema/entity renderings of the model (pure string generation — Cedar *validation* stays in
`@euroclaw/policy-cedar`), starter-policy seeding, and the coverage checks behind the validate CLI.
