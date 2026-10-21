// Configuration from the environment. Missing values fail at startup, not later.

export type Config = {
  gatewayUrl: string;
  gatewayToken: string;
  deviceIdentityPath: string;
  host: string;
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is not set. Copy .env.example to .env and fill it in.");
  }
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  }
  return {
    // Inside Compose this becomes ws://openclaw-gateway:18789 (set in docker-compose.yml).
    gatewayUrl: env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789",
    gatewayToken,
    // Holds the private key. Git-ignored (data/).
    deviceIdentityPath: env.DEVICE_IDENTITY_PATH ?? "./data/device-identity.json",
    // Loopback by default. Compose sets 0.0.0.0 so nginx can reach the backend.
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}
