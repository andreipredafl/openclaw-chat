# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project skeleton: folder layout, empty Compose file, env example, README, this changelog, engineering rules in CLAUDE.md
- OpenClaw gateway service in Compose: pinned image 2026.10.5, token auth, healthcheck, persistent state volume, port published on 127.0.0.1 only
- Gateway config in `openclaw/openclaw.json`, copied into the state volume at start because the image entrypoint rewrites the file
- `.env.example`: optional `OPENCLAW_GATEWAY_HOST_PORT`, and a note that the OpenRouter account needs credits
- Backend package: TypeScript, `ws`, `node:test` through `tsx`; no HTTP server yet
- Ed25519 device identity stored on disk, with the v2 signed payload for the connect handshake
- Gateway client: challenge, signed connect, hello-ok, request/response by id, events, reconnect with backoff, pairing retry
- `npm run smoke`: connect to a real gateway, list sessions, optionally send one message or stay connected
- `.env.example`: optional `OPENCLAW_GATEWAY_URL` for running the backend outside Docker
- `POST /api/chat`: the reply streams as SSE events (`started`, `status`, `delta`, `done`, `error`); a failure before the run starts is a JSON 502
- Chat service: subscribes to `chat` events before `chat.send`, keeps the events of its session and run, applies `replace`, takes the reply text from `final.message`, sends `chat.abort` when the client disconnects
- `GET /healthz` reports whether the gateway is connected
- `npm run dev`: runs the backend against the gateway on 127.0.0.1:18789 and restarts on file changes
- `openclaw/start.sh`: container start script; `OPENCLAW_MODEL` picks the model, default Sonnet 5.5 through OpenRouter
- `.env.example`: optional `OPENCLAW_MODEL`, `PORT`, `HOST`
- Dependency `fastify` 5.12.7: HTTP server, JSON schema validation of the request body, request logging
- Postman collection for the backend endpoints in `docs/`, with checks on each request

### Changed

- CLAUDE.md: protocol rule that `chat.send` has no `model` field; the model is set in the gateway config
- The model is no longer in `openclaw/openclaw.json`. The start script sets it from `OPENCLAW_MODEL` with `openclaw config set`, because the CLI checks model names before env substitution and rejects a `${VAR}` placeholder there

### Fixed

- The repo config never reached the gateway after the first start. The image runs `doctor --fix` before the gateway, and doctor restored its own last-known-good copy over the plain `cp` every time. The start script now merges the repo config with `openclaw config patch`, the validated write path
