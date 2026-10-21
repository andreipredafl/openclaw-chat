// Types for the OpenClaw gateway protocol (wire version 4), limited to what
// this app uses. Shapes are copied from the TypeBox schemas in
// packages/gateway-protocol/src/schema (gateway 2026.10.5). The schema is the
// source of truth; every object there is closed, so unknown keys are rejected.

export const PROTOCOL_VERSION = 4;

// --- Frames ---------------------------------------------------------------

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// The specific reason lives in details.code (for example PAIRING_REQUIRED).
export type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

// --- Handshake ------------------------------------------------------------

// First frame from the gateway after the socket opens. `ts` becomes device.signedAt.
export type ConnectChallenge = { nonce: string; ts: number };

// Proof that we hold the private key behind `id`. Sent as connect.params.device.
export type DeviceProof = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    // Closed enum. "gateway-client" is the value for third-party clients.
    id: "gateway-client";
    version: string;
    platform: string;
    // Closed enum. "operator" is a role, not a mode.
    mode: "backend";
  };
  role: "operator";
  scopes: string[];
  caps?: string[];
  auth: { token: string };
  locale?: string;
  userAgent?: string;
  device: DeviceProof;
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[]; capabilities?: string[] };
  snapshot: Record<string, unknown>;
  auth: { method?: string; role: string; scopes: string[]; deviceToken?: string };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
    attachments?: { maxBytes: number; maxImageBytes: number };
  };
};

// --- Chat -----------------------------------------------------------------

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  // Required by the schema. A retried send with the same key is not a second run.
  idempotencyKey: string;
  thinking?: string;
  timeoutMs?: number;
};

// chat.send only admits the run; the reply arrives as `chat` events.
// status is "accepted" for a new run, "in_flight" for a duplicate idempotencyKey.
export type ChatSendAck = { runId: string; status: string };

type ChatEventBase = { runId: string; sessionKey: string; agentId?: string; seq: number };

export type ChatEvent =
  // Progress before the first token, e.g. "starting_model".
  | (ChatEventBase & { state: "status"; phase: string })
  // Streamed text. With `replace: true`, deltaText is the whole text so far, not an append.
  | (ChatEventBase & { state: "delta"; deltaText: string; replace?: boolean })
  | (ChatEventBase & { state: "final"; stopReason?: string })
  | (ChatEventBase & { state: "aborted"; errorMessage?: string; stopReason?: string })
  | (ChatEventBase & {
      state: "error";
      errorMessage?: string;
      errorKind?: "refusal" | "timeout" | "rate_limit" | "context_length" | "state_contention" | "unknown";
    });

// Agent events carry no sessionKey. Filter them by runId.
export type AgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
};
