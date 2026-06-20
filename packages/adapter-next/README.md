# @euroclaw/adapter-next

Thin Next.js route-handler adapter for euroclaw, inspired by Better Auth's `toNextJsHandler` shape.

```ts
import { toNextJsHandler } from "@euroclaw/adapter-next"
import { claw } from "@/lib/euroclaw"

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(claw)
```

The heavy lifting lives in `@euroclaw/adapter-core`; this package only adapts the handler to Next.js' route export shape. The same handler exposes API routes, plugin/channel routes, and the built-in `POST /cron` trigger for connected cron tasks.

For browser/server clients, use `createClawClient(...)` from `@euroclaw/adapter-core` against the same base route:

```ts
import { createClawClient } from "@euroclaw/adapter-core"

const client = createClawClient({ baseUrl: "/api/euroclaw" })
```
