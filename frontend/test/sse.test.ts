import assert from "node:assert/strict";
import { test } from "node:test";
import { readSseEvents } from "../src/api/stream-chat";
import type { ChatStreamEvent } from "../src/types";

const encode = (text: string) => new TextEncoder().encode(text);

// What the backend writes for one event.
const block = (event: ChatStreamEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of readSseEvents(streamOf(chunks))) events.push(event);
  return events;
}

test("several events in one chunk come out in order", async () => {
  const delta: ChatStreamEvent = { type: "delta", text: "Hi", replace: false };
  const done: ChatStreamEvent = { type: "done", text: "Hi" };
  assert.deepEqual(await collect([encode(block(delta) + block(done))]), [delta, done]);
});

test("an event split across chunks is reassembled", async () => {
  const delta: ChatStreamEvent = { type: "delta", text: "hello world", replace: false };
  const whole = block(delta);
  const cut = whole.indexOf("world");
  assert.deepEqual(await collect([encode(whole.slice(0, cut)), encode(whole.slice(cut))]), [delta]);
});

test("a character split across chunks is decoded once", async () => {
  const delta: ChatStreamEvent = { type: "delta", text: "café", replace: false };
  const bytes = encode(block(delta));
  const cut = bytes.indexOf(0xc3) + 1; // é is 0xc3 0xa9; cut between the two bytes
  assert.deepEqual(await collect([bytes.slice(0, cut), bytes.slice(cut)]), [delta]);
});

test("blocks without data are skipped", async () => {
  const done: ChatStreamEvent = { type: "done", text: "ok" };
  assert.deepEqual(await collect([encode(`: keep-alive\n\n${block(done)}`)]), [done]);
});

test("stopping early cancels the body stream", async () => {
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encode(block({ type: "status", phase: "starting_model" })));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const event of readSseEvents(endless)) {
    assert.equal(event.type, "status");
    break;
  }
  assert.equal(cancelled, true);
});
