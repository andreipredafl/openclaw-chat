// Shapes shared by the API client and the components.

// One tool the agent called while writing a reply. The card updates in place.
export type ToolCall = {
  toolCallId: string;
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  output?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "done" | "error";
  // The gateway's progress phase ("starting_model"), shown until the first text arrives.
  phase?: string;
  // Tool calls of this reply, in the order they started.
  toolCalls?: ToolCall[];
  // Set when status is "error". `text` keeps what streamed before the failure.
  error?: string;
};

// Events sent by POST /api/chat. Same shape as ChatStreamEvent in the backend.
export type ChatStreamEvent =
  | { type: "started"; runId: string; sessionKey: string }
  | { type: "status"; phase: string }
  // With replace, `text` is the whole reply so far, not an append.
  | { type: "delta"; text: string; replace: boolean }
  // The same toolCallId comes twice: "running" with args, then "completed" or "error" with output.
  | ({ type: "tool" } & ToolCall)
  // `text` is the full reply.
  | { type: "done"; text: string; stopReason?: string }
  | { type: "error"; code: string; message: string };
