# openclaw-chat

Chat client for an OpenClaw gateway (WebSocket protocol v4), built for a technical assessment.

## Stack (fixed)

- Backend: Node 22, TypeScript (strict), Fastify, `ws`
- Frontend: Vite, React, TypeScript, served by nginx in Docker
- Infra: Docker Compose (gateway, backend, frontend)
- Tests: `node:test`, run through `tsx`

No new runtime dependency without a one-line reason in the commit message.

## Principles

- Working beats polished. Make the smallest change that passes the current gate.
- One module, one reason to change. `gateway-client.ts` knows frames. `chat-service.ts` knows chat runs. `routes/chat.ts` knows SSE. Nothing imports upward.
- No premature abstraction. Three similar lines beat one clever helper.
- No `any` at the protocol boundary. Frame and event types live in `src/protocol.ts`, copied from `protocol.schema.json`.
- Errors are explicit. Surface the gateway `error.code` and `error.details.code`. Never swallow.
- Fail fast at startup when an env variable is missing.

## Security rules

- Secrets come from env only. `.env` is git-ignored. Never hardcode, never commit.
- Never log the gateway token, the OpenRouter key, the private key or the device token. Log `deviceId` and the pairing `requestId` only.
- Never set `dangerouslyDisableDeviceAuth` or `auth.mode: "none"`.
- Request the minimum scopes: `operator.read` and `operator.write`.
- Containers run as non-root. The gateway port is published on `127.0.0.1` only. The backend publishes no port.

## Protocol rules

- After the socket opens, send nothing until the `connect.challenge` event arrives.
- `device.signedAt` is the challenge `ts`. `device.nonce` is the challenge nonce.
- Sign exactly what you send. `clientId`, `clientMode`, `role`, `scopes` and `token` in the signed payload must equal the `connect` params.
- Filter `chat` events by `sessionKey` and `runId`. Filter `agent` events by `runId` only; they carry no `sessionKey`.
- A `delta` with `replace: true` replaces the whole text. Unknown `state` values are ignored, not fatal.
- Every `chat.send` carries a fresh `idempotencyKey`.
- `chat.send` has no `model` field and its schema rejects unknown keys. The model comes from the gateway config (`agents.defaults.model.primary`) or a per-session override through `sessions.patch`.

## Workflow

- Each milestone ends with a gate (a command that proves it works), a commit and a CHANGELOG entry under `[Unreleased]`.
- The CHANGELOG entry goes in the same commit as the change. It is never written at the end from memory.
- Claude does not run `git commit`, `git push` or `git tag`. When a gate passes, Claude proposes the commit message and the CHANGELOG entry, and the user runs git. Claude may run `git status`, `git diff` and `git log`.
- Commit messages follow Conventional Commits: `feat(scope): what changed`.

## Writing style

Applies to CHANGELOG, README, docs, commit messages and code comments.

- Plain English. Short sentences. One concrete fact per line.
- Say what changed and why. Skip how great it is.
- Banned: robust, seamless, leverage, comprehensive, powerful, cutting-edge, enhanced, emojis, filler openers.
- If a sentence could sit in any project's README, delete it.

## Commands

```bash
# backend, local dev against ws://localhost:18789
cd backend && npm run dev
cd backend && npm test
cd backend && npm run smoke     # connect, hello-ok, sessions.list; --chat sends one message, --stay keeps the connection

# full stack
docker compose up --build
docker compose exec openclaw-gateway node dist/index.js devices list
docker compose exec openclaw-gateway node dist/index.js devices approve <requestId>
```

## Sources of truth, in this order

1. docs.openclaw.ai, gateway protocol pages
2. `protocol.schema.json` from `@openclaw/gateway-protocol`. The schema wins over any example.
3. `packages/gateway-client/src` in github.com/openclaw/openclaw
