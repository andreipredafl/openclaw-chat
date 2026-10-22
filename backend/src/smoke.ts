// Manual check against a real gateway, without HTTP: connect, send one message,
// print every event of the reply. `npm run smoke` reads ../.env.
//
// On the first run the gateway answers PAIRING_REQUIRED. Approve the device once
// (README, "First run"); the client retries on its own.

import { ChatService } from "./chat-service.js";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./device-identity.js";
import { GatewayClient } from "./gateway-client.js";

const config = loadConfig();
const identity = loadOrCreateIdentity(config.deviceIdentityPath);
const client = new GatewayClient({ url: config.gatewayUrl, token: config.gatewayToken, identity, log: console });

console.log(`device ${identity.deviceId} connecting to ${config.gatewayUrl}`);
try {
  await client.connect();
  const chat = new ChatService(client, console);
  const input = { sessionKey: "agent:main:smoke", message: "Reply with the single word: pong" };
  for await (const event of chat.streamChat(input)) console.log(JSON.stringify(event));
} catch (err) {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.close();
}
