import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { theme } from "../theme";
import { useUpdateChecker } from "../lib/updater";
import { DialogShell } from "./DialogShell";
import studiqLogo from "../assets/studiq-logo.png";

interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const [version, setVersion] = useState("");
  const { update, state, progress, error, checkForUpdate, installUpdate } = useUpdateChecker();

  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);

  return (
    <DialogShell title="About StudIQ" width={360} zIndex={1300} onClose={onClose}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <img src={studiqLogo} alt="StudIQ" style={{ width: 64, height: 64, objectFit: "contain" }} />
        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>StudIQ</div>
        <div style={{ fontSize: 12, color: theme.text.secondary }}>Version {version || "…"}</div>

        <div style={{ marginTop: 16, width: "100%", textAlign: "center", fontSize: 12 }}>
          {state === "idle" && (
            <button
              onClick={() => void checkForUpdate()}
              style={{
                height: 28,
                padding: "0 16px",
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
              }}
            >
              Check for Updates
            </button>
          )}
          {state === "checking" && <div style={{ color: theme.text.secondary }}>Checking for updates…</div>}
          {state === "up-to-date" && <div style={{ color: theme.text.secondary }}>You're up to date.</div>}
          {state === "available" && update && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
              <div>Version {update.version} is available</div>
              <button
                onClick={() => void installUpdate()}
                style={{
                  height: 28,
                  padding: "0 16px",
                  background: theme.accent,
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Install &amp; Restart
              </button>
            </div>
          )}
          {state === "downloading" && <div>Downloading update… {progress}%</div>}
          {state === "ready" && <div>Update ready — restarting…</div>}
          {state === "error" && (
            <div style={{ color: theme.danger }}>Update check failed{error ? `: ${error}` : "."}</div>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
