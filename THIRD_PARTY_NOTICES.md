# Third-Party Notices

euroclaw includes, adapts, or derives from third-party open-source software. The
licenses and copyright notices below are reproduced as required by those
licenses. This file is the canonical attribution record; per-file headers point
back here.

> **How we use this file.** When you copy or adapt *code* from a project listed
> here, add a header comment to the file (see `docs/architecture/12-conventions.md`)
> and, if the project isn't already listed, add an entry below with its verbatim
> copyright line and full license text. Reusing only a project's *design or
> patterns* (not its code) needs no entry — ideas and APIs aren't copyrightable.

---

## Better Auth

- **Project:** Better Auth — https://github.com/better-auth/better-auth
- **License:** MIT
- **Used in euroclaw:** portions of the type-level and plugin machinery are
  *adapted from* Better Auth's **patterns/API** (not verbatim code). Files:
  - `packages/core/src/governance/plugin.ts` — the plugin-as-data-object shape with phantom
    type carriers (`$Infer`, `$InferContext`, `$REASON_CODES`) and the tuple-fold that
    intersects a field across all plugins (cf. `InferPluginFieldFromTuple` /
    `InferPluginTypes`). The `UnionToIntersection` / `IsAny` helpers are ubiquitous
    community TS idioms, not Better Auth's.
  - `packages/core/src/governance/reason-codes.ts` — the `defineReasonCodes` catalog pattern adapted
    from Better Auth's `defineErrorCodes`.
  - `packages/core/src/governance/governance.ts` — the generic-config factory shape
	    `createGovernance<const Config>(config): Governance<Config>` and folding plugin types
	    onto the instance (cf. `betterAuth<Options>(options)`).
  - `packages/storage/core/src/index.ts` — the `Adapter` CRUD port (incl. the atomic
    `consumeOne` single-use primitive), the `Where` shape, and the declarative table-schema
	format, based on Better Auth's database adapter (`packages/core/src/db`, `DBAdapter`) and
    its plugin schema files (`packages/better-auth/src/plugins/*/schema.ts`). euroclaw's port is
    a leaner subset.
  - `packages/storage/kysely/src/index.ts` / `packages/storage/drizzle/src/index.ts` — the SQL
    storage adapters, modeled on Better Auth's `packages/kysely-adapter` /
    `packages/drizzle-adapter` (the CRUD/where translation reimplemented against each ORM's
    public API). `kyselyAdapter`'s raw-driver intake (duck-typing a better-sqlite3 `Database` /
     `pg` `Pool` / Kysely `Dialect` and wrapping it in Kysely) follows the approach of Better Auth's
     `packages/kysely-adapter/src/dialect.ts` (`createKyselyAdapter` / `getKyselyDatabaseType`).
  > Note: under MIT, reusing patterns/APIs (as here) requires **no** attribution —
  > ideas and APIs aren't copyrightable. These files are listed as a courtesy. If we
  > later copy *verbatim* code, switch the header to "copied from" and say so here.

### License (verbatim)

```
The MIT License (MIT)
Copyright (c) 2024 - present, Bereket Engida

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

---

## NullTickets

- **Project:** NullTickets — local source reviewed at `/Users/konstantinponomarev/Downloads/nulltickets-main`
- **License:** MIT
- **Used in euroclaw:** the lease/claim/heartbeat/idempotency engine kernel is
  *adapted from* NullTickets' **patterns/architecture** (not copied code). Files:
  - `packages/engines/sql/src/store.ts` — task/run/lease/idempotency store shape,
    hashed one-time lease tokens, heartbeat, complete/fail, reaping, and response replay.
  - `packages/engines/sql/src/worker.ts` — claim/execute/complete/fail worker loop shape.
  - `packages/engines/sql/src/schema.ts` — SQL engine schema shape for tasks, runs, leases,
    runtime events, and idempotency records.

  > Note: this is listed as a provenance courtesy. The implementation is independent TypeScript
  > over euroclaw's storage Adapter. If we later copy verbatim code, update this notice accordingly.

### License (verbatim)

```
MIT License

Copyright (c) 2026 nullclaw contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## NullBoiler

- **Project:** NullBoiler — local source reviewed at `/Users/konstantinponomarev/Downloads/nullboiler-main`
- **License:** MIT
- **Used in euroclaw:** the SQL orchestrator/run-event/checkpoint engine shape is
  *adapted from* NullBoiler's **patterns/architecture** (not copied code). Files:
  - `packages/engines/sql/src/store.ts` — run/event engine-store shape and operational runtime-state framing.
  - `packages/engines/sql/src/worker.ts` — explicit orchestrator/executor boundary.
  - `packages/engines/sql/src/schema.ts` — engine schema shape for run/event/task records.

  > Note: this is listed as a provenance courtesy. The implementation is independent TypeScript
  > over euroclaw's storage Adapter. If we later copy verbatim code, update this notice accordingly.

### License (verbatim)

```
MIT License

Copyright (c) 2026 nullclaw contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

<!--
To add another dependency you copy/adapt CODE from, duplicate the block above:

## <Project name>

- **Project:** <name> — <url>
- **License:** <SPDX id, e.g. MIT / Apache-2.0>
- **Used in euroclaw:** <what / which files>

### License (verbatim)

```
<paste the project's exact copyright line + full license text>
```
-->
