// One chat.send, one stream of typed events. Knows chat runs, not HTTP.

import { randomUUID } from "node:crypto";
import { on, type EventEmitter } from "node:events";
import { GatewayError, silentLog, type GatewayClient, type Logger } from "./gateway-client.js";
import {
  isRecord,
  type AgentEvent,
  type ChatAbortParams,
  type ChatAbortResult,
  type ChatEvent,
  type ChatSendAck,
  type ChatSendParams,
  type ToolEventData,
} from "./protocol.js";

export type ChatStreamEvent =
  | { type: "started"; runId: string; sessionKey: string }
  | { type: "status"; phase: string }
  // With replace, `text` is the whole reply so far, not an append.
  | { type: "delta"; text: string; replace: boolean }
  // One tool call of the run. The same toolCallId comes twice: "running" with the
  // arguments, then "completed" or "error" with the output.
  | { type: "tool"; toolCallId: string; name: string; status: "running" | "completed" | "error"; args?: unknown; output?: string }
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
export type ChatGateway = EventEmitter & Pick<GatewayClient, "request">;

export class ChatService {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly log: Logger = silentLog,
  ) {}

  async *streamChat({ message, sessionKey, signal }: StreamChatInput): AsyncGenerator<ChatStreamEvent, void, undefined> {
    // Subscribe before chat.send: the first events can arrive before the ack. "event"
    // carries every gateway event as (name, payload), so `chat` and `agent` stay in
    // order. The iterator buffers, ends on "disconnected" and throws when the signal aborts.
    const events = on(this.gateway, "event", { signal, close: ["disconnected"] });
    let runId: string | undefined;
    let settled = false; // the gateway ended the run, or no run was started
    let text = "";

    try {
      const params: ChatSendParams = { sessionKey, message, idempotencyKey: randomUUID() };
      const ack = await this.gateway.request<ChatSendAck>("chat.send", params);
      runId = ack.runId;
      yield { type: "started", runId, sessionKey };

      for await (const args of events) {
        const [name, payload] = args as [unknown, unknown];
        if (name === "agent") {
          const tool = toolEvent(payload, runId);
          if (tool) yield tool;
          continue;
        }
        if (name !== "chat" || !isChatEvent(payload) || payload.sessionKey !== sessionKey || payload.runId !== runId) continue;
        switch (payload.state) {
          case "status":
            yield { type: "status", phase: payload.phase };
            break;
          case "delta":
            // Right before final the gateway clears its live text with an empty replace. Skip it.
            if (payload.replace && payload.deltaText === "") break;
            text = payload.replace ? payload.deltaText : text + payload.deltaText;
            yield { type: "delta", text: payload.deltaText, replace: payload.replace === true };
            break;
          case "final":
            settled = true;
            yield doneEvent(messageText(payload.message) ?? text, payload.stopReason);
            return;
          case "aborted":
            settled = true;
            yield doneEvent(messageText(payload.message) ?? text, payload.stopReason ?? "aborted");
            return;
          case "error":
            settled = true;
            yield { type: "error", code: payload.errorKind ?? "unknown", message: payload.errorMessage ?? "the run failed" };
            return;
          default:
            break; // unknown state: ignored, not fatal
        }
      }
      // The iterator only ends when the gateway connection drops.
      settled = true;
      yield { type: "error", code: "CONNECTION_CLOSED", message: "gateway connection lost during the run" };
    } catch (err) {
      if (signal?.aborted) return; // the consumer left; `finally` stops the run
      settled = true;
      yield errorEvent(err);
    } finally {
      // Removes the listeners when the loop above never ran or was left early.
      await events.return?.();
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

function isChatEvent(payload: unknown): payload is ChatEvent {
  return (
    isRecord(payload) &&
    typeof payload.runId === "string" &&
    typeof payload.sessionKey === "string" &&
    typeof payload.state === "string"
  );
}

function isAgentEvent(payload: unknown): payload is AgentEvent {
  return isRecord(payload) && typeof payload.runId === "string" && typeof payload.stream === "string" && isRecord(payload.data);
}

function isToolEventData(data: Record<string, unknown>): data is Record<string, unknown> & ToolEventData {
  return typeof data.phase === "string" && typeof data.name === "string" && typeof data.toolCallId === "string";
}

// A tool event of this run as a stream event, or undefined. Only "start" and "result"
// change the card. "update" carries partial output and is skipped to keep the stream small.
function toolEvent(payload: unknown, runId: string): ChatStreamEvent | undefined {
  if (!isAgentEvent(payload) || payload.runId !== runId || payload.stream !== "tool" || !isToolEventData(payload.data)) return undefined;
  const { phase, name, toolCallId, args, isError, result } = payload.data;
  // The gateway loads tools on demand: the model finds one with `tool_search`, then
  // calls it by id through the `tool_call` dispatcher. The tool itself follows as its
  // own event with parentToolCallId, so a card for the dispatcher would only repeat it.
  if (name === "tool_call") return undefined;
  if (phase === "start") {
    return args === undefined ? { type: "tool", toolCallId, name, status: "running" } : { type: "tool", toolCallId, name, status: "running", args };
  }
  if (phase === "result") {
    const status = isError === true ? "error" : "completed";
    const output = messageText(result);
    return output === undefined ? { type: "tool", toolCallId, name, status } : { type: "tool", toolCallId, name, status, output };
  }
  return undefined;
}

// Text parts of a message or a tool result: { content: [{ type: "text", text }, ...] }.
function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
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
