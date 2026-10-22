// Drives GatewayClient against a small fake gateway that speaks just enough of
// the protocol: the challenge, connect with real signature verification, one
// RPC method, one pushed event, and the connect errors we handle.

import assert from "node:assert/strict";
import { randomUUID, verify } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { buildPayloadV2, createIdentity } from "../src/device-identity.js";
import { GatewayClient, GatewayError } from "../src/gateway-client.js";
import type { ConnectParams, HelloOk } from "../src/protocol.js";
import { publicKeyFromRaw } from "./helpers.js";

const TOKEN = "test-token";

// The same check the real gateway does: rebuild the payload from the connect
// params and verify the signature with the public key from the same params.
function signatureIsValid(params: ConnectParams): boolean {
  const payload = buildPayloadV2(params.device.id, {
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    token: params.auth.token,
    nonce: params.device.nonce,
    ts: params.device.signedAt,
  });
  const key = publicKeyFromRaw(params.device.publicKey);
  return verify(null, Buffer.from(payload), key, Buffer.from(params.device.signature, "base64url"));
}

function helloOk(scopes: string[]): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: randomUUID() },
    auth: { role: "operator", scopes },
  };
}

type Decision = { ok: true } | { ok: false; code: string; detailCode: string; requestId?: string };

// `decisions[i]` answers the i-th connect attempt; the last one repeats.
async function startFakeGateway(decisions: Decision[]) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const sockets = new Set<WebSocket>();
  let attempts = 0;

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const nonce = randomUUID();
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } }));

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "req") return;
      const reply = (body: object) => socket.send(JSON.stringify({ type: "res", id: frame.id, ...body }));

      if (frame.method === "connect") {
        const params = frame.params as ConnectParams;
        const decision = decisions[Math.min(attempts, decisions.length - 1)]!;
        attempts += 1;
        if (params.device.nonce !== nonce || !signatureIsValid(params)) {
          reply({ ok: false, error: { code: "UNAUTHORIZED", message: "bad signature", details: { code: "DEVICE_AUTH_SIGNATURE_INVALID" } } });
          socket.close();
          return;
        }
        if (!decision.ok) {
          reply({ ok: false, error: { code: decision.code, message: decision.detailCode, details: { code: decision.detailCode, requestId: decision.requestId } } });
          socket.close();
          return;
        }
        reply({ ok: true, payload: helloOk(params.scopes) });
        return;
      }

      if (frame.method === "sessions.list") {
        reply({ ok: true, payload: { sessions: [{ key: "agent:main:main" }] } });
        return;
      }

      reply({ ok: false, error: { code: "INVALID_REQUEST", message: `unknown method ${frame.method}` } });
    });
  });

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    get attempts() {
      return attempts;
    },
    push(frame: unknown) {
      for (const s of sockets) s.send(JSON.stringify(frame));
    },
    dropAll() {
      for (const s of sockets) s.terminate();
    },
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function makeClient(url: string) {
  return new GatewayClient({
    url,
    token: TOKEN,
    identity: createIdentity(),
    reconnect: { minDelayMs: 20, maxDelayMs: 50, pairingRetryMs: 20 },
    handshakeTimeoutMs: 2_000,
  });
}

test("handshake succeeds, requests resolve, events are re-emitted", async () => {
  const gateway = await startFakeGateway([{ ok: true }]);
  const client = makeClient(gateway.url);
  try {
    const hello = await client.connect();
    assert.deepEqual(hello.auth.scopes, ["operator.read", "operator.write"]);
    assert.equal(client.isReady, true);

    const result = await client.request<{ sessions: unknown[] }>("sessions.list", { limit: 5 });
    assert.equal(result.sessions.length, 1);

    const chatEvent = once(client, "chat");
    gateway.push({ type: "event", event: "chat", payload: { runId: "r1", sessionKey: "agent:main:main", seq: 0, state: "delta", deltaText: "hi" } });
    const [payload] = await chatEvent;
    assert.equal((payload as { deltaText: string }).deltaText, "hi");
  } finally {
    client.close();
    await gateway.close();
  }
});

test("a gateway error rejects the request with its code and details.code", async () => {
  const gateway = await startFakeGateway([{ ok: true }]);
  const client = makeClient(gateway.url);
  try {
    await client.connect();
    await assert.rejects(client.request("no.such.method"), (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.code, "INVALID_REQUEST");
      return true;
    });
  } finally {
    client.close();
    await gateway.close();
  }
});

test("pairing required: emits the requestId, retries, then connects once approved", async () => {
  const gateway = await startFakeGateway([
    { ok: false, code: "NOT_PAIRED", detailCode: "PAIRING_REQUIRED", requestId: "req-123" },
    { ok: true },
  ]);
  const client = makeClient(gateway.url);
  try {
    const pairing = once(client, "pairing-required");
    const ready = client.connect();
    const [info] = await pairing;
    assert.equal((info as { requestId: string }).requestId, "req-123");
    await ready;
    assert.equal(gateway.attempts, 2);
  } finally {
    client.close();
    await gateway.close();
  }
});

test("a fatal connect error rejects connect() and stops retrying", async () => {
  const gateway = await startFakeGateway([{ ok: false, code: "UNAUTHORIZED", detailCode: "AUTH_TOKEN_MISMATCH" }]);
  const client = makeClient(gateway.url);
  try {
    await assert.rejects(client.connect(), (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.detailCode, "AUTH_TOKEN_MISMATCH");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(gateway.attempts, 1);
    assert.equal(client.isReady, false);
  } finally {
    client.close();
    await gateway.close();
  }
});

test("reconnects on its own after the connection drops and rejects in-flight requests", async () => {
  const gateway = await startFakeGateway([{ ok: true }]);
  const client = makeClient(gateway.url);
  try {
    await client.connect();
    const readyAgain = once(client, "ready");
    const inflight = client.request("sessions.list");
    gateway.dropAll();
    await assert.rejects(inflight, (err: unknown) => err instanceof GatewayError && err.code === "CONNECTION_CLOSED");
    await readyAgain;
    assert.equal(gateway.attempts, 2);
    assert.equal(client.isReady, true);
  } finally {
    client.close();
    await gateway.close();
  }
});

test("request() before the handshake is rejected instead of hanging", async () => {
  const client = makeClient("ws://127.0.0.1:1");
  await assert.rejects(client.request("sessions.list"), (err: unknown) => err instanceof GatewayError && err.code === "NOT_CONNECTED");
});
