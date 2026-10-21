<script setup lang="ts">
import { ref, watch } from "vue";
import type { Message } from "../types";

const props = defineProps<{ messages: Message[] }>();
const end = ref<HTMLDivElement | null>(null);

// Keep the newest text in view while it streams. flush: "post" runs after the DOM update.
watch(() => props.messages, () => end.value?.scrollIntoView({ block: "end" }), { deep: true, flush: "post" });
</script>

<template>
  <div class="messages">
    <p v-if="messages.length === 0" class="hint">Send a message. The reply shows up as the model writes it.</p>
    <article v-for="m in messages" :key="m.id" :class="['message', m.role, m.status]">
      <div class="text">{{ m.text }}</div>
      <div v-if="m.error" class="error">{{ m.error }}</div>
    </article>
    <div ref="end" />
  </div>
</template>
