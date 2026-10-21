import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPayloadV2,
  createIdentity,
  deriveDeviceId,
  loadOrCreateIdentity,
  signChallenge,
} from "../src/device-identity.js";

// SPKI DER header for an Ed25519 public key (RFC 8410), followed by the 32 raw bytes.
const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromRaw(base64url: string) {
  const raw = Buffer.from(base64url, "base64url");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_HEADER, raw]), format: "der", type: "spki" });
}

const input = {
  clientId: "gateway-client",
  clientMode: "backend",
  role: "operator",
  scopes: ["operator.read", "operator.write"],
  token: "tok",
  nonce: "nonce-1",
  ts: 1737264000000,
};

test("public key is 32 raw bytes in base64url and deviceId is its sha256", () => {
  const identity = createIdentity();
  assert.equal(Buffer.from(identity.publicKey, "base64url").length, 32);
  assert.ok(!identity.publicKey.includes("="), "base64url has no padding");
  assert.equal(identity.deviceId, deriveDeviceId(identity.publicKey));
  assert.match(identity.deviceId, /^[0-9a-f]{64}$/);
});

test("loadOrCreateIdentity returns the same identity on the second load and writes an owner-only file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "device-identity-")), "identity.json");
  const first = loadOrCreateIdentity(path);
  const second = loadOrCreateIdentity(path);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("v2 payload has the exact field order the gateway rebuilds", () => {
  assert.equal(
    buildPayloadV2("dev-id", input),
    "v2|dev-id|gateway-client|backend|operator|operator.read,operator.write|1737264000000|tok|nonce-1",
  );
});

test("signChallenge produces a signature that verifies against the public key", () => {
  const identity = createIdentity();
  const proof = signChallenge(identity, input);
  assert.equal(proof.id, identity.deviceId);
  assert.equal(proof.publicKey, identity.publicKey);
  assert.equal(proof.signedAt, input.ts);
  assert.equal(proof.nonce, input.nonce);

  const key = publicKeyFromRaw(identity.publicKey);
  const signature = Buffer.from(proof.signature, "base64url");
  assert.equal(verify(null, Buffer.from(buildPayloadV2(identity.deviceId, input)), key, signature), true);

  // Changing any signed field invalidates the signature.
  const tampered = Buffer.from(buildPayloadV2(identity.deviceId, { ...input, token: "other" }));
  assert.equal(verify(null, tampered, key, signature), false);
});
