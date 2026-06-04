import { useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";
import { FRAMING_SIZES, type FramingSize, type OpeningTemplate } from "../lib/framing";

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
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", alignItems: "center", gap: 10, minHeight: 28 }}>
      <span style={{ color: theme.text.secondary, fontSize: 12, textAlign: "right" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </div>
  );
}

type HeightField = "sill" | "daylight" | "head";

/** Door/Window opening parameters dialog. Doors edit the daylight (= head) height. Windows have a
 *  sill / daylight (glass) / head trio bound by head = sill + daylight; a lock on one keeps it
 *  fixed while editing another recomputes the third. */
export function OpeningDialog({
  title,
  initial,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  initial: OpeningTemplate;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (template: OpeningTemplate) => void;
}) {
  const isWindow = initial.kind === "window";
  const [sill, setSill] = useState(initial.sillHeightMm ?? 900);
  const [daylight, setDaylight] = useState(initial.daylightHeightMm);
  const [head, setHead] = useState((isWindow ? initial.sillHeightMm ?? 0 : 0) + initial.daylightHeightMm);
  // The held value while the other two adjust to keep head = sill + daylight.
  const [locked, setLocked] = useState<HeightField>("head");
  const [daylightWidth, setDaylightWidth] = useState(String(initial.daylightWidthMm));
  const [lintelSize, setLintelSize] = useState<FramingSize>(initial.lintelSize);
  const [lintelPly, setLintelPly] = useState(String(initial.lintelPly));

  // Edit an (unlocked) height; keep `locked` fixed and recompute the third via head = sill + daylight.
  function editHeight(field: HeightField, raw: number) {
    const v = Math.max(0, raw);
    let s = sill;
    let d = daylight;
    let h = head;
    if (field === "sill") s = v;
    else if (field === "daylight") d = v;
    else h = v;
    if (locked === "head") {
      if (field === "sill") d = h - s;
      else if (field === "daylight") s = h - d;
    } else if (locked === "sill") {
      if (field === "daylight") h = s + d;
      else if (field === "head") d = h - s;
    } else {
      // daylight locked
      if (field === "sill") h = s + d;
      else if (field === "head") s = h - d;
    }
    setSill(Math.max(0, s));
    setDaylight(Math.max(0, d));
    setHead(Math.max(0, h));
  }

  function num(value: string, fallback: number) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function confirm() {
    onConfirm({
      ...initial,
      kind: initial.kind,
      daylightHeightMm: daylight,
      daylightWidthMm: num(daylightWidth, isWindow ? 1200 : 910),
      lintelSize,
      lintelPly: Math.max(1, Math.round(num(lintelPly, 2))),
      sillHeightMm: isWindow ? sill : undefined,
    });
  }

  function lockButton(field: HeightField) {
    const isLocked = locked === field;
    return (
      <button
        type="button"
        onClick={() => setLocked(field)}
        title={isLocked ? "Locked — this value is held while the others adjust" : "Lock this value"}
        style={{
          width: 26,
          height: 28,
          flexShrink: 0,
          background: isLocked ? theme.accent : theme.bg.input,
          color: isLocked ? "#fff" : theme.text.secondary,
          border: `1px solid ${isLocked ? theme.accent : theme.border.divider}`,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        {isLocked ? "🔒" : "🔓"}
      </button>
    );
  }

  function heightRow(label: string, field: HeightField, value: number, hint: string) {
    const isLocked = locked === field;
    return (
      <Row label={label}>
        <input
          type="number"
          value={String(value)}
          disabled={isLocked}
          onChange={(e) => editHeight(field, Number.parseFloat(e.target.value) || 0)}
          style={{ ...inputStyle, flex: 1, opacity: isLocked ? 0.6 : 1 }}
          title={hint}
        />
        <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
        {lockButton(field)}
      </Row>
    );
  }

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1250, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.45)" }}>
      <div
        role="dialog"
        aria-modal="true"
        style={{ width: 400, background: theme.bg.pane, border: `1px solid ${theme.border.divider}`, boxShadow: "0 18px 48px rgba(0,0,0,0.45)", color: theme.text.primary, fontFamily: "Segoe UI, sans-serif" }}
      >
        <div style={{ height: 38, display: "flex", alignItems: "center", padding: "0 12px", background: theme.bg.ribbon, borderBottom: `1px solid ${theme.border.subtle}`, fontSize: 13, fontWeight: 600 }}>
          {title}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
          {isWindow ? (
            <>
              {heightRow("Sill height", "sill", sill, "FFL to top of sill")}
              {heightRow("Daylight opening height", "daylight", daylight, "Glass height (head − sill)")}
              {heightRow("Head height", "head", head, "FFL to underside of lintel")}
            </>
          ) : (
            <Row label="Daylight opening height">
              <input
                type="number"
                value={String(daylight)}
                onChange={(e) => setDaylight(Math.max(0, Number.parseFloat(e.target.value) || 0))}
                style={{ ...inputStyle, flex: 1 }}
                title="FFL to underside of lintel"
              />
              <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
            </Row>
          )}
          <Row label="Daylight opening width">
            <input type="number" value={daylightWidth} onChange={(e) => setDaylightWidth(e.target.value)} style={{ ...inputStyle, flex: 1 }} title="Trimmer to trimmer" />
            <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
          </Row>
          <Row label="Lintel">
            <select value={lintelSize} onChange={(e) => setLintelSize(e.target.value as FramingSize)} style={{ ...inputStyle, flex: 1 }}>
              {FRAMING_SIZES.filter((s) => s !== "45x45").map((s) => (
                <option key={s} value={s}>
                  {s.replace("x", " × ")}
                </option>
              ))}
            </select>
            <input type="number" value={lintelPly} onChange={(e) => setLintelPly(e.target.value)} style={{ ...inputStyle, width: 56 }} title="Number of plies" />
            <span style={{ color: theme.text.secondary, fontSize: 12 }}>ply</span>
          </Row>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
          <button onClick={onCancel} style={{ height: 28, padding: "0 12px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={confirm} style={{ height: 28, padding: "0 12px", background: theme.bg.active, color: "#FFFFFF", border: `1px solid ${theme.accent}`, cursor: "pointer" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
