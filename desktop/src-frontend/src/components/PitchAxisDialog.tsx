import { useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import type { PagePoint, PitchAxis } from "../lib/quantity";

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

const AXIS_COLOUR = "#FFB300"; // matches the pick highlight drawn on the measure in the 2D view.

/**
 * Plan-view preview: the measured shape with its pivot, hinge line and uphill arrow. This is the
 * ONLY place the axis is drawn — pinning it to the measure on the page cluttered the drawing, and
 * a negative angle or direction swung the arrow outside the shape entirely. Here it has room, and
 * the typed direction can be read against the actual shape rather than an abstract compass.
 * Page space is Y-up and SVG is Y-down, so Y is flipped once on the way in and every angle then
 * reads the same way round as it does on the drawing.
 */
function PitchSchematic({ points, axis }: { points: PagePoint[]; axis: PitchAxis }) {
  const W = 292;
  const H = 132;
  const pad = 18;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const sx = (x: number) => offX + (x - minX) * scale;
  const sy = (y: number) => H - (offY + (y - minY) * scale);

  const dirRad = (axis.directionDeg * Math.PI) / 180;
  const ux = Math.cos(dirRad);
  const uy = Math.sin(dirRad);
  const origin = { x: axis.originX, y: axis.originY };
  const alongs = points.map((p) => (p.x - origin.x) * ux + (p.y - origin.y) * uy);
  const acrosses = points.map((p) => (p.x - origin.x) * -uy + (p.y - origin.y) * ux);
  const halfHinge = Math.max(Math.abs(Math.min(...acrosses)), Math.abs(Math.max(...acrosses)), spanX * 0.1) * 0.95;
  const sign = axis.angleDeg < 0 ? -1 : 1;
  const reach = sign > 0 ? Math.max(...alongs, 0) * 0.8 : Math.min(...alongs, 0) * 0.8;

  const shape = points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ");
  const hingeA = { x: sx(origin.x - uy * halfHinge), y: sy(origin.y + ux * halfHinge) };
  const hingeB = { x: sx(origin.x + uy * halfHinge), y: sy(origin.y - ux * halfHinge) };
  const pivot = { x: sx(origin.x), y: sy(origin.y) };
  const tip = { x: sx(origin.x + ux * reach), y: sy(origin.y + uy * reach) };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      <defs>
        <marker id="pitch-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={AXIS_COLOUR} />
        </marker>
      </defs>
      <polygon points={shape} fill={theme.text.secondary} fillOpacity={0.14} stroke={theme.border.divider} strokeWidth={1.5} />
      <line x1={hingeA.x} y1={hingeA.y} x2={hingeB.x} y2={hingeB.y} stroke={AXIS_COLOUR} strokeWidth={1.5} strokeDasharray="5 3" />
      <line x1={pivot.x} y1={pivot.y} x2={tip.x} y2={tip.y} stroke={AXIS_COLOUR} strokeWidth={2} markerEnd="url(#pitch-arrow)" />
      <circle cx={pivot.x} cy={pivot.y} r={3.5} fill={AXIS_COLOUR} />
      <text x={pivot.x + 7} y={pivot.y - 7} fontSize={10} fontWeight="bold" fill={AXIS_COLOUR}>
        {axis.angleDeg.toFixed(1)}°
      </text>
    </svg>
  );
}

/**
 * Sets one area measurement's own pitch plane: how steeply it slopes, which way it rises, and the
 * centre of rotation it pivots about (picked on the measure itself, and re-pickable from here).
 * These supersede the group's Pitch Angle / Pitch Direction for this measure alone; "Use group
 * pitch" drops back to them.
 */
export function PitchAxisDialog({
  initial,
  points,
  groupAngleDeg,
  groupDirectionDeg,
  onCancel,
  onPickCentre,
  onClear,
  onConfirm,
}: {
  initial: PitchAxis;
  /** The measure's own geometry, for the plan preview. */
  points: PagePoint[];
  groupAngleDeg: number;
  groupDirectionDeg: number;
  onCancel: () => void;
  /** Re-arm the canvas pick so a different corner/edge can be chosen. */
  onPickCentre: () => void;
  /** Drop this measure's axis and follow the group's pitch again. */
  onClear: () => void;
  onConfirm: (axis: PitchAxis) => void;
}) {
  const [angle, setAngle] = useState(String(initial.angleDeg));
  const [direction, setDirection] = useState(String(initial.directionDeg));

  function num(value: string, fallback: number, min: number, max: number) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  const liveAngle = num(angle, initial.angleDeg, -89.9, 89.9);
  const liveDirection = num(direction, initial.directionDeg, -360, 360);
  const liveAxis: PitchAxis = { ...initial, angleDeg: liveAngle, directionDeg: liveDirection };

  return (
    <DialogShell title="Pitch Axis" width={400} zIndex={1250} onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        <div style={{ color: theme.text.secondary, fontSize: 11, marginBottom: 2 }}>
          This measure pitches about the centre marked below, rising towards the arrow. A negative
          angle tips it the other way. These override the group's pitch for this measure only.
        </div>
        <PitchSchematic points={points} axis={liveAxis} />
        <Row label="Pitch angle">
          <input type="number" step="0.1" autoFocus value={angle} onChange={(e) => setAngle(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>°</span>
        </Row>
        <Row label="Direction">
          <input type="number" step="1" value={direction} onChange={(e) => setDirection(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <span style={{ color: theme.text.secondary, fontSize: 12, flexShrink: 0 }}>° (−360 to 360)</span>
        </Row>
        <Row label="Centre">
          <span style={{ color: theme.text.secondary, fontSize: 11, flex: 1, minWidth: 0 }}>
            {initial.originX.toFixed(1)}, {initial.originY.toFixed(1)} pt
          </span>
          <button
            onClick={onPickCentre}
            style={{ height: 26, padding: "0 10px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer", fontSize: 11, flexShrink: 0 }}
          >
            Pick on Drawing
          </button>
        </Row>
        <div style={{ color: theme.text.secondary, fontSize: 11 }}>
          Group pitch: {groupAngleDeg.toFixed(1)}° at {groupDirectionDeg.toFixed(0)}°.
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
        <button onClick={onClear} style={{ height: 28, padding: "0 12px", marginRight: "auto", whiteSpace: "nowrap", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
          Use Group Pitch
        </button>
        <button onClick={onCancel} style={{ height: 28, padding: "0 12px", whiteSpace: "nowrap", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
          Cancel
        </button>
        <button
          onClick={() => onConfirm({ ...initial, angleDeg: liveAngle, directionDeg: liveDirection })}
          style={{ height: 28, padding: "0 12px", whiteSpace: "nowrap", background: theme.bg.active, color: theme.text.primary, border: `1px solid ${theme.accent}`, cursor: "pointer" }}
        >
          Set Pitch Axis
        </button>
      </div>
    </DialogShell>
  );
}
