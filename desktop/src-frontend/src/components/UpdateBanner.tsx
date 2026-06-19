import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { theme } from "../theme";

type UpdateState = "idle" | "available" | "downloading" | "ready" | "error";

export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<UpdateState>("idle");
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    check()
      .then((result) => {
        if (result) {
          setUpdate(result);
          setState("available");
        }
      })
      .catch((error) => {
        console.error("Update check failed", error);
      });
  }, []);

  if (!update || state === "idle" || dismissed) return null;

  async function install() {
    if (!update) return;
    setState("downloading");
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
            break;
          case "Finished":
            setState("ready");
            break;
        }
      });
      await relaunch();
    } catch (error) {
      console.error("Update install failed", error);
      setState("error");
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 10000,
        background: theme.bg.ribbon,
        border: `1px solid ${theme.border.divider}`,
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        padding: "12px 16px",
        width: 280,
        fontFamily: "Segoe UI, sans-serif",
        fontSize: 12,
        color: theme.text.primary,
      }}
    >
      {state === "available" && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            StudIQ {update.version} is available
          </div>
          {update.body && (
            <div style={{ color: theme.text.secondary, marginBottom: 8 }}>{update.body}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => setDismissed(true)}
              style={{
                background: "transparent",
                border: "none",
                color: theme.text.secondary,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Later
            </button>
            <button
              onClick={install}
              style={{
                background: theme.accent,
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor: "pointer",
                padding: "4px 10px",
                fontSize: 12,
              }}
            >
              Install &amp; Restart
            </button>
          </div>
        </>
      )}
      {state === "downloading" && (
        <div>
          Downloading update… {progress}%
        </div>
      )}
      {state === "ready" && <div>Update ready — restarting…</div>}
      {state === "error" && (
        <div style={{ color: theme.danger }}>Update failed. Try again later.</div>
      )}
    </div>
  );
}
