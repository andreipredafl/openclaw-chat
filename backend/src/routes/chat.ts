// POST /api/chat: one message in, the reply out as Server-Sent Events.

import type { FastifyPluginAsync } from "fastify";
import type { ChatStreamEvent, StreamChatInput } from "../chat-service.js";

// What this route needs from ChatService. Tests pass a fake.
export type ChatStreamer = {
  streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamEvent, void, undefined>;
};

export type ChatRouteOptions = { chat: ChatStreamer };

type ChatBody = { message: string; sessionKey?: string };

// The gateway's main conversation, shared with its CLI.
const DEFAULT_SESSION_KEY = "agent:main:main";

const bodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8000 },
    // agent:<agentId>:<sessionId>. Other shapes could reach gateway-internal sessions.
    sessionKey: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$" },
  },
} as const;

export const chatRoutes: FastifyPluginAsync<ChatRouteOptions> = async (app, { chat }) => {
  app.post<{ Body: ChatBody }>("/api/chat", { schema: { body: bodySchema } }, async (request, reply) => {
    const sessionKey = request.body.sessionKey ?? DEFAULT_SESSION_KEY;
    const controller = new AbortController();
    const stream = chat.streamChat({ message: request.body.message, sessionKey, signal: controller.signal });

    // A failure before the run starts is a JSON error, not a 200 with an error inside.
    const first = await stream.next();
    if (first.done) throw new Error("chat stream ended before it started");
    if (first.value.type === "error") {
      request.log.warn({ sessionKey, code: first.value.code }, "chat.send failed");
      return reply.code(502).send({ error: { code: first.value.code, message: first.value.message } });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // no buffering in nginx
    });
    res.flushHeaders();

    // `close` before `finish` means the client went away. Stop the run.
    let clientGone = false;
    res.on("close", () => {
      if (res.writableFinished) return;
      clientGone = true;
      controller.abort();
    });

    const write = (event: ChatStreamEvent) => {
      if (!clientGone) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      write(first.value);
      for await (const event of stream) write(event);
    } catch (err) {
      request.log.error({ err, sessionKey }, "chat stream failed");
      write({ type: "error", code: "INTERNAL", message: "internal error" });
    } finally {
      if (!clientGone) res.end();
    }
  });
};
