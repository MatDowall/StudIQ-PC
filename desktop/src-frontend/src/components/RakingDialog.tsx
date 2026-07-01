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

const SCHEMATIC_MARKER_COLOUR = "#FFB300"; // matches the S/E markers drawn on the wall in the 2D view.

/** Side-elevation preview of the raking frame: a baseline from "Start" to "End" (matching the
 *  S/E markers drawn on the actual wall while this dialog is open), with posts at the entered
 *  heights and — for a gable — the ridge drawn at its live apex position. Updates as the user
 *  types, so there's no reopen-and-check-the-3D-view loop to find the right apex position. */
function RakeSchematic({ startMm, endMm, gable, middleMm, middlePositionMm, segLenMm }: { startMm: number; endMm: number; gable: boolean; middleMm: number; middlePositionMm: number; segLenMm: number }) {
  const W = 292;
  const H = 120;
  const xStart = 22;
  const xEnd = W - 22;
  const baselineY = H - 34;
  const topMargin = 12;
  const hMax = Math.max(startMm, endMm, gable ? middleMm : 0, 1);
  const yFor = (h: number) => baselineY - (Math.max(0, h) / hMax) * (baselineY - topMargin);
  const yStart = yFor(startMm);
  const yEnd = yFor(endMm);
  const apexFrac = segLenMm > 0 ? Math.max(0, Math.min(1, middlePositionMm / segLenMm)) : 0.5;
  const xApex = xStart + apexFrac * (xEnd - xStart);
  const yApex = yFor(middleMm);
  const roofPath = gable ? `M ${xStart} ${yStart} L ${xApex} ${yApex} L ${xEnd} ${yEnd}` : `M ${xStart} ${yStart} L ${xEnd} ${yEnd}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {/* Baseline (ground) */}
      <line x1={xStart} y1={baselineY} x2={xEnd} y2={baselineY} stroke={theme.border.divider} strokeWidth={1.5} />
      {/* Posts */}
      <line x1={xStart} y1={baselineY} x2={xStart} y2={yStart} stroke={theme.border.divider} strokeWidth={1.5} strokeDasharray="3 2" />
      <line x1={xEnd} y1={baselineY} x2={xEnd} y2={yEnd} stroke={theme.border.divider} strokeWidth={1.5} strokeDasharray="3 2" />
      {/* Roofline (flat slope, or gable ridge) */}
      <path d={roofPath} stroke={SCHEMATIC_MARKER_COLOUR} strokeWidth={2} fill="none" strokeLinejoin="round" />
      {gable ? (
        <>
          <line x1={xApex} y1={baselineY} x2={xApex} y2={yApex} stroke={SCHEMATIC_MARKER_COLOUR} strokeWidth={1} strokeDasharray="2 2" opacity={0.6} />
          <circle cx={xApex} cy={yApex} r={3} fill={SCHEMATIC_MARKER_COLOUR} />
          <text x={xApex} y={baselineY + 14} textAnchor="middle" fontSize={10} fill={theme.text.secondary}>
            {Math.round(middlePositionMm)}mm ({Math.round(apexFrac * 100)}%)
          </text>
        </>
      ) : null}
      {/* Start/End markers — same colour as the "S"/"E" pins drawn on the wall in the 2D view */}
      <circle cx={xStart} cy={baselineY} r={7} fill={SCHEMATIC_MARKER_COLOUR} stroke="#00000066" />
      <text x={xStart} y={baselineY + 4} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#000000">S</text>
      <circle cx={xEnd} cy={baselineY} r={7} fill={SCHEMATIC_MARKER_COLOUR} stroke="#00000066" />
      <text x={xEnd} y={baselineY + 4} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#000000">E</text>
      <text x={xStart} y={baselineY + 30} textAnchor="middle" fontSize={10} fill={theme.text.secondary}>Start</text>
      <text x={xEnd} y={baselineY + 30} textAnchor="middle" fontSize={10} fill={theme.text.secondary}>End</text>
    </svg>
  );
}

/** Sets a raking frame on a single wall segment: the top plate slopes from `start` to `end` height,
 *  optionally rising to a `middle` apex height (gable) at arc-length `middlePosition` from the
 *  segment start (defaulting to the segment midpoint). */
export function RakingDialog({
  initialStart,
  initialEnd,
  initialMiddle,
  initialMiddlePosition,
  initialGable,
  segLenMm,
  onCancel,
  onConfirm,
}: {
  initialStart: number;
  initialEnd: number;
  initialMiddle?: number;
  initialMiddlePosition?: number;
  initialGable?: boolean;
  /** The segment's length in mm — bounds the apex-position input. */
  segLenMm: number;
  onCancel: () => void;
  onConfirm: (startMm: number, endMm: number, gable: boolean, middleMm?: number, middlePositionMm?: number) => void;
}) {
  const [start, setStart] = useState(String(initialStart));
  const [end, setEnd] = useState(String(initialEnd));
  const [gable, setGable] = useState(initialGable ?? false);
  const [middle, setMiddle] = useState(String(initialMiddle ?? Math.max(initialStart, initialEnd)));
  const [middlePosition, setMiddlePosition] = useState(String(initialMiddlePosition ?? segLenMm / 2));

  function num(value: string, fallback: number, max?: number) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return max !== undefined ? Math.min(n, max) : n;
  }

  const liveStart = num(start, initialStart);
  const liveEnd = num(end, initialEnd);
  const liveMiddle = num(middle, Math.max(liveStart, liveEnd));
  const liveMiddlePosition = num(middlePosition, segLenMm / 2, segLenMm - 1);

  return (
    <DialogShell title="Set Raking Frame" width={320} zIndex={1250} onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        <div style={{ color: theme.text.secondary, fontSize: 11, marginBottom: 2 }}>
          The top plate slopes between these wall heights across this segment. "Start"/"End" below
          match the same-labelled markers pinned on the wall in the drawing while this dialog is open.
        </div>
        <RakeSchematic startMm={liveStart} endMm={liveEnd} gable={gable} middleMm={liveMiddle} middlePositionMm={liveMiddlePosition} segLenMm={segLenMm} />
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
          <>
            <Row label="Middle height">
              <input type="number" autoFocus value={middle} onChange={(e) => setMiddle(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>mm</span>
            </Row>
            <Row label="Apex position">
              <input type="number" value={middlePosition} onChange={(e) => setMiddlePosition(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>mm from start</span>
            </Row>
          </>
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
              gable ? num(middlePosition, segLenMm / 2, segLenMm - 1) : undefined,
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
