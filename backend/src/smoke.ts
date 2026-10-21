// Manual check against a real gateway. No HTTP involved.
//
//   npm run smoke             connect, print hello-ok, list sessions, exit
//   npm run smoke -- --stay   same, then stay connected and log reconnects
//   npm run smoke -- --chat   same, then send one message and print the stream
//
// On the first run the gateway answers PAIRING_REQUIRED. Approve the device once:
//   docker compose exec openclaw-gateway node dist/index.js devices approve <requestId>
// The client keeps retrying every 5 s until the approval lands.

import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./device-identity.js";
import { GatewayClient } from "./gateway-client.js";
import type { ChatEvent, ChatSendAck } from "./protocol.js";

const config = loadConfig();
const identity = loadOrCreateIdentity(config.deviceIdentityPath);
const stay = process.argv.includes("--stay");
const chat = process.argv.includes("--chat");

console.log(`device   ${identity.deviceId}`);
console.log(`gateway  ${config.gatewayUrl}`);

const client = new GatewayClient({
  url: config.gatewayUrl,
  token: config.gatewayToken,
  identity,
  log: {
    info: (m) => console.log(`[info]  ${m}`),
    warn: (m) => console.log(`[warn]  ${m}`),
    error: (m) => console.log(`[error] ${m}`),
  },
});

client.on("pairing-required", ({ requestId }) => {
  console.log("");
  console.log("Pairing required. Approve this device once, then wait for the retry:");
  console.log(`  docker compose exec openclaw-gateway node dist/index.js devices approve ${requestId ?? "<requestId from 'devices list'>"}`);
  console.log("");
});

try {
  const hello = await client.connect();
  console.log(`hello-ok protocol=${hello.protocol} server=${hello.server.version} connId=${hello.server.connId}`);
  console.log(`auth     role=${hello.auth.role} scopes=${hello.auth.scopes.join(",")} deviceToken=${hello.auth.deviceToken ? "issued" : "none"}`);
  console.log(`policy   maxPayload=${hello.policy.maxPayload} tick=${hello.policy.tickIntervalMs}ms`);

  const result = await client.request<{ sessions?: unknown[] }>("sessions.list", { limit: 5 });
  console.log(`sessions.list -> ${result.sessions?.length ?? 0} session(s)`);

  if (chat) await chatOnce();

  if (stay) {
    console.log("staying connected; restart the gateway to watch the reconnect (Ctrl+C to quit)");
    client.on("ready", (h) => console.log(`[ready] reconnected, connId=${h.server.connId}`));
    process.on("SIGINT", () => {
      client.close();
      process.exit(0);
    });
  } else {
    client.close();
  }
} catch (err) {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  client.close();
  process.exit(1);
}

async function chatOnce(): Promise<void> {
  const sessionKey = "agent:main:smoke";
  await new Promise<void>((resolve, reject) => {
    let runId: string | undefined;
    const onChat = (event: ChatEvent) => {
      if (event.sessionKey !== sessionKey) return;
      if (runId && event.runId !== runId) return;
      switch (event.state) {
        case "status":
          console.log(`[status] ${event.phase}`);
          break;
        case "delta":
          process.stdout.write(event.replace ? `\r${event.deltaText}` : event.deltaText);
          break;
        case "final":
          console.log("\n[final]");
          client.off("chat", onChat);
          resolve();
          break;
        case "error":
          client.off("chat", onChat);
          reject(new Error(`chat error (${event.errorKind ?? "unknown"}): ${event.errorMessage ?? "-"}`));
          break;
        case "aborted":
          client.off("chat", onChat);
          reject(new Error("run aborted"));
          break;
      }
    };
    client.on("chat", onChat);
    client
      .request<ChatSendAck>("chat.send", { sessionKey, message: "Reply with the single word: pong", idempotencyKey: randomUUID() })
      .then((ack) => {
        runId = ack.runId;
        console.log(`chat.send -> runId=${ack.runId} status=${ack.status}`);
      })
      .catch(reject);
  });
}
