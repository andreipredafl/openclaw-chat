<script setup lang="ts">
import { reactive, ref } from "vue";
import { streamChat } from "./api/stream-chat";
import Composer from "./components/Composer.vue";
import MessageList from "./components/MessageList.vue";
import type { Message } from "./types";

// One gateway session per page load. A refresh starts a new conversation.
const sessionKey = `agent:main:web-${crypto.randomUUID()}`;

const messages = ref<Message[]>([]);
const busy = ref(false);
// The run in progress, so Stop can abort it.
let active: AbortController | null = null;

async function send(text: string) {
  // reactive(), so that writes to `reply` below update the list.
  const reply = reactive<Message>({ id: crypto.randomUUID(), role: "assistant", text: "", status: "streaming" });
  messages.value.push({ id: crypto.randomUUID(), role: "user", text, status: "done" }, reply);
  busy.value = true;
  const controller = new AbortController();
  active = controller;

  try {
    for await (const event of streamChat({ message: text, sessionKey, signal: controller.signal })) {
      // The phase stays in the bubble only until the next event.
      if (event.type !== "status") reply.phase = undefined;
      switch (event.type) {
        case "status":
          reply.phase = event.phase;
          break;
        case "delta":
          reply.text = event.replace ? event.text : reply.text + event.text;
          break;
        case "tool": {
          // One card per toolCallId: the "completed" or "error" event updates the card "running" created.
          reply.toolCalls ??= [];
          const call = reply.toolCalls.find((c) => c.toolCallId === event.toolCallId);
          if (call) {
            call.status = event.status;
            if (event.output !== undefined) call.output = event.output;
          } else {
            reply.toolCalls.push({ toolCallId: event.toolCallId, name: event.name, status: event.status, args: event.args, output: event.output });
          }
          break;
        }
        case "done":
          reply.text = event.text;
          reply.status = "done";
          break;
        case "error":
          reply.status = "error";
          reply.error = `${event.code}: ${event.message}`;
          break;
        default:
          break; // started: nothing to show
      }
    }
  } catch (err) {
    // Stop aborts the fetch, which throws. That is not an error to show.
    if (!controller.signal.aborted) {
      reply.status = "error";
      reply.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    // Stopped, or the stream ended early: keep the text that arrived.
    if (reply.status === "streaming") reply.status = "done";
    reply.phase = undefined;
    active = null;
    busy.value = false;
  }
}

function stop() {
  active?.abort();
}
</script>

<template>
  <main class="app">
    <header>
      <h1>openclaw-chat</h1>
      <span class="session" title="gateway session for this page">{{ sessionKey }}</span>
    </header>
    <MessageList :messages="messages" />
    <Composer :busy="busy" @send="send" @stop="stop" />
  </main>
</template>
