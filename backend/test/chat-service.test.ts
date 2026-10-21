import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ChatService, type ChatStreamEvent } from "../src/chat-service.js";
import { GatewayError } from "../src/gateway-client.js";

const SESSION = "agent:main:test";
const RUN = "run-1";

// Stands in for GatewayClient: answers chat.send and chat.abort, records every request.
class FakeGateway extends EventEmitter {
  readonly calls: { method: string; params: unknown }[] = [];
  sendError: Error | undefined;
  // Runs before the chat.send ack resolves, to simulate events that arrive early.
  beforeAck: (() => void) | undefined;

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "chat.send") {
      if (this.sendError) return Promise.reject(this.sendError);
      this.beforeAck?.();
      return Promise.resolve({ runId: RUN, status: "accepted" } as T);
    }
    if (method === "chat.abort") {
      return Promise.resolve({ ok: true, aborted: true, runIds: [RUN] } as T);
    }
    return Promise.reject(new Error(`unexpected request ${method}`));
  }

  // Emits a chat event for the test session and run unless the fields are overridden.
  chat(event: Record<string, unknown>): void {
    this.emit("chat", { runId: RUN, sessionKey: SESSION, seq: 0, ...event });
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

type Stream = AsyncGenerator<ChatStreamEvent, void, undefined>;

function start(gateway: FakeGateway, signal?: AbortSignal): Stream {
  return new ChatService(gateway).streamChat({ message: "hi", sessionKey: SESSION, signal });
}

async function nextEvent(stream: Stream): Promise<ChatStreamEvent> {
  const result = await stream.next();
  assert.equal(result.done, false, "stream ended early");
  return result.value as ChatStreamEvent;
}

async function drain(stream: Stream): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("yields started, status, deltas and done, with the full text on done", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  assert.deepEqual(await nextEvent(stream), { type: "started", runId: RUN, sessionKey: SESSION });
  assert.deepEqual(gateway.calls[0]?.params, {
    sessionKey: SESSION,
    message: "hi",
    idempotencyKey: (gateway.calls[0]?.params as { idempotencyKey: string }).idempotencyKey,
  });

  gateway.chat({ state: "status", phase: "starting_model" });
  gateway.chat({ state: "delta", deltaText: "Hel" });
  gateway.chat({ state: "delta", deltaText: "lo" });
  gateway.chat({ state: "final", stopReason: "end_turn" });

  assert.deepEqual(await drain(stream), [
    { type: "status", phase: "starting_model" },
    { type: "delta", text: "Hel", replace: false },
    { type: "delta", text: "lo", replace: false },
    { type: "done", text: "Hello", stopReason: "end_turn" },
  ]);
  assert.equal(gateway.listenerCount("chat"), 0);
  assert.equal(gateway.listenerCount("disconnected"), 0);
  assert.deepEqual(gateway.methods(), ["chat.send"]);
});

test("keeps events that arrive before the chat.send ack", async () => {
  const gateway = new FakeGateway();
  gateway.beforeAck = () => gateway.chat({ state: "delta", deltaText: "early" });
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ state: "final" });

  assert.deepEqual(await drain(stream), [
    { type: "delta", text: "early", replace: false },
    { type: "done", text: "early" },
  ]);
});

test("ignores events from other sessions and other runs", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ sessionKey: "agent:main:other", state: "delta", deltaText: "no" });
  gateway.chat({ runId: "run-2", state: "delta", deltaText: "no" });
  gateway.chat({ state: "delta", deltaText: "yes" });
  gateway.chat({ runId: "run-2", state: "final" });
  gateway.chat({ state: "final" });

  assert.deepEqual(await drain(stream), [
    { type: "delta", text: "yes", replace: false },
    { type: "done", text: "yes" },
  ]);
});

test("a delta with replace resets the accumulated text", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ state: "delta", deltaText: "abc" });
  gateway.chat({ state: "delta", deltaText: "xyz", replace: true });
  gateway.chat({ state: "final" });

  assert.deepEqual(await drain(stream), [
    { type: "delta", text: "abc", replace: false },
    { type: "delta", text: "xyz", replace: true },
    { type: "done", text: "xyz" },
  ]);
});

test("skips the empty replace before final and takes the reply from final.message", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ state: "delta", deltaText: "Hel" });
  gateway.chat({ state: "delta", deltaText: "lo" });
  // What the gateway sends right before final: its live text cleared.
  gateway.chat({ state: "delta", deltaText: "", replace: true, message: { role: "assistant", content: [{ type: "text", text: "" }] } });
  gateway.chat({
    state: "final",
    stopReason: "stop",
    message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
  });

  assert.deepEqual(await drain(stream), [
    { type: "delta", text: "Hel", replace: false },
    { type: "delta", text: "lo", replace: false },
    { type: "done", text: "Hello, world", stopReason: "stop" },
  ]);
});

test("an error event ends the stream; unknown states are ignored", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ state: "thinking", text: "hmm" });
  gateway.chat({ state: "error", errorMessage: "rate limited", errorKind: "rate_limit" });

  assert.deepEqual(await drain(stream), [{ type: "error", code: "rate_limit", message: "rate limited" }]);
  assert.equal(gateway.listenerCount("chat"), 0);
  assert.deepEqual(gateway.methods(), ["chat.send"]);
});

test("an aborted event ends the stream as done with the partial text", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.chat({ state: "delta", deltaText: "par" });
  gateway.chat({ state: "aborted" });

  assert.deepEqual(await drain(stream), [
    { type: "delta", text: "par", replace: false },
    { type: "done", text: "par", stopReason: "aborted" },
  ]);
  assert.deepEqual(gateway.methods(), ["chat.send"]);
});

test("a rejected chat.send yields one error event and nothing else", async () => {
  const gateway = new FakeGateway();
  gateway.sendError = new GatewayError({ code: "INVALID_REQUEST", message: "bad session", details: { code: "SESSION_INVALID" } });
  const stream = start(gateway);

  assert.deepEqual(await drain(stream), [
    { type: "error", code: "INVALID_REQUEST/SESSION_INVALID", message: "bad session" },
  ]);
  assert.equal(gateway.listenerCount("chat"), 0);
  assert.deepEqual(gateway.methods(), ["chat.send"]);
});

test("aborting the signal ends the stream and stops the run on the gateway", async () => {
  const gateway = new FakeGateway();
  const controller = new AbortController();
  const stream = start(gateway, controller.signal);

  await nextEvent(stream);
  gateway.chat({ state: "delta", deltaText: "par" });
  assert.deepEqual(await nextEvent(stream), { type: "delta", text: "par", replace: false });

  const pending = stream.next(); // waits for an event that never comes
  controller.abort();
  assert.deepEqual(await pending, { done: true, value: undefined });

  assert.deepEqual(gateway.calls.at(-1), { method: "chat.abort", params: { sessionKey: SESSION, runId: RUN } });
  assert.equal(gateway.listenerCount("chat"), 0);
});

test("a gateway disconnect during the run yields an error and skips chat.abort", async () => {
  const gateway = new FakeGateway();
  const stream = start(gateway);

  await nextEvent(stream);
  gateway.emit("disconnected", { code: 1012, reason: "service restart" });

  assert.deepEqual(await drain(stream), [
    { type: "error", code: "CONNECTION_CLOSED", message: "gateway connection lost during the run" },
  ]);
  assert.deepEqual(gateway.methods(), ["chat.send"]);
});
