// Entry point: env, device identity, gateway connection, HTTP server, shutdown.

import Fastify from "fastify";
import { ChatService } from "./chat-service.js";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./device-identity.js";
import { GatewayClient, type PairingRequired } from "./gateway-client.js";
import { chatRoutes } from "./routes/chat.js";

const config = loadConfig();
const identity = loadOrCreateIdentity(config.deviceIdentityPath);

const app = Fastify({
  logger: true,
  bodyLimit: 64 * 1024,
  // Open SSE responses would otherwise keep the process alive at shutdown.
  forceCloseConnections: true,
});

const gateway = new GatewayClient({ url: config.gatewayUrl, token: config.gatewayToken, identity, log: app.log });
gateway.on("pairing-required", ({ requestId }: PairingRequired) => {
  app.log.warn(`approve this backend once: docker compose exec openclaw-gateway node dist/index.js devices approve ${requestId ?? "<requestId>"}`);
});

const chat = new ChatService(gateway, app.log);

app.get("/healthz", async () => ({ ok: true, gateway: gateway.isReady ? "connected" : "disconnected" }));
await app.register(chatRoutes, { chat });
await app.listen({ host: config.host, port: config.port });
app.log.info(`device ${identity.deviceId} connecting to ${config.gatewayUrl}`);

// Not awaited: /healthz answers while pairing is pending; /api/chat answers 502 until connected.
gateway.connect().catch((err: unknown) => {
  app.log.error(`gateway connection failed for good: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  void shutdown("fatal gateway error");
});

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`shutting down: ${reason}`);
  // HTTP first, so chat.abort for interrupted runs still reaches the gateway.
  await app.close();
  gateway.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
