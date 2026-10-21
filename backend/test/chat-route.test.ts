import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { ChatStreamEvent, StreamChatInput } from "../src/chat-service.js";
import { chatRoutes } from "../src/routes/chat.js";

type Script = (input: StreamChatInput) => AsyncGenerator<ChatStreamEvent, void, undefined>;

// A server with the chat route and a scripted ChatService, on a random port.
async function startApp(script: Script): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ forceCloseConnections: true });
  await app.register(chatRoutes, { chat: { streamChat: script } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return { app, url: `http://127.0.0.1:${address.port}/api/chat` };
}

function post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

// Splits an SSE body into its blocks.
function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) as unknown };
    });
}

test("streams the chat events as SSE blocks", async (t) => {
  const { app, url } = await startApp(async function* () {
    yield { type: "started", runId: "r1", sessionKey: "agent:main:test" };
    yield { type: "delta", text: "Hel", replace: false };
    yield { type: "delta", text: "lo", replace: false };
    yield { type: "done", text: "Hello" };
  });
  t.after(() => app.close());

  const res = await post(url, { message: "hi", sessionKey: "agent:main:test" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("x-accel-buffering"), "no");

  assert.deepEqual(parseSse(await res.text()), [
    { event: "started", data: { type: "started", runId: "r1", sessionKey: "agent:main:test" } },
    { event: "delta", data: { type: "delta", text: "Hel", replace: false } },
    { event: "delta", data: { type: "delta", text: "lo", replace: false } },
    { event: "done", data: { type: "done", text: "Hello" } },
  ]);
});

test("rejects a bad body with 400 before touching the chat service", async (t) => {
  let called = false;
  const { app, url } = await startApp(async function* () {
    called = true;
    yield { type: "done", text: "" };
  });
  t.after(() => app.close());

  const bad = [{}, { message: "" }, { message: "x".repeat(8001) }, { message: "hi", sessionKey: "global" }];
  for (const body of bad) {
    const res = await post(url, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    await res.text();
  }
  assert.equal(called, false);
});

test("answers 502 with JSON when the stream fails before it starts", async (t) => {
  const { app, url } = await startApp(async function* () {
    yield { type: "error", code: "NOT_CONNECTED", message: "cannot call chat.send: not connected" };
  });
  t.after(() => app.close());

  const res = await post(url, { message: "hi" });
  assert.equal(res.status, 502);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), {
    error: { code: "NOT_CONNECTED", message: "cannot call chat.send: not connected" },
  });
});

test("uses agent:main:main when the body has no sessionKey", async (t) => {
  const seen: string[] = [];
  const { app, url } = await startApp(async function* (input) {
    seen.push(input.sessionKey);
    yield { type: "started", runId: "r", sessionKey: input.sessionKey };
    yield { type: "done", text: "" };
  });
  t.after(() => app.close());

  await (await post(url, { message: "hi" })).text();
  await (await post(url, { message: "hi", sessionKey: "agent:main:web-1" })).text();
  assert.deepEqual(seen, ["agent:main:main", "agent:main:web-1"]);
});

test("aborts the stream when the client disconnects", { timeout: 5000 }, async (t) => {
  let resolveAborted!: (aborted: boolean) => void;
  const aborted = new Promise<boolean>((resolve) => (resolveAborted = resolve));

  const { app, url } = await startApp(async function* ({ signal }) {
    yield { type: "started", runId: "r", sessionKey: "agent:main:test" };
    yield { type: "delta", text: "a", replace: false };
    // Blocks until the route aborts the signal, which only a disconnect does.
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    resolveAborted(signal?.aborted === true);
  });
  t.after(() => app.close());

  const controller = new AbortController();
  const res = await post(url, { message: "hi" }, controller.signal);
  assert.equal(res.status, 200);
  if (!res.body) throw new Error("no body");
  await res.body.getReader().read(); // the first chunk arrived, the stream is open
  controller.abort();

  assert.equal(await aborted, true);
});
