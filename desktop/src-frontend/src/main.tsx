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

// Wait for the first paint before swapping the splashscreen for the main window.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    invoke("close_splashscreen").catch(() => {});
  });
});
