# AI SDK UI bridge — `useChat` against a claw

Status: **designed, ready to build** (slice A). Goal: a claw endpoint any AI-SDK client hook
(`useChat`, `@ai-sdk/react`) consumes natively — the standard fullstack chat DX over a governed
runtime. Wire protocol below was verified against the v5 docs; the repo has since moved to
`ai@7.0.22` (2026-07-13) — RE-VERIFY the UI message stream header/part names against the v7
`@ai-sdk/react` docs at build time (the v6/v7 migration guides did not change the concepts —
tool-approval parts still exist — but part names and the protocol version header may differ).

## The protocol (verified 2026-07-13)

AI SDK 5 UI message streams are SSE with header `x-vercel-ai-ui-message-stream: v1`, JSON chunks,
`data: [DONE]` terminator. Relevant part types: `start`/`finish`, `start-step`/`finish-step`,
`text-start`/`text-delta`/`text-end`, `tool-input-available`, `tool-output-available`,
**`tool-approval-request`/`tool-approval-response`** (native human-in-the-loop), `data-*`
(custom), `error`.

The fit is unusually clean: euroclaw's runtime EVENTS are already the exact lifecycle the
protocol streams, with REDACTED payloads — the default wire is leak-free by construction, which
is a busyclaw selling point no `streamText`-direct backend has: `useChat` streams tokens
(placeholders), never raw PII, unless the server explicitly serves the audited original view.

## Slice A — event-driven bridge (NO runtime/core changes)

Everything required exists today: `api.sendMessage({ runId })` accepts a pre-allocated runId;
every event envelope carries `runId` (`events.ts createRuntimeEvent`); event payloads are
redacted; approvals park durably and `api.continueRun` resumes with recording context.

New module in `@euroclaw/adapter-core` (fetch-shaped like `toRequestHandler` — works in TanStack
Start server routes, Next, anything Request→Response):

1. **`createUiStreamBroker(): { sink: RuntimeEventSink; subscribe(runId, listener): unsubscribe }`**
   — installed ONCE at `createClaw({ events: [broker.sink, ...] })`; fans events out to per-run
   listeners. Subscribe BEFORE `sendMessage` (runId pre-allocated) — no missed events.
2. **`clawChatHandler(claw, broker, options)`** → `(request: Request) => Promise<Response>`:
   parses the useChat POST (client's `prepareSendMessagesRequest` supplies `{ clawId, threadId,
   message }`), subscribes the runId, fires `api.sendMessage`, translates events → SSE parts:
   - `run.started` → `start` + `start-step`
   - `tool.called` → `tool-input-available` (redacted args verbatim)
   - `tool.completed` → `tool-output-available` (redacted output verbatim)
   - `tool.waiting_approval` → `tool-approval-request` (carry approvalIds)
   - `tool.denied` / `tool.failed` → `data-governance` part / `error`
   - awaited `sendMessage` result → `text-start` + ONE `text-delta` (full final text) +
     `text-end` + `finish-step` + `finish` + `[DONE]`. Step-granular in slice A — tools appear
     live as the run progresses; the answer lands as one part. (Token deltas are slice B; the
     wire contract does not change.)
3. **Approvals round-trip**: the client approval response routes to the same handler →
   `api.grantApproval`/`denyApproval` + `api.continueRun` (recording-aware) → the continuation
   streams as the next response in the same conversation. If the hook's native
   `tool-approval-response` flow fights us on any detail, fall back to a `data-approval` part +
   explicit approve/deny UI hitting the claw routes — still protocol-legal, still audited.
4. **Views**: default wire = redacted. `view: "original"` (host-authorized, same trust model as
   slice 2) rehydrates COMPLETE parts before emit — at part granularity there is no split-token
   problem — and lands ONE `pii.reidentification` audit record per stream via `$context.redaction`.
5. **History**: `toUIMessages(records)` mapper so `useChat` hydrates from
   `listMessages({ view })`.

Tests: broker filters by runId (two concurrent runs don't cross); SSE golden (header, part
order, `[DONE]`); raw email never on the default wire; original view rehydrates + audits once;
approval request part appears on `needs-approval`, continuation streams after grant; denied run
emits `data-governance`, not `error`.

## Slice B — true token streaming (runtime work, protocol unchanged)

The loop is `generateText`-per-step; streaming means: a `doStream` path in the loop, middleware
`wrapStream` (prompt redaction via `transformParams` already applies), a stream-aware model
boundary in governance (gates BEFORE first token, audit on finish), and — for original-view
streaming — a placeholder-boundary rehydration buffer (a `{{pii:…}}` token may split across
chunks; hold back the longest suffix matching a token prefix). Sequence strictly after A: A
ships the DX this week-shaped; B swaps one-delta-per-step for token deltas under the same wire.

## Non-goals

- No client-side governance, ever — the client is untrusted; the bridge only rebroadcasts
  already-governed, already-redacted server events (mercury rule).
- No parallel event schema: the bridge TRANSLATES runtime events; it never grows its own
  lifecycle the runtime doesn't emit.
