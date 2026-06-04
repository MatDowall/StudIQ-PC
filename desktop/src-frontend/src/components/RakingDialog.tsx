import { useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box",
  height: 28,
  padding: "0 8px",
  background: theme.bg.input,
  color: theme.text.primary,
  border: `1px solid ${theme.border.divider}`,
  outline: "none",
  fontSize: 12,
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", alignItems: "center", gap: 10, minHeight: 28 }}>
      <span style={{ color: theme.text.secondary, fontSize: 12, textAlign: "right" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </div>
  );
}

/** Sets a raking frame on a single wall segment: the top plate slopes from `start` to `end` height. */
export function RakingDialog({
  initialStart,
  initialEnd,
  onCancel,
  onConfirm,
}: {
  initialStart: number;
  initialEnd: number;
  onCancel: () => void;
  onConfirm: (startMm: number, endMm: number) => void;
}) {
  const [start, setStart] = useState(String(initialStart));
  const [end, setEnd] = useState(String(initialEnd));

  function num(value: string, fallback: number) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1250, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.45)" }}>
      <div
        role="dialog"
        aria-modal="true"
        style={{ width: 320, background: theme.bg.pane, border: `1px solid ${theme.border.divider}`, boxShadow: "0 18px 48px rgba(0,0,0,0.45)", color: theme.text.primary, fontFamily: "Segoe UI, sans-serif" }}
      >
        <div style={{ height: 38, display: "flex", alignItems: "center", padding: "0 12px", background: theme.bg.ribbon, borderBottom: `1px solid ${theme.border.subtle}`, fontSize: 13, fontWeight: 600 }}>
          Set Raking Frame
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
          <div style={{ color: theme.text.secondary, fontSize: 11, marginBottom: 2 }}>
            The top plate slopes between these wall heights across this segment (start of the drawn run → end).
          </div>
          <Row label="Start height">
            <input type="number" autoFocus value={start} onChange={(e) => setStart(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
          </Row>
          <Row label="End height">
            <input type="number" value={end} onChange={(e) => setEnd(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
          </Row>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
          <button onClick={onCancel} style={{ height: 28, padding: "0 12px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(num(start, initialStart), num(end, initialEnd))} style={{ height: 28, padding: "0 12px", background: theme.bg.active, color: "#FFFFFF", border: `1px solid ${theme.accent}`, cursor: "pointer" }}>
            Set Rake
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
