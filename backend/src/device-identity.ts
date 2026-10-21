// Device identity for the gateway handshake.
//
// The gateway identifies a client by an Ed25519 key pair, on top of the shared
// token. On every connect it sends a challenge (nonce + ts). We sign a payload
// that binds the challenge to the exact connect params, and the gateway checks
// the signature against the public key and that `id` is that key's fingerprint.
//
// Formats, from the gateway source (2026.10.5):
//   packages/gateway-client/src/device-auth.ts   payload field order (v2)
//   src/infra/device-identity.ts                 deviceId = sha256(raw public key) as hex
//   src/infra/ed25519-signature.ts               raw 32-byte key, base64url, no padding

import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceProof } from "./protocol.js";

export type DeviceIdentity = {
  deviceId: string; // sha256 hex of the raw public key
  publicKey: string; // raw 32 bytes, base64url without padding
  privateKeyPem: string; // PKCS#8 PEM. Never logged, never sent.
};

// SPKI DER for an Ed25519 public key is a fixed 12-byte header plus the 32 raw bytes.
const ED25519_SPKI_HEADER_BYTES = 12;

export function createIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64Url = spki.subarray(ED25519_SPKI_HEADER_BYTES).toString("base64url");
  return {
    deviceId: deriveDeviceId(publicKeyBase64Url),
    publicKey: publicKeyBase64Url,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function deriveDeviceId(publicKeyBase64Url: string): string {
  const raw = Buffer.from(publicKeyBase64Url, "base64url");
  return createHash("sha256").update(raw).digest("hex");
}

// A new key pair is a new device and needs pairing again, so the identity is
// created once and reused from disk.
export function loadOrCreateIdentity(path: string): DeviceIdentity {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceIdentity>;
    if (!parsed.deviceId || !parsed.publicKey || !parsed.privateKeyPem) {
      throw new Error(`Device identity file is incomplete: ${path}`);
    }
    if (deriveDeviceId(parsed.publicKey) !== parsed.deviceId) {
      throw new Error(`Device identity file is corrupt, id does not match key: ${path}`);
    }
    return parsed as DeviceIdentity;
  }
  const identity = createIdentity();
  mkdirSync(dirname(path), { recursive: true });
  // Owner-only, the file holds the private key.
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  return identity;
}

export type ChallengeInput = {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  nonce: string;
  ts: number;
};

// Payload version 2. The gateway rebuilds this string from the connect params
// and verifies the signature against it, so every field must equal what is
// sent. Any difference fails with DEVICE_AUTH_SIGNATURE_INVALID.
export function buildPayloadV2(deviceId: string, input: ChallengeInput): string {
  return [
    "v2",
    deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    input.scopes.join(","),
    String(input.ts),
    input.token,
    input.nonce,
  ].join("|");
}

export function signChallenge(identity: DeviceIdentity, input: ChallengeInput): DeviceProof {
  const payload = Buffer.from(buildPayloadV2(identity.deviceId, input), "utf8");
  const signature = sign(null, payload, createPrivateKey(identity.privateKeyPem));
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: signature.toString("base64url"),
    signedAt: input.ts,
    nonce: input.nonce,
  };
}
