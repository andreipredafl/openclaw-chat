import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    // Same origin for the page and the API, as nginx does in Docker. No CORS.
    // 127.0.0.1, not localhost: the backend listens on IPv4 and Node may resolve localhost to ::1.
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
