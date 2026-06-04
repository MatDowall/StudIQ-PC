import { useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { aggregateFramingGroup, parseFramingSettings, parseWallFraming, type FramingWallInput } from "../lib/framing";
import type { PagePoint } from "../lib/quantity";

/**
 * Live framing makeup inspector — the primary surface for auditing that a wall's quantities are
 * correct. Shows, per wall of the active timber-framing group, every component (plates / studs /
 * dwangs) with its intermediate math and lineal-metre total, plus a group total and a CSV export.
 */
export function FramingBreakdownPanel({ onClose }: { onClose: () => void }) {
  const activeDimensionGroupId = useAppStore((s) => s.activeDimensionGroupId);
  const groupProps = useAppStore((s) => s.groupProps);
  const overlayMeasurements = useAppStore((s) => s.overlayMeasurements);
  const scaleCache = useAppStore((s) => s.scaleCache);
  const selectedMeasurementId = useAppStore((s) => s.selectedMeasurementId);
  const activeBreadcrumb = useAppStore((s) => s.activeBreadcrumb);
  const [copied, setCopied] = useState(false);

  const props = activeDimensionGroupId !== null ? groupProps[activeDimensionGroupId] : undefined;
  const isFraming = props?.measurement_type === "timber_framing";
  const groupName = activeBreadcrumb.split(" / ").filter(Boolean).pop() ?? "Framing group";

  const breakdown = useMemo(() => {
    if (!isFraming || activeDimensionGroupId === null || !props) return null;
    const walls: FramingWallInput[] = [];
    for (const m of overlayMeasurements) {
      if (m.dimension_group_id !== activeDimensionGroupId) continue;
      let points: PagePoint[];
      try {
        points = JSON.parse(m.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(points)) continue;
      walls.push({
        id: m.id,
        points,
        mmPerPoint: scaleCache[`${m.drawing_id}:${m.page_index}`]?.mm_per_point ?? null,
        framing: parseWallFraming(m.framing_json),
      });
    }
    return aggregateFramingGroup(walls, parseFramingSettings(props.framing_props_json));
  }, [isFraming, activeDimensionGroupId, props, overlayMeasurements, scaleCache]);

  function csvCell(value: string | number): string {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function copyCsv() {
    if (!breakdown) return;
    const lines = ["Group,Wall,Component,Count,Total (m)"];
    breakdown.perWall.forEach((wall, index) => {
      for (const c of wall.quantities.components) {
        lines.push([groupName, `Wall ${index + 1}`, c.label, c.count, c.totalM.toFixed(3)].map(csvCell).join(","));
      }
    });
    lines.push([groupName, "TOTAL", "", "", breakdown.totalM.toFixed(3)].map(csvCell).join(","));
    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 10,
    right: 10,
    width: 320,
    maxHeight: "calc(100% - 20px)",
    display: "flex",
    flexDirection: "column",
    background: theme.bg.pane,
    border: `1px solid ${theme.border.divider}`,
    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
    color: theme.text.primary,
    fontFamily: "Segoe UI, sans-serif",
    fontSize: 12,
    zIndex: 15,
  };

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", height: 32, padding: "0 8px", background: theme.bg.ribbon, borderBottom: `1px solid ${theme.border.subtle}` }}>
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Framing breakdown</span>
        <button
          onClick={onClose}
          title="Close"
          style={{ marginLeft: "auto", width: 22, height: 22, background: "transparent", color: theme.text.secondary, border: "none", cursor: "pointer", fontSize: 14 }}
        >
          ×
        </button>
      </div>

      {!isFraming ? (
        <div style={{ padding: 12, color: theme.text.secondary }}>Select a Timber Framing group to see its makeup.</div>
      ) : !breakdown || breakdown.perWall.length === 0 ? (
        <div style={{ padding: 12, color: theme.text.secondary }}>Draw walls on a scaled page to see the makeup.</div>
      ) : (
        <>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8 }}>
            <div style={{ color: theme.text.secondary, marginBottom: 6 }}>{groupName} — {breakdown.perWall.length} wall{breakdown.perWall.length > 1 ? "s" : ""}</div>
            {breakdown.perWall.map((wall, index) => {
              const highlighted = wall.id === selectedMeasurementId;
              return (
                <div key={wall.id} style={{ marginBottom: 8, border: `1px solid ${highlighted ? theme.accent : theme.border.subtle}`, background: theme.bg.input }}>
                  <div style={{ padding: "3px 6px", borderBottom: `1px solid ${theme.border.subtle}`, fontWeight: 600 }}>
                    Wall {index + 1}
                    <span style={{ float: "right", color: theme.text.secondary, fontWeight: 400 }}>{wall.quantities.totalM.toFixed(3)} m</span>
                  </div>
                  <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 3 }}>
                    {wall.quantities.components.map((c) => (
                      <div key={c.kind} style={{ display: "flex", flexDirection: "column" }}>
                        <div style={{ display: "flex" }}>
                          <span>{c.label}</span>
                          <span style={{ marginLeft: "auto" }}>{c.totalM.toFixed(3)} m</span>
                        </div>
                        <div style={{ color: theme.text.disabled, fontSize: 10 }}>{c.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${theme.border.subtle}`, padding: "6px 8px" }}>
            {breakdown.components.map((c) => (
              <div key={c.kind} style={{ display: "flex", color: theme.text.secondary }}>
                <span>{c.count > 1 ? `${c.label} (${c.count})` : c.label}</span>
                <span style={{ marginLeft: "auto" }}>{c.totalM.toFixed(3)} m</span>
              </div>
            ))}
            <div style={{ display: "flex", fontWeight: 600, marginTop: 2 }}>
              <span>Total</span><span style={{ marginLeft: "auto" }}>{breakdown.totalM.toFixed(3)} m</span>
            </div>
            <button
              onClick={copyCsv}
              style={{ marginTop: 8, width: "100%", height: 26, background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer", fontSize: 11 }}
            >
              {copied ? "Copied ✓" : "Copy CSV"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
