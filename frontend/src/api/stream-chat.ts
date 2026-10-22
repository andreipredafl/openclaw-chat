// POST /api/chat and read the reply as Server-Sent Events.
// fetch + ReadableStream, because EventSource only does GET.

import type { ChatStreamEvent } from "../types";

export type StreamChatInput = {
  message: string;
  sessionKey: string;
  // Abort to stop reading. The backend then tells the gateway to stop the run.
  signal?: AbortSignal;
};

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: input.message, sessionKey: input.sessionKey }),
    signal: input.signal,
  });
  if (!response.ok) {
    yield await errorEvent(response);
    return;
  }
  if (!response.body) throw new Error("response has no body");
  yield* readSseEvents(response.body);
}

// Turn a byte stream of SSE blocks into events.
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // A chunk can end in the middle of an event, or of a character. Decode with
      // stream: true and keep the unfinished tail for the next read.
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseBlock(block);
        if (event) yield event;
      }
    }
  } finally {
    // Closes the connection when the consumer stops early. A no-op after the end.
    await reader.cancel().catch(() => undefined);
  }
}

// One block: `event: <type>\ndata: <json>`. The type is in the JSON too, so only
// data lines are read. Blocks without data (comments, keep-alives) are skipped.
function parseBlock(block: string): ChatStreamEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length))
    .join("\n");
  if (data.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(data);
  return isRecord(parsed) && typeof parsed.type === "string" ? (parsed as ChatStreamEvent) : undefined;
}

// A failure before the run starts is a JSON body { code, message }, not a stream.
async function errorEvent(response: Response): Promise<ChatStreamEvent> {
  const body: unknown = await response.json().catch(() => undefined);
  const error: Record<string, unknown> = isRecord(body) ? body : {};
  return {
    type: "error",
    code: typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
    message: typeof error.message === "string" ? error.message : `request failed with status ${response.status}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
