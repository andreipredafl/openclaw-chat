# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project skeleton: folder layout, env example, README, this changelog, engineering rules in `CLAUDE.md`
- Compose service `openclaw-gateway`: pinned image 2026.10.5, token auth, healthcheck, state volume, port on 127.0.0.1 only
- `openclaw/openclaw.json` and `openclaw/start.sh`: the start script merges the repo config with `openclaw config patch` and sets the model from `OPENCLAW_MODEL`, default Sonnet 5.5 through OpenRouter
- Backend: Ed25519 device identity on disk with the v2 signed payload; gateway client with challenge, signed connect, request/response by id, events, reconnect with backoff, pairing retry
- `POST /api/chat`: the reply streams as SSE events (`started`, `status`, `delta`, `done`, `error`); a failure before the run starts is a JSON 502
- Chat service: subscribes to `chat` events before `chat.send`, keeps the events of its session and run, applies `replace`, takes the reply from `final.message`, sends `chat.abort` when the client disconnects
- `GET /healthz` reports whether the gateway is connected
- `npm run dev`, `npm run build`, `npm run smoke` (connect to a real gateway and send one message)
- Frontend: Vue 3 chat page; the text renders as it streams; Stop aborts the request and the run; one gateway session per page load
- `frontend/src/api/stream-chat.ts`: reads the SSE response with `fetch` and a `ReadableStream`; partial events and split characters are buffered until the rest arrives
- Backend tests (identity, signature, gateway client against a fake gateway, chat service, route) and frontend tests (SSE reader)
- Dockerfiles: backend multi-stage build with `dist/` and production dependencies only; frontend Vite build served by nginx, `/api/` proxied unbuffered, backend name resolved per request through Docker's DNS
- Compose services `backend` (identity in a volume, no published port, starts after the gateway is healthy) and `frontend` (page on 127.0.0.1:8080)
- `.env.example`: `OPENCLAW_MODEL`, `FRONTEND_HOST_PORT`, `OPENCLAW_GATEWAY_HOST_PORT`, `OPENCLAW_GATEWAY_URL`, `PORT`, `HOST`
- Dependencies: `fastify` 5.12.7, `ws` 8.22.0, `vue` 3.5.44, `vite` 8.3.5, `@vitejs/plugin-vue` 6.0.10, `vue-tsc` 3.3.13
- Postman collection for the backend in `docs/`

### Changed

- The model is set from `OPENCLAW_MODEL` at start, not in `openclaw.json`: the CLI checks model names before env substitution and rejects a `${VAR}` placeholder
- Chat service: `events.on` from `node:events` replaces the hand-written event queue
- The 502 body of `POST /api/chat` is `{ code, message }`, the same shape as Fastify's validation errors
- Gateway client: `connect()` is called once; the backend passes the Fastify logger straight through
- `npm run smoke` sends its message through the chat service instead of its own event handling
- README and ARCHITECTURE shortened; comments in compose, nginx and env files trimmed

### Removed

- Gateway client options nobody set (`scopes`, `caps`, `clientVersion`, `requestTimeoutMs`), the `hello` getter, the `retryable` field, the unused `AgentEvent` type
- `npm run smoke` flags `--stay` and `--chat`; `npm run preview` in the frontend

### Fixed

- The repo config never reached the gateway after the first start: the image runs `doctor --fix` before the gateway, and doctor restored its last-known-good copy over the plain `cp`. The start script now merges the config through `openclaw config patch`

### Security

- Backend and frontend containers run as non-root, with all capabilities dropped and `no-new-privileges`; the frontend image is `nginxinc/nginx-unprivileged`
- Only two host ports, both on 127.0.0.1: the page on 8080 and the gateway on 18789
