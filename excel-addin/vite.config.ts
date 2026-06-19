import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toLocaleString("en-NZ", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
      })
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Root-level HTML so Vite outputs dist/taskpane.html (not dist/src/taskpane/...)
        taskpane: resolve(__dirname, "taskpane.html"),
      },
    },
  },
  // public/ is copied verbatim to dist/ — functions.html/js/json live there
  publicDir: "public",
});
