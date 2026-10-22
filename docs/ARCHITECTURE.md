# Architecture

## Overview

```text
 browser                 frontend container          backend container             gateway container
┌───────────┐  HTTP     ┌──────────────────┐  HTTP   ┌──────────────────┐  WebSocket ┌──────────────────┐  HTTPS
│ Vue page  │ ────────► │ nginx :8080      │ ──────► │ Node + Fastify   │ ─────────► │ OpenClaw gateway │ ──────► OpenRouter
│           │ ◄──SSE─── │ static + /api/   │ ◄─SSE── │ :3000, no port   │ ◄──events─ │ :18789           │          (model)
└───────────┘           └──────────────────┘         │ published        │            └──────────────────┘
                                                     └──────────────────┘
 host ports (127.0.0.1 only): 8080 ──────────────────────────────────────────────────── 18789 (local dev)
```

One message, end to end:

1. The page sends `POST /api/chat` with `{ message, sessionKey }`. nginx forwards it to the backend.
2. The backend validates the body, subscribes to `chat` events, then sends `chat.send` with a fresh `idempotencyKey`. The gateway answers with a `runId`.
3. The gateway runs the agent and pushes `chat` events: `status` while it prepares (the page shows the phase in the empty bubble), `delta` with text, `final` with the whole message. When the agent calls a tool, `agent` events with `stream: "tool"` arrive on the same connection: `start` with the arguments, `result` with the output.
4. The backend keeps the events of its session and run, turns each tool phase into a `tool` event, and writes everything as SSE events. nginx passes them through unbuffered. The page appends the text as it arrives and keeps one card per tool call.
5. If the browser drops the request (Stop, tab closed), the backend sees the close and sends `chat.abort` for that run.

Of the task's bonuses, two are in: device authentication (the signed `connect`, under Security) and tool call display (the cards).

## Decisions

Each one with the alternative I did not take.

**A backend between the browser and the gateway.** The gateway wants a shared token and an Ed25519 device identity, approved once. The backend holds both, keeps one WebSocket open, and gives the browser one HTTP endpoint and no secrets. The alternative, the page talking to the gateway directly as its Control UI does, puts the token and a private key in the browser and makes every tab a device to approve.

**A gateway client written by hand on `ws`.** Handshake, request/response by id, events, reconnect with backoff, pairing retry. The types are copied from `protocol.schema.json`. Understanding the protocol is the point of the exercise, so I did not depend on `@openclaw/gateway-client`; I read it to get the signed payload right.

**SSE over POST, not a WebSocket to the browser.** One request is one run. The page reads the body as a stream with `fetch` and `ReadableStream`; an `AbortController` gives it Stop, and the dropped request is the signal for `chat.abort`. A WebSocket becomes necessary once the page must send things during a run (tool approvals, answers to questions), which the task does not need. `EventSource` is GET only and its reconnect would resend the message.

**One gateway session per page load.** The page picks `agent:main:web-<uuid>` once; the backend checks the key against `^agent:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$`, so a client cannot reach other session kinds. Keeping the key in `sessionStorage` would bring the page back empty after a refresh while the model still remembers. That needs `chat.history` first (next steps).

**Pairing: approve once by hand, keep the identity in a volume.** The backend logs the request id and the exact command and retries every 5 seconds. `devices approve` runs inside the gateway container over loopback, so the backend needs only `operator.read` and `operator.write`. Approval and key pair survive restarts and rebuilds. `dangerouslyDisableDeviceAuth` would remove the step and the second authentication layer with it.

**Secrets and the model: environment in, config at start.** `.env` is git-ignored and Compose refuses to start when a secret is empty. The OpenRouter key reaches the gateway container only. `openclaw.json` holds `${OPENCLAW_GATEWAY_TOKEN}` as a placeholder. The model comes from `OPENCLAW_MODEL` and is set with `openclaw config set` at start, because the CLI validates model names before it substitutes variables. The start script merges the config with `openclaw config patch`: the image runs `doctor --fix` first, and doctor restores its last-known-good copy over a plain `cp`.

**nginx in front of the page and the API.** One origin, one host port, no CORS. `proxy_buffering off` and `X-Accel-Buffering: no` keep the events flowing. `proxy_pass` goes through a variable and Docker's DNS, so a recreated backend container is found without an nginx restart. Serving the static files from Fastify would save a container and give the backend two jobs.

