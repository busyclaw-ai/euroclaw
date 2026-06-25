# @euroclaw/channel-telegram

Telegram channel plugin for euroclaw.

```ts
import { telegramChannel } from "@euroclaw/channel-telegram"
import { createClaw } from "euroclaw"

const telegram = telegramChannel({
  tenantId: "tenant-1",
  endpointKey: "recruiting",
  client,
})

const claw = createClaw({
  model,
  database,
  redactor,
  cronHandler: { secret: process.env.EUROCLAW_CRON_SECRET! },
  plugins: [telegram],
})
```

Default mode is `poll`, so the channel contributes a cron task and `createClaw({ cronHandler })` is required. Use `mode: "webhook"` for webhook-only integration.

Multiple bots should set unique `endpointKey` values and unique webhook paths:

```ts
telegramChannel({
  tenantId: "tenant-1",
  endpointKey: "support",
  mode: "webhook",
  webhook: { path: "/telegram/support/webhook" },
  client,
})
```
