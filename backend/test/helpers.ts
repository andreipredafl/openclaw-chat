import { createPublicKey, type KeyObject } from "node:crypto";

// SPKI DER header for an Ed25519 public key (RFC 8410), followed by the 32 raw bytes.
const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

// What the gateway does with the key we send: raw base64url bytes back to a key object.
export function publicKeyFromRaw(base64url: string): KeyObject {
  const raw = Buffer.from(base64url, "base64url");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_HEADER, raw]), format: "der", type: "spki" });
}
