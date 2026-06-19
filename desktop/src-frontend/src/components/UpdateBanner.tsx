import { useEffect, useState } from "react";
import { theme } from "../theme";
import { useUpdateChecker } from "../lib/updater";

export function UpdateBanner() {
  const { update, state, progress, checkForUpdate, installUpdate } = useUpdateChecker();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  if (!update || state === "idle" || state === "checking" || state === "up-to-date" || dismissed) {
    return null;
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
              onClick={() => void installUpdate()}
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
      {state === "downloading" && <div>Downloading update… {progress}%</div>}
      {state === "ready" && <div>Update ready — restarting…</div>}
      {state === "error" && (
        <div style={{ color: theme.danger }}>Update failed. Try again later.</div>
      )}
    </div>
  );
}
