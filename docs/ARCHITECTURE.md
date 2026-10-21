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
3. The gateway runs the agent and pushes `chat` events: `status` while it prepares, `delta` with text, `final` with the whole message.
4. The backend keeps the events of its session and run and writes each one as an SSE event. nginx passes them through unbuffered. The page appends the text as it arrives.
5. If the browser drops the request (Stop, tab closed), the backend sees the close and sends `chat.abort` for that run.

## Decisions

Each one with the alternative I did not take.

**A backend between the browser and the gateway.** The gateway wants a shared token and an Ed25519 device identity, approved once. The backend holds both, keeps one WebSocket open, and gives the browser one HTTP endpoint and no secrets. The alternative, the page talking to the gateway directly as its Control UI does, puts the token and a private key in the browser and makes every tab a device to approve.

**A gateway client written by hand on `ws`.** Handshake, request/response by id, events, reconnect with backoff, pairing retry. The types are copied from `protocol.schema.json`. Understanding the protocol is the point of the exercise, so I did not depend on `@openclaw/gateway-client`; I read it to get the signed payload right.

**SSE over POST, not a WebSocket to the browser.** One request is one run. The page reads the body as a stream with `fetch` and `ReadableStream`; an `AbortController` gives it Stop, and the dropped request is the signal for `chat.abort`. A WebSocket becomes necessary once the page must send things during a run (tool approvals, answers to questions), which the task does not need. `EventSource` is GET only and its reconnect would resend the message.

**One gateway session per page load.** The page picks `agent:main:web-<uuid>` once; the backend checks the key against `^agent:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$`, so a client cannot reach other session kinds. Keeping the key in `sessionStorage` would bring the page back empty after a refresh while the model still remembers. That needs `chat.history` first (next steps).

**Pairing: approve once by hand, keep the identity in a volume.** The backend logs the request id and the exact command and retries every 5 seconds. `devices approve` runs inside the gateway container over loopback, so the backend needs only `operator.read` and `operator.write`. Approval and key pair survive restarts and rebuilds. `dangerouslyDisableDeviceAuth` would remove the step and the second authentication layer with it.

**Secrets and the model: environment in, config at start.** `.env` is git-ignored and Compose refuses to start when a secret is empty. The OpenRouter key reaches the gateway container only. `openclaw.json` holds `${OPENCLAW_GATEWAY_TOKEN}` as a placeholder. The model comes from `OPENCLAW_MODEL` and is set with `openclaw config set` at start, because the CLI validates model names before it substitutes variables. The start script merges the config with `openclaw config patch`: the image runs `doctor --fix` first, and doctor restores its last-known-good copy over a plain `cp`.

**nginx in front of the page and the API.** One origin, one host port, no CORS. `proxy_buffering off` and `X-Accel-Buffering: no` keep the events flowing. `proxy_pass` goes through a variable and Docker's DNS, so a recreated backend container is found without an nginx restart. Serving the static files from Fastify would save a container and give the backend two jobs.

Smaller choices: Fastify for body schema validation and pino; Vue 3 because it is the framework I can explain best, three components and no store; `node:test` through `tsx`, no test dependency; pinned images, because the gateway ships weekly.

## Security

- Two authentication layers to the gateway: the shared token and the signed device identity. The signature covers the server's nonce, so a captured handshake cannot be replayed.
- Scopes: `operator.read` and `operator.write` only.
- Secrets reach the containers as environment only. The backend logs `deviceId` and the pairing `requestId`, never the token or the key. Checked with grep over the logs and the served bundle.
- Surface: gateway on `127.0.0.1` only, backend with no published port, page on `127.0.0.1:8080`.
- Containers: non-root, all capabilities dropped, `no-new-privileges`. The identity file is `0600` in a volume.
- Input: body schema, `message` 1 to 8000 characters, `sessionKey` pattern, 64 KB body limit.
- Missing before any exposure beyond localhost: authentication on the page, TLS, rate limiting.

## Protocol notes

Found in the docs, the schema or the gateway source, and kept as rules in `CLAUDE.md`:

- Send nothing before `connect.challenge`. `device.signedAt` is the challenge `ts`. The signed `v2` payload must match the `connect` params field by field.
- `deviceId` is the SHA-256 of the raw public key; `publicKey` is base64url without padding.
- `chat.send` has no `model` field and rejects unknown keys. The model is gateway config.
- A `delta` with `replace: true` replaces the whole text. Right before `final` the gateway sends an empty `replace`; skip it, the reply is `final.message`.
- A connection through a published port counts as remote and needs pairing. The CLI inside the container is loopback and auto-approved.
- The gateway's doctor rewrites the config file at every start.

## How I used AI

Claude Code, throughout.

- I started from an AI-generated to-do list and had it checked claim by claim against docs.openclaw.ai and `protocol.schema.json` before writing code. Eight claims were wrong, among them `client.id` (a closed enum), `client.mode` (`backend`; `operator` is the role) and the meaning of `delta.replace`. From then on every protocol claim was checked against the schema.
- The rules are in `CLAUDE.md`: fixed stack, security and protocol rules, writing style. Work went in milestones, each ending with a gate (a command, a log line, a browser check), a commit and a CHANGELOG entry.
- The AI wrote code and tests. I ran every gate and every git command, so nothing landed unread.
- Things it got wrong and how they surfaced: the config copy that doctor overrode (compared what the gateway ran with what the repo said); a chat service that blanked the reply on the empty `replace` before `final` (raw dump of the events); a Vite proxy on `localhost` that Node resolved to `::1`.
- Browser checks ran in a headless Chrome over the DevTools protocol: the text growing, the Stop click, the gateway's abort log.

## Next steps

1. Load the conversation on refresh: keep the session key in `sessionStorage`, fetch `chat.history` on open.
2. Survive a gateway restart mid-run: after the reconnect, read the session's last message with `chat.history` and finish the reply from it.
3. Tool-call cards from `agent` events, filtered by `runId` and `stream: "tool"`.
4. Authentication on the page, TLS and rate limiting before exposing it beyond localhost.
