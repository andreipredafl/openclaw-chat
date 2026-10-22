<script setup lang="ts">
import type { ToolCall } from "../types";

defineProps<{ call: ToolCall }>();

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
</script>

<template>
  <details :class="['tool', call.status]">
    <summary>
      <span class="tool-name">{{ call.name }}</span>
      <span class="tool-status">{{ call.status }}</span>
    </summary>
    <div v-if="call.args !== undefined" class="tool-label">input</div>
    <pre v-if="call.args !== undefined">{{ pretty(call.args) }}</pre>
    <div v-if="call.output !== undefined" class="tool-label">output</div>
    <pre v-if="call.output !== undefined">{{ call.output }}</pre>
  </details>
</template>