**Tool calls from the `agent` stream, one card per call.** The `chat` stream carries only the assistant text. What the agent does in between is on the `agent` stream with `stream: "tool"`: `start` with the tool name and arguments, `result` with the output and `isError`. The gateway sends those only to the connection that started the run and declared the `tool-events` cap at `connect`, so the backend declares it, keeps the events of its `runId`, and forwards one `tool` event per phase. The page updates the card with that `toolCallId` in place. Two things are left out on purpose: `update` events with partial output, to keep the stream small, and the `tool_call` dispatcher through which the gateway runs tools loaded on demand, because the tool itself follows as its own event. The alternative, reading the tool blocks back with `chat.history` after the run, shows the cards after the reply instead of while the tool runs.

Smaller choices: Fastify for body schema validation and pino; Vue 3 because it is the framework I can explain best, three components and no store; `node:test` through `tsx`, no test dependency; pinned images, because the gateway ships weekly.

## Security

- Two authentication layers to the gateway: the shared token and the signed device identity. The signature covers the server's nonce, so a captured handshake cannot be replayed.
- Scopes: `operator.read` and `operator.write` only.
- Secrets reach the containers as environment only. The backend logs `deviceId` and the pairing `requestId`, never the token or the key. Checked with grep over the logs and the served bundle.
- Surface: gateway on `127.0.0.1` only, backend with no published port, page on `127.0.0.1:8080`.
- Containers: non-root, all capabilities dropped, `no-new-privileges`. The identity file is `0600` in a volume.
- Input: body schema, `message` 1 to 8000 characters, `sessionKey` pattern, 64 KB body limit.
- Tools: `tools` is unset in the gateway config, so the agent has every built-in tool, `exec` in the gateway container included. `web_fetch` goes through the gateway's SSRF guard: `http://backend:3000/healthz` comes back as `Blocked: resolves to private/internal/special-use IP address`, and fetched pages are wrapped as untrusted content before the model reads them. The cards show every call and its result.
- Missing before any exposure beyond localhost: authentication on the page, TLS, rate limiting, and a tool policy (`tools.profile` or `tools.deny`) that takes `exec` away from the agent.

## Protocol notes

Found in the docs, the schema or the gateway source, and kept as rules in `CLAUDE.md`:

- Send nothing before `connect.challenge`. `device.signedAt` is the challenge `ts`. The signed `v2` payload must match the `connect` params field by field.
- `deviceId` is the SHA-256 of the raw public key; `publicKey` is base64url without padding.
- `chat.send` has no `model` field and rejects unknown keys. The model is gateway config.
- A `delta` with `replace: true` replaces the whole text. Right before `final` the gateway sends an empty `replace`; skip it, the reply is `final.message`.
- A connection through a published port counts as remote and needs pairing. The CLI inside the container is loopback and auto-approved.
- The gateway's doctor rewrites the config file at every start.
- `agent` events: `runId`, `seq`, `stream`, `ts` and an open `data`; no `sessionKey` in the schema, so filter by `runId`. On the tool stream, `data` is `{ phase: "start", name, toolCallId, args }`, then `{ phase: "result", name, toolCallId, isError, result: { content: [{ type: "text", text }] } }`; `update` carries `partialResult`.
- Tool events reach only the connection that sent `chat.send` with `caps: ["tool-events"]`. Without the cap the gateway never registers the connection as a recipient (`registerToolEventRecipient` in its chat.send handler). The `chat-only-assistant-text` cap drops the copy of the assistant text on the `agent` stream.
- Tools load on demand: the model gets `tool_search`, `tool_describe` and the `tool_call` dispatcher. A dispatched tool arrives as its own event with `parentToolCallId` and the id `tool_call:<parent>:<name>:1`.
- Gateway 2026.10.5 sends the whole reply as one `delta` right before `final` whenever the model's stream contains reasoning: open issue [#144765](https://github.com/openclaw/openclaw/issues/144765), kept on purpose in PR #125149. The provider does stream (`text/event-stream` in the gateway log); the gateway holds the text. Measured through nginx on the same model: 1 delta with the default thinking level, 24 to 79 with `agents.defaults.thinkingDefault: "off"`. The config sets `off`; a reply loses the model's thinking step, which a chat page can live with. `blockStreamingDefault` does not apply; it covers channels like Telegram.

## Next steps

1. Load the conversation on refresh: keep the session key in `sessionStorage`, fetch `chat.history` on open.
2. Survive a gateway restart mid-run: after the reconnect, read the session's last message with `chat.history` and finish the reply from it.
3. Partial tool output from `update` events while a long `exec` runs.
4. Authentication on the page, TLS, rate limiting and a tool policy before exposing it beyond localhost.
