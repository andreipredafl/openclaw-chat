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

### Changed

- CLAUDE.md: protocol rule that `chat.send` has no `model` field; the model is set in the gateway config
