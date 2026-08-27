import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // This repo lives on a network share (\\CMNET-Data\CCM-Shared mapped to Z:). SMB does not
    // deliver the change notifications chokidar's native watcher relies on, so without polling an
    // edit is simply never seen: HMR does not fire, the dev server keeps serving the previous
    // transform, and the app silently runs stale code until the server is restarted. Polling costs
    // a directory scan every `interval` ms and is the only thing that works over SMB.
    watch: { usePolling: true, interval: 400 },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        splashscreen: resolve(__dirname, "splashscreen.html"),
      },
    },
  },
});
