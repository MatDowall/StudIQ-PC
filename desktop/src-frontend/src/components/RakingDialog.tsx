import { useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

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
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** Sets a raking frame on a single wall segment: the top plate slopes from `start` to `end` height,
 *  optionally rising to a `middle` apex height (gable) at the segment midpoint. */
export function RakingDialog({
  initialStart,
  initialEnd,
  initialMiddle,
  initialGable,
  onCancel,
  onConfirm,
}: {
  initialStart: number;
  initialEnd: number;
  initialMiddle?: number;
  initialGable?: boolean;
  onCancel: () => void;
  onConfirm: (startMm: number, endMm: number, gable: boolean, middleMm?: number) => void;
}) {
  const [start, setStart] = useState(String(initialStart));
  const [end, setEnd] = useState(String(initialEnd));
  const [gable, setGable] = useState(initialGable ?? false);
  const [middle, setMiddle] = useState(String(initialMiddle ?? Math.max(initialStart, initialEnd)));

  function num(value: string, fallback: number) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  return (
    <DialogShell title="Set Raking Frame" width={320} zIndex={1250} onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        <div style={{ color: theme.text.secondary, fontSize: 11, marginBottom: 2 }}>
          The top plate slopes between these wall heights across this segment (start of the drawn run → end).
        </div>
        <Row label="Start height">
          <input type="number" autoFocus value={start} onChange={(e) => setStart(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>mm</span>
        </Row>
        <Row label="End height">
          <input type="number" value={end} onChange={(e) => setEnd(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>mm</span>
        </Row>
        <Row label="Gable">
          <input type="checkbox" checked={gable} onChange={(e) => setGable(e.target.checked)} />
        </Row>
        {gable ? (
          <Row label="Middle height">
            <input type="number" autoFocus value={middle} onChange={(e) => setMiddle(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>mm</span>
          </Row>
        ) : null}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
        <button onClick={onCancel} style={{ height: 28, padding: "0 12px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
          Cancel
        </button>
        <button
          onClick={() =>
            onConfirm(
              num(start, initialStart),
              num(end, initialEnd),
              gable,
              gable ? num(middle, Math.max(initialStart, initialEnd)) : undefined,
            )
          }
          style={{ height: 28, padding: "0 12px", background: theme.bg.active, color: "#FFFFFF", border: `1px solid ${theme.accent}`, cursor: "pointer" }}
        >
          Set Rake
        </button>
      </div>
    </DialogShell>
  );
}
