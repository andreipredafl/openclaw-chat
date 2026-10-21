<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ busy: boolean }>();
const emit = defineEmits<{ send: [text: string]; stop: [] }>();

const text = ref("");
const ready = computed(() => text.value.trim() !== "" && !props.busy);

// Enter sends, Shift+Enter adds a line. While a reply streams, Send becomes Stop.
function submit() {
  if (!ready.value) return;
  emit("send", text.value.trim());
  text.value = "";
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <textarea v-model="text" placeholder="Message" rows="2" autofocus @keydown.enter.exact.prevent="submit" />
    <button v-if="busy" type="button" @click="emit('stop')">Stop</button>
    <button v-else type="submit" :disabled="!ready">Send</button>
  </form>
</template>
