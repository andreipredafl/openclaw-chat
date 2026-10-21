// One WebSocket connection to the OpenClaw gateway.
//
// This module knows frames and the handshake, nothing else:
//   - handshake: wait for connect.challenge, send a signed connect, receive hello-ok
//   - request/response: match `res` frames to `req` frames by id
//   - events: re-emit every `event` frame under its event name
//   - reconnect: exponential backoff with jitter; a slow fixed retry while pairing is pending
//
// Layers above only see connect(), request() and events.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { signChallenge, type DeviceIdentity } from "./device-identity.js";
import {
  PROTOCOL_VERSION,
  type ConnectChallenge,
  type ConnectParams,
  type ErrorShape,
  type Frame,
  type HelloOk,
} from "./protocol.js";

// Values from the protocol schema.
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const ROLE = "operator";
const DEFAULT_SCOPES = ["operator.read", "operator.write"];
const DEFAULT_CAPS = ["tool-events"];

// details.code values on a failed connect that a retry cannot fix.
const FATAL_CONNECT_CODES = new Set([
  "PROTOCOL_MISMATCH",
  "AUTH_TOKEN_MISSING",
  "AUTH_TOKEN_MISMATCH",
  "AUTH_TOKEN_NOT_CONFIGURED",
  "AUTH_SCOPE_MISMATCH",
  "PAIRING_REJECTED",
  "DEVICE_IDENTITY_REQUIRED",
  "DEVICE_AUTH_INVALID",
  "DEVICE_AUTH_SIGNATURE_INVALID",
  "DEVICE_AUTH_DEVICE_ID_MISMATCH",
]);

export class GatewayError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean | undefined;

  constructor(shape: ErrorShape) {
    super(shape.message);
    this.name = "GatewayError";
    this.code = shape.code;
    this.details = isRecord(shape.details) ? shape.details : undefined;
    this.retryable = shape.retryable;
  }

  get detailCode(): string | undefined {
    const code = this.details?.code;
    return typeof code === "string" ? code : undefined;
  }
}

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type GatewayClientOptions = {
  url: string;
  token: string;
  identity: DeviceIdentity;
  clientVersion?: string;
  scopes?: string[];
  caps?: string[];
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number; pairingRetryMs?: number };
  log?: Logger;
};

