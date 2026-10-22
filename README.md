# openclaw-chat

A chat page for an OpenClaw gateway. The reply shows up as the model writes it.

Three containers, one command:

- `openclaw-gateway`: the OpenClaw gateway, pinned image, talks to OpenRouter.
- `backend`: Node 22 + Fastify. Speaks the gateway WebSocket protocol and exposes `POST /api/chat` as a server-sent events (SSE) stream.
- `frontend`: nginx serving a Vue 3 page and proxying `/api` to the backend.

The browser talks to nginx on http://localhost:8080 and nothing else. Design and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

- Docker with Compose v2. Tested with Docker 28.1 and Compose 2.35 on macOS.
- An OpenRouter API key: https://openrouter.ai/keys.
- About 3.5 GB of disk for the gateway image.
- Node 22, only to run the backend or frontend outside Docker.

## Setup

```bash
cp .env.example .env
```

Fill in `.env`:

- `OPENCLAW_GATEWAY_TOKEN`: shared secret between gateway and backend. Generate one with `openssl rand -hex 32`.
- `OPENROUTER_API_KEY`: your key. Only the gateway container receives it.
- `OPENCLAW_MODEL`: optional. The default, `openrouter/anthropic/claude-sonnet-5.5`, needs credits on the OpenRouter account and answers with HTTP 402 without them. A free model needs no credits: `openrouter/minimax/minimax-m3.1-flash:free`.

## Run

```bash
docker compose up --build
```

Open http://localhost:8080. The first start pulls the gateway image and builds the other two containers.

## First run: approve the backend once

The gateway accepts only devices it knows. The backend creates an Ed25519 key pair at its first start, the gateway answers `PAIRING_REQUIRED`, and the backend retries every 5 seconds while logging:

```text
backend-1  | pairing required: deviceId=39c2…439b requestId=5d02e02a-…; retrying every 5000 ms
backend-1  | approve this backend once: docker compose exec openclaw-gateway node dist/index.js devices approve 5d02e02a-…
```

Run the command from the second line in another terminal. Within 5 seconds the backend logs `gateway ready`. A message sent before that comes back as `NOT_CONNECTED`; send it again.

The approval lives in the gateway volume and the key pair in the backend volume, so restarts and rebuilds keep both. Only `docker compose down -v` removes them.

## Usage

- Enter sends, Shift+Enter adds a line. Stop aborts the run on the gateway and keeps the text received so far.
- One gateway session per page load, shown in the header. The model remembers the messages of that page load. A refresh starts a new session.

Without the page:

```bash
curl -N -X POST localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"message":"Count from 1 to 10, one number per line"}'
```

Events: `started`, `status` (the gateway's phase, shown in the bubble until the first text), `delta` (one every few tokens), then `done` or `error`.

## Local development

Gateway in Docker, backend and frontend on the host with hot reload:

```bash
docker compose up openclaw-gateway       # 127.0.0.1:18789
cd backend && npm ci && npm run dev      # 127.0.0.1:3000, reads ../.env
cd frontend && npm ci && npm run dev     # 127.0.0.1:5173, proxies /api to :3000
```

The host backend is a second device with its own key pair in `backend/data/`. Approve it once, the same way.

```bash
cd backend && npm test && npm run typecheck
cd frontend && npm test && npm run build
cd backend && npm run smoke              # connect to the gateway and send one message, no HTTP
```

A Postman collection for the backend is in `docs/`.

## Troubleshooting

- `set OPENCLAW_GATEWAY_TOKEN in .env` from any `docker compose` command: `.env` is missing or the value is empty.
- `port is already allocated`: set `OPENCLAW_GATEWAY_HOST_PORT` or `FRONTEND_HOST_PORT` in `.env`.
- The reply is `NOT_CONNECTED`: the backend is not paired yet, or the gateway is restarting. `docker compose logs backend` says which.
- The reply is a `402`: no credits on the OpenRouter account. Switch to a free model, then `docker compose up -d`.
- The reply is a `429`: the free model's rate limit. Wait a minute.
- The reply shows up all at once: the gateway holds the text until the end when the model's stream contains reasoning ([openclaw#144765](https://github.com/openclaw/openclaw/issues/144765)). `openclaw/openclaw.json` sets `agents.defaults.thinkingDefault` to `off` for that reason. A model that reasons no matter what, such as `thinkingmachines/inkling`, still arrives in one piece.
- `devices approve` says the request is unknown: that id expired. The backend logs the current one on every retry.
