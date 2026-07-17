import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

document.addEventListener('contextmenu', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wait for the first paint before swapping the splashscreen for the main window. The
// splashscreen is a separate webview that starts loading at the same time as this one;
// since it's simpler it usually wins that race, but on a slow first WebView2 spin-up it
// can lose, so enforce a minimum visible time to guarantee it actually gets painted.
const MIN_SPLASH_MS = 500;

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const elapsed = performance.now();
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      invoke("close_splashscreen").catch(() => {});
    }, remaining);
  });
});