export type PairingRequired = { requestId: string | undefined; deviceId: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Phase = "idle" | "awaiting-challenge" | "connecting" | "ready";

const silentLog: Logger = { info() {}, warn() {}, error() {} };

export class GatewayClient extends EventEmitter {
  private readonly url: string;
  private readonly token: string;
  private readonly identity: DeviceIdentity;
  private readonly clientVersion: string;
  private readonly scopes: string[];
  private readonly caps: string[];
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly pairingRetryMs: number;
  private readonly log: Logger;

  private ws: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private phase: Phase = "idle";
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private backoffMs: number;
  private nextDelayMs: number | undefined;
  private helloOk: HelloOk | undefined;

  constructor(options: GatewayClientOptions) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.identity = options.identity;
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.scopes = options.scopes ?? DEFAULT_SCOPES;
    this.caps = options.caps ?? DEFAULT_CAPS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    // Same budget as the gateway's connect deadline: a total, not an idle timeout.
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
    this.minDelayMs = options.reconnect?.minDelayMs ?? 1_000;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
    this.pairingRetryMs = options.reconnect?.pairingRetryMs ?? 5_000;
    this.log = options.log ?? silentLog;
    this.backoffMs = this.minDelayMs;
  }

  get hello(): HelloOk | undefined {
    return this.helloOk;
  }

  get isReady(): boolean {
    return this.phase === "ready";
  }

  // Opens the connection and resolves on the first hello-ok. Later drops
  // reconnect on their own. Rejects only on an error a retry cannot fix.
  connect(): Promise<HelloOk> {
    if (!this.stopped) {
      return this.helloOk ? Promise.resolve(this.helloOk) : this.nextReady();
    }
    this.stopped = false;
    const ready = this.nextReady();
    this.open();
    return ready;
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.rejectAllPending(new GatewayError({ code: "CLIENT_CLOSED", message: "gateway client closed" }));
    this.phase = "idle";
    this.helloOk = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  // Sends a `req` frame and resolves with the `res` payload. Rejects with a
  // GatewayError when the gateway says no, on timeout, or when the connection drops.
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (method !== "connect" && this.phase !== "ready") {
      return Promise.reject(new GatewayError({ code: "NOT_CONNECTED", message: `cannot call ${method}: not connected` }));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayError({ code: "NOT_CONNECTED", message: `cannot call ${method}: socket not open` }));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError({ code: "REQUEST_TIMEOUT", message: `${method} timed out` }));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  // --- connection lifecycle -----------------------------------------------

  private nextReady(): Promise<HelloOk> {
    return new Promise((resolve, reject) => {
      const onReady = (hello: HelloOk) => {
        this.off("fatal", onFatal);
        resolve(hello);
      };
      const onFatal = (err: Error) => {
        this.off("ready", onReady);
        reject(err);
      };
      this.once("ready", onReady);
      this.once("fatal", onFatal);
    });
  }

  private open(): void {
    this.phase = "awaiting-challenge";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("message", (raw) => this.onMessage(raw));
    ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
    ws.on("error", (err) => this.log.warn(`gateway socket error: ${err.message}`));

    this.handshakeTimer = setTimeout(() => {
      if (this.phase !== "ready") {
        this.log.warn("gateway handshake timed out");
        ws.terminate();
      }
    }, this.handshakeTimeoutMs);
  }

  private onMessage(raw: RawData): void {
    let frame: Frame;
    try {
      frame = JSON.parse(rawToString(raw)) as Frame;
    } catch {
      this.log.warn("ignoring a non-JSON frame from the gateway");
      return;
    }

    // Nothing is sent before the challenge arrives.
    if (this.phase === "awaiting-challenge") {
      if (frame.type === "event" && frame.event === "connect.challenge") {
        this.phase = "connecting";
        void this.sendConnect(frame.payload as ConnectChallenge);
      } else {
        this.log.warn(`expected connect.challenge, got ${describe(frame)}`);
      }
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return; // late reply after a timeout
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new GatewayError(frame.error ?? { code: "UNKNOWN", message: "request failed" }));
      return;
    }

    if (frame.type === "event") {
      this.emit(frame.event, frame.payload);
    }
  }

  private async sendConnect(challenge: ConnectChallenge): Promise<void> {
    const device = signChallenge(this.identity, {
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: this.scopes,
      token: this.token,
      nonce: challenge.nonce,
      ts: challenge.ts, // signedAt is the challenge ts, not the local clock
    });
    // Every signed field below must equal its counterpart in the payload.
    const params: ConnectParams = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: CLIENT_ID, version: this.clientVersion, platform: process.platform, mode: CLIENT_MODE },
      role: ROLE,
      scopes: this.scopes,
      caps: this.caps,
      auth: { token: this.token },
      locale: "en-US",
      userAgent: `openclaw-chat-backend/${this.clientVersion}`,
      device,
    };

    try {
      const hello = await this.request<HelloOk>("connect", params, this.handshakeTimeoutMs);
      this.helloOk = hello;
      this.phase = "ready";
      this.clearHandshakeTimer();
      this.backoffMs = this.minDelayMs;
      this.log.info(
        `gateway ready: server=${hello.server.version} role=${hello.auth.role} scopes=${hello.auth.scopes.join(",")}`,
      );
      this.emit("ready", hello);
    } catch (err) {
      this.onConnectFailed(err);
    }
  }

  private onConnectFailed(err: unknown): void {
    const gatewayError = err instanceof GatewayError ? err : undefined;
    const detailCode = gatewayError?.detailCode;

    if (detailCode === "PAIRING_REQUIRED") {
      const requestId = typeof gatewayError?.details?.requestId === "string" ? gatewayError.details.requestId : undefined;
      const info: PairingRequired = { requestId, deviceId: this.identity.deviceId };
      // Only the ids are logged, never the token or the key.
      this.log.warn(`pairing required: deviceId=${info.deviceId} requestId=${requestId ?? "unknown"}; retrying every ${this.pairingRetryMs} ms`);
      this.emit("pairing-required", info);
      this.nextDelayMs = this.pairingRetryMs;
      this.ws?.close();
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const label = gatewayError ? `${gatewayError.code}${detailCode ? "/" + detailCode : ""}` : "error";
    if (detailCode && FATAL_CONNECT_CODES.has(detailCode)) {
      this.log.error(`gateway refused the connection (${label}): ${message}`);
      const fatal = gatewayError ?? new Error(message);
      this.close();
      this.emit("fatal", fatal);
      return;
    }
    this.log.warn(`gateway connect failed (${label}): ${message}`);
    this.ws?.close();
  }

  private onClose(code: number, reason: string): void {
    const wasReady = this.phase === "ready";
    this.phase = "idle";
    this.helloOk = undefined;
    this.clearHandshakeTimer();
    this.rejectAllPending(new GatewayError({ code: "CONNECTION_CLOSED", message: `gateway connection closed (${code})` }));
    if (wasReady) this.log.warn(`gateway connection closed: code=${code} reason=${reason || "-"}`);
    this.emit("disconnected", { code, reason });
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    let delay: number;
    if (this.nextDelayMs !== undefined) {
      delay = this.nextDelayMs;
      this.nextDelayMs = undefined;
    } else {
      delay = withJitter(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxDelayMs);
    }
    this.log.info(`reconnecting to the gateway in ${Math.round(delay)} ms`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

// Spread retries over ±20 % so clients restarting together do not retry in lockstep.
function withJitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawToString(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function describe(frame: Frame): string {
  if (frame.type === "event") return `event ${frame.event}`;
  if (frame.type === "res") return `res ${frame.id}`;
  return `req ${frame.method}`;
}
