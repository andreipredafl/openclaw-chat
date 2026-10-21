// Configuration from the environment. Missing values fail at startup, not later.

export type Config = {
  gatewayUrl: string;
  gatewayToken: string;
  deviceIdentityPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is not set. Copy .env.example to .env and fill it in.");
  }
  return {
    // Inside Compose this becomes ws://openclaw-gateway:18789 (set in docker-compose.yml).
    gatewayUrl: env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789",
    gatewayToken,
    // Holds the private key. Git-ignored (data/).
    deviceIdentityPath: env.DEVICE_IDENTITY_PATH ?? "./data/device-identity.json",
  };
}
