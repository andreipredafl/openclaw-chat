// One chat.send, one stream of typed events. Knows chat runs, not HTTP.

import { randomUUID } from "node:crypto";
import { GatewayError, type Logger } from "./gateway-client.js";
import type { ChatAbortParams, ChatAbortResult, ChatEvent, ChatSendAck, ChatSendParams } from "./protocol.js";

export type ChatStreamEvent =
  | { type: "started"; runId: string; sessionKey: string }
  | { type: "status"; phase: string }
  // With replace, `text` is the whole reply so far, not an append.
  | { type: "delta"; text: string; replace: boolean }
  // `text` is the full reply.
  | { type: "done"; text: string; stopReason?: string }
  | { type: "error"; code: string; message: string };

export type StreamChatInput = {
  message: string;
  sessionKey: string;
  // Abort when the consumer goes away. The run is then stopped on the gateway too.
  signal?: AbortSignal;
};

// What this module needs from GatewayClient. Tests pass a fake.
export type ChatGateway = {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
};

const silentLog: Logger = { info() {}, warn() {}, error() {} };

export class ChatService {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly log: Logger = silentLog,
  ) {}

  async *streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const { message, sessionKey, signal } = input;
    const inbox = new Inbox<ChatEvent>();

    // Subscribe before sending: the first events can arrive before the ack.
    const onChat = (payload: unknown) => {
      if (isChatEvent(payload) && payload.sessionKey === sessionKey) inbox.push(payload);
    };
    const onDisconnected = () => {
      inbox.fail(new GatewayError({ code: "CONNECTION_CLOSED", message: "gateway connection lost during the run" }));
    };
    this.gateway.on("chat", onChat);
    this.gateway.on("disconnected", onDisconnected);

    let runId: string | undefined;
    let settled = false; // the gateway ended the run, or no run was started
    let text = "";

    try {
      const params: ChatSendParams = { sessionKey, message, idempotencyKey: randomUUID() };
      let ack: ChatSendAck;
      try {
        ack = await this.gateway.request<ChatSendAck>("chat.send", params);
      } catch (err) {
        settled = true;
        yield errorEvent(err);
        return;
      }
      runId = ack.runId;
      yield { type: "started", runId, sessionKey };

      while (true) {
        const event = await inbox.next(signal);
        if (event.runId !== runId) continue;
        switch (event.state) {
          case "status":
            yield { type: "status", phase: event.phase };
            break;
          case "delta":
            // The gateway clears its live text with an empty replace right before final. Skip it.
            if (event.replace && event.deltaText === "") break;
            text = event.replace ? event.deltaText : text + event.deltaText;
            yield { type: "delta", text: event.deltaText, replace: event.replace === true };
            break;
          case "final":
            settled = true;
            yield doneEvent(messageText(event.message) ?? text, event.stopReason);
            return;
          case "aborted":
            settled = true;
            yield doneEvent(messageText(event.message) ?? text, event.stopReason ?? "aborted");
            return;
          case "error":
            settled = true;
            yield { type: "error", code: event.errorKind ?? "unknown", message: event.errorMessage ?? "the run failed" };
            return;
          default:
            break; // unknown state: ignored, not fatal
        }
      }
    } catch (err) {
      if (signal?.aborted) return; // the consumer left; `finally` stops the run
      settled = true;
      yield errorEvent(err);
    } finally {
      this.gateway.off("chat", onChat);
      this.gateway.off("disconnected", onDisconnected);
      if (runId !== undefined && !settled) this.abortRun(sessionKey, runId);
    }
  }

  private abortRun(sessionKey: string, runId: string): void {
    const params: ChatAbortParams = { sessionKey, runId };
    this.gateway.request<ChatAbortResult>("chat.abort", params).then(
      (result) => this.log.info(`chat.abort runId=${runId} aborted=${result.aborted}`),
      (err: unknown) => this.log.warn(`chat.abort runId=${runId} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

// Events pushed by the `chat` listener, pulled one at a time by the generator.
class Inbox<T> {
  private readonly items: T[] = [];
  private waiter: { resolve: (item: T) => void; reject: (err: Error) => void } | undefined;
  private failure: Error | undefined;

  push(item: T): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  // Buffered items are still delivered; the error comes after them.
  fail(err: Error): void {
    this.failure = err;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.reject(err);
    }
  }

  next(signal?: AbortSignal): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined;
        reject(signal?.reason as Error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        resolve: (item) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(item);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
    });
  }
}

function isChatEvent(payload: unknown): payload is ChatEvent {
  return (
    isRecord(payload) &&
    typeof payload.runId === "string" &&
    typeof payload.sessionKey === "string" &&
    typeof payload.state === "string"
  );
}

// Text of an assistant message: { role, content: [{ type: "text", text }, ...] }.
function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function doneEvent(text: string, stopReason: string | undefined): ChatStreamEvent {
  return stopReason === undefined ? { type: "done", text } : { type: "done", text, stopReason };
}

function errorEvent(err: unknown): ChatStreamEvent {
  if (err instanceof GatewayError) {
    const code = err.detailCode ? `${err.code}/${err.detailCode}` : err.code;
    return { type: "error", code, message: err.message };
  }
  return { type: "error", code: "unknown", message: err instanceof Error ? err.message : String(err) };
}
