# Redaction DX — the `redaction` config group on createClaw

Status: **designed, ready to build**. Companion to `redaction-coherence-plan.md` (independent — can build before/after/parallel; the per-claw posture semantics come from the busyclaw routing design, 2026-07-12).
Layer: `euroclaw` assembly (config group, claw field, creation API, wiring), `@euroclaw/core` (one small routing-redactor factory). Contracts and runtime UNCHANGED — `createRuntime.redactor` stays the mechanism port.

## Problem — today's composition is three constructors and a hand-rolled wrapper

```ts
const strict = createStoredRedactor({
  mappings: createPiiMappingStore(adapter),   // same adapter passed twice
  detector: realDetector,
  indexKey,
});
createClaw({
  database: adapter,
  redactor: routingRedactor({                 // app-land wrapper, everyone re-writes it
    strict,
    postureOf: async (ctx) => (await postureFor(ctx?.scopeId)) ?? "strict",  // re-implements claw-row reads + caching
  }),
});
```

- The adapter is passed twice; every other store (claws, effects, registry) is derived INSIDE `createClaw` from `database` — the PII mapping store is the odd one out.
- `postureOf` forces the host to re-implement claw-row reads, caching, and the fail-closed default.
- Passing `database` without a redactor throws "database-backed runtime approvals require a durable redactor" and leaves the user to discover the whole dance.
- `redactor` names the mechanism; what a host configures is redaction **policy**: detector, dedup key, posture.

## The API

One config group, a discriminated union over `posture`:

```ts
redaction?:
  | { posture?: "strict"; detector?: Detector; indexKey?: string; redactor?: Redactor }
  | { posture: "per-claw"; default?: "strict" | "raw"; detector?: Detector; indexKey?: string; redactor?: Redactor }
  | { posture: "raw" }
```

The three deployment shapes:

```ts
// eu-ish: every conversation redacted (posture defaults to "strict")
createClaw({ database, redaction: { detector: piiDetector(), indexKey: process.env.PII_INDEX_KEY } });

// busyclaw: per-conversation choice, deployment default raw
createClaw({ database, redaction: { posture: "per-claw", default: "raw", detector: piiDetector(), indexKey } });
await claw.api.claws.create({ ..., redaction: "strict" });   // typed param, exists only in per-claw mode

// conscious raw: durable + unredacted, declared out loud
createClaw({ database, redaction: { posture: "raw" } });

// quickstart (no database): omit redaction entirely — unchanged semantics
```

## Semantics

- **`strict`** — assembly builds `createStoredRedactor({ mappings: createPiiMappingStore(adapter), detector, indexKey })` from the SAME adapter as everything else. `detector` omitted → armed-but-silent (noopDetector, today's meaning). `indexKey` omitted → no dedup, one boot warn (coherence plan's fail-soft).
- **`per-claw`** — same stored redactor, wrapped by the routing redactor. The assembly owns what the host used to hand-roll:
  - contributes a `redaction: "strict" | "raw"` field to the claw model (same `collectModelFields`/additionalFields path plugins use);
  - `api.claws.create` gains the typed `redaction?` param (folded via the config generic, the `$Infer` machinery); **no update path** — posture is immutable at birth (mixed-transcript rule);
  - internal `postureOf` reads the row via `clawsStore` and caches **forever per id** — immutability makes cache invalidation a non-problem by construction;
  - `default` (fallback `"strict"`) applies to new rows AND context-less redaction calls (one rule, no special case — it is literally named default).
- **`raw`** — the explicit, honest opt-out: durable state persists unredacted and per-subject erasure does not exist for it. Boot logs one warn line (same pattern as `validateSecretsAtBoot`). Implementation: the boot guard (`runtime.ts:394-398`) accepts the declared choice — the guard's job was preventing *accidental* raw durability, and a written `posture: "raw"` is not an accident. No detector/indexKey fields exist on this arm (the union forbids them — you cannot half-configure raw).
- **`redactor?` inside the group** = full-custom escape hatch (tests, exotic stores); mutually exclusive with `detector`/`indexKey` at runtime (`configurationError`). The top-level `createClaw.redactor` field is REMOVED (pre-alpha, no deprecation cycle) — one door per layer: `createClaw.redaction` is policy, `createRuntime.redactor` stays the port.
- **Error-message DX**: `database` present + no `redaction` group → the existing configurationError now says what to write: add `redaction: { detector, indexKey }`, or `redaction: { posture: "raw" }` to accept unerasable persistence.

## Internals

- `createRoutingRedactor({ strict, postureOf })` lands in `@euroclaw/core` beside `createStoredRedactor` (impl never in contracts; it is a Redactor-over-Redactor combinator: `durable` passthrough, `redactValue` routes, `rehydrateValue` delegates — inert in raw containers by containment).
- Assembly wiring in `packages/euroclaw/src/index.ts`: resolve `redaction` → a `Redactor` → pass down as the runtime's `redactor`. Claw-field contribution merges into the same `collectModelFields` input as plugin fields.
- Optional tiny helper, same slice: `composeDetectors(...detectors)` (concat spans; `cleanSpans` already resolves overlaps) — hosts will want email+phone+… without writing the fold.

## Rejected alternatives

- **`redaction()` as a plugin** — the secrets precedent says the opposite: contributions ride plugins, but the one-door *infra mechanism* is assembly-built and top-level (`secrets:[]` is never a plugin). The redactor is the same kind of load-bearing singleton; two plugins contributing redactors has no sane merge. The future `eu()` plugin *seals* posture (forces `strict`), it doesn't own the mechanism.
- **`posture: (ctx) => ...` function form** — a free function can flap mid-conversation, which reintroduces the mixed transcript the whole design forbids. The declarative form makes birth-immutability the only expressible thing. Revisit only if a real consumer needs non-row routing.
- **`redaction: "off"` string shorthand** — too silent for what it does; the object form with the word `posture: "raw"` is the loudness the mercury lesson demands.
- **`redaction: Redactor` top-level union** — type-ugly and re-opens two doors; the escape hatch lives inside the group.

## Tests (minimum)

Strict: adapter reused (no second adapter accepted anywhere); armed-but-silent without detector. Per-claw: field contributed + typed create param; default applies to new rows and context-less calls; posture immutable (update rejected); cache-forever correctness (row read once per id); strict row redacts / raw row byte-identical in ONE assembly. Raw: boots with database, one warn, no redaction anywhere; union rejects detector on the raw arm (type-level test). Both `redactor` + `detector` in group → configurationError. Old top-level `redactor` on createClaw → type error (removed). Guard error message names the new API.

## Verification gate

Touches `createClaw` public config type — full turbo typecheck + full test suite + repo-wide grep for `redactor:` usage including tests/ (`packages/euroclaw/tests/fixtures.ts` and runtime tests construct redactors directly against `createRuntime` — those stay valid; only `createClaw({ redactor })` call sites migrate).
