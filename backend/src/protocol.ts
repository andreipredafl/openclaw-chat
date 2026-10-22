// Types for the OpenClaw gateway protocol (wire version 4), limited to what this
// app uses. Copied from the TypeBox schemas in packages/gateway-protocol/src/schema
// (gateway 2026.10.5). Every object there is closed: unknown keys are rejected.

export const PROTOCOL_VERSION = 4;

// --- Frames ---

export type RequestFrame = { type: "req"; id: string; method: string; params?: unknown };

export type ResponseFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: ErrorShape };

export type EventFrame = { type: "event"; event: string; payload?: unknown };

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// The specific reason is details.code, for example PAIRING_REQUIRED.
export type ErrorShape = { code: string; message: string; details?: unknown };

// --- Handshake ---

// First frame after the socket opens. `ts` becomes device.signedAt.
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
    id: "gateway-client"; // closed enum; the value for third-party clients
    version: string;
    platform: string;
    mode: "backend"; // closed enum; "operator" is a role, not a mode
  };
  role: "operator";
  scopes: string[];
  // Client capabilities, for example "tool-events". Not part of the signed payload.
  caps: string[];
  auth: { token: string };
  device: DeviceProof;
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  auth: { role: string; scopes: string[]; deviceToken?: string };
};

// --- Chat ---

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  // Required. A retried send with the same key is not a second run.
  idempotencyKey: string;
};

// chat.send only admits the run; the reply arrives as `chat` events.
export type ChatSendAck = { runId: string; status: string };

// Without runId the gateway stops every run in the session.
export type ChatAbortParams = { sessionKey: string; runId?: string };

export type ChatAbortResult = { ok: boolean; aborted: boolean; runIds: string[] };

type ChatEventBase = { runId: string; sessionKey: string; seq: number };

export type ChatEvent =
  // Progress before the first token, for example "starting_model".
  | (ChatEventBase & { state: "status"; phase: string })
  // With `replace: true`, deltaText is the whole text so far, not an append.
  | (ChatEventBase & { state: "delta"; deltaText: string; replace?: boolean })
  // `message` is the complete assistant message: { role, content: [{ type: "text", text }, ...] }.
  | (ChatEventBase & { state: "final"; stopReason?: string; message?: unknown })
  | (ChatEventBase & { state: "aborted"; stopReason?: string; message?: unknown })
  | (ChatEventBase & { state: "error"; errorMessage?: string; errorKind?: string });

// --- Agent events ---

// What the agent does during a run: tools, lifecycle, plans. The schema has no
// sessionKey here, so filter by runId. `data` is open in the schema; its fields
// depend on `stream`. Tool events reach only the connection that started the run
// with the "tool-events" cap.
export type AgentEvent = {
  runId: string;
  seq: number;
  stream: string; // "tool" | "lifecycle" | "assistant" | ...
  ts: number;
  data: Record<string, unknown>;
};

// `data` of an agent event with stream "tool", as the gateway's runners build it.
export type ToolEventData = {
  phase: string; // "start" | "update" | "result"
  name: string;
  toolCallId: string;
  // Set when the `tool_call` dispatcher ran this tool on the model's behalf.
  parentToolCallId?: string;
  args?: unknown; // on start
  isError?: boolean; // on result
  // On result. Same shape as a message: { content: [{ type: "text", text }, ...] }.
  result?: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
