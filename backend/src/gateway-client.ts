// One WebSocket connection to the OpenClaw gateway. Knows frames and the
// handshake, nothing above that:
//   - handshake: wait for connect.challenge, send a signed connect, get hello-ok
//   - request/response: match `res` frames to `req` frames by id
//   - events: re-emit every `event` frame under its event name
//   - reconnect: backoff with jitter; a fixed slow retry while pairing is pending

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { signChallenge, type DeviceIdentity } from "./device-identity.js";
import {
  isRecord,
  PROTOCOL_VERSION,
  type ConnectChallenge,
  type ConnectParams,
  type ErrorShape,
  type Frame,
  type HelloOk,
} from "./protocol.js";

// Values from the protocol schema. "gateway-client" and "backend" are closed enums.
const CLIENT = { id: "gateway-client", mode: "backend", version: "0.1.0" } as const;
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write"];
const REQUEST_TIMEOUT_MS = 30_000;

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

  constructor(shape: ErrorShape) {
    super(shape.message);
    this.name = "GatewayError";
    this.code = shape.code;
    this.details = isRecord(shape.details) ? shape.details : undefined;
  }

  // The specific reason, for example PAIRING_REQUIRED.
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

export const silentLog: Logger = { info() {}, warn() {}, error() {} };

export type GatewayClientOptions = {
  url: string;
  token: string;
  identity: DeviceIdentity;
  log?: Logger;
  handshakeTimeoutMs?: number;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number; pairingRetryMs?: number };
};

export type PairingRequired = { requestId: string | undefined; deviceId: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

type Phase = "idle" | "awaiting-challenge" | "connecting" | "ready";

export class GatewayClient extends EventEmitter {
  private readonly url: string;
  private readonly token: string;
  private readonly identity: DeviceIdentity;
  private readonly log: Logger;
  private readonly handshakeTimeoutMs: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly pairingRetryMs: number;

  private ws: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private phase: Phase = "idle";
  private stopped = true;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffMs: number;
  private nextDelayMs: number | undefined;

  constructor(options: GatewayClientOptions) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.identity = options.identity;
    this.log = options.log ?? silentLog;
    // Same budget as the gateway's own connect deadline.
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
    this.minDelayMs = options.reconnect?.minDelayMs ?? 1_000;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
    this.pairingRetryMs = options.reconnect?.pairingRetryMs ?? 5_000;
    this.backoffMs = this.minDelayMs;
  }

  get isReady(): boolean {
    return this.phase === "ready";
  }

  // Call once. Resolves on the first hello-ok; later drops reconnect on their
  // own. Rejects only on an error a retry cannot fix.
  connect(): Promise<HelloOk> {
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
    this.ws?.close();
    this.ws = undefined;
  }

  // Sends a `req` frame and resolves with the `res` payload. Rejects with a
  // GatewayError when the gateway says no, on timeout, or when the connection drops.
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    const open = ws?.readyState === WebSocket.OPEN && (this.phase === "ready" || method === "connect");
    if (!ws || !open) {
      return Promise.reject(new GatewayError({ code: "NOT_CONNECTED", message: `cannot call ${method}: not connected` }));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError({ code: "REQUEST_TIMEOUT", message: `${method} timed out` }));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  // --- connection lifecycle ---

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
      frame = JSON.parse(raw.toString()) as Frame;
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
        this.log.warn(`expected connect.challenge, got a ${frame.type} frame`);
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

    if (frame.type === "event") this.emit(frame.event, frame.payload);
  }

  private async sendConnect(challenge: ConnectChallenge): Promise<void> {
    // The gateway rebuilds the signed payload from the connect params, so every
    // signed field must match them. signedAt is the challenge ts, not the local clock.
    const device = signChallenge(this.identity, {
      clientId: CLIENT.id,
      clientMode: CLIENT.mode,
      role: ROLE,
      scopes: SCOPES,
      token: this.token,
      nonce: challenge.nonce,
      ts: challenge.ts,
    });
    const params: ConnectParams = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { ...CLIENT, platform: process.platform },
      role: ROLE,
      scopes: SCOPES,
      auth: { token: this.token },
      device,
    };

    try {
      const hello = await this.request<HelloOk>("connect", params, this.handshakeTimeoutMs);
      this.phase = "ready";
      this.clearHandshakeTimer();
      this.backoffMs = this.minDelayMs;
      this.log.info(`gateway ready: server=${hello.server.version} role=${hello.auth.role} scopes=${hello.auth.scopes.join(",")}`);
      this.emit("ready", hello);
    } catch (err) {
      this.onConnectFailed(err);
    }
  }

  private onConnectFailed(err: unknown): void {
    const gatewayError = err instanceof GatewayError ? err : undefined;
    const detailCode = gatewayError?.detailCode;
    const message = err instanceof Error ? err.message : String(err);

    if (detailCode === "PAIRING_REQUIRED") {
      const requestId = gatewayError?.details?.requestId;
      const info: PairingRequired = {
        requestId: typeof requestId === "string" ? requestId : undefined,
        deviceId: this.identity.deviceId,
      };
      // Ids only, never the token or the key.
      this.log.warn(`pairing required: deviceId=${info.deviceId} requestId=${info.requestId ?? "unknown"}; retrying every ${this.pairingRetryMs} ms`);
      this.emit("pairing-required", info);
      this.nextDelayMs = this.pairingRetryMs;
      this.ws?.close();
      return;
    }

    const label = gatewayError ? `${gatewayError.code}${detailCode ? "/" + detailCode : ""}` : "error";
    if (detailCode && FATAL_CONNECT_CODES.has(detailCode)) {
      this.log.error(`gateway refused the connection (${label}): ${message}`);
      this.close();
      this.emit("fatal", gatewayError ?? new Error(message));
      return;
    }
    this.log.warn(`gateway connect failed (${label}): ${message}`);
    this.ws?.close();
  }

  private onClose(code: number, reason: string): void {
    if (this.phase === "ready") this.log.warn(`gateway connection closed: code=${code} reason=${reason || "-"}`);
    this.phase = "idle";
    this.clearHandshakeTimer();
    this.rejectAllPending(new GatewayError({ code: "CONNECTION_CLOSED", message: `gateway connection closed (${code})` }));
    this.emit("disconnected", { code, reason });
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // After PAIRING_REQUIRED: a fixed delay. Otherwise: doubling, with ±20 % jitter
    // so clients restarting together do not retry in lockstep.
    let delay = this.nextDelayMs;
    this.nextDelayMs = undefined;
    if (delay === undefined) {
      delay = this.backoffMs * (0.8 + Math.random() * 0.4);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxDelayMs);
    }
    this.log.info(`reconnecting to the gateway in ${Math.round(delay)} ms`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearHandshakeTimer(): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
