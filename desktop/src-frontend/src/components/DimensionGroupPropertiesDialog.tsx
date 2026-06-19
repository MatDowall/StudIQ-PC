import type { ReactNode } from "react";
import { useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import type { DimensionGroupPropsDto } from "../store/appStore";
import {
  FRAMING_SIZES,
  type FramingSettings,
  type FramingSize,
  type FramingWallInput,
  aggregateFramingGroup,
  dwangRowCount,
  parseFramingSettings,
  plateLayerCount,
  serializeFramingSettings,
  studHeightMm,
} from "../lib/framing";

const MEASUREMENT_TYPES = [
  { value: "count", label: "Count" },
  { value: "length", label: "Length" },
  { value: "area", label: "Area" },
  { value: "timber_framing", label: "Timber Framing" },
  { value: "array", label: "Array" },
] as const;
const LINE_STYLES = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "dash_dot", label: "Dash-dot" },
];

// Which display types are valid for each measurement type (per the derivation matrix).
// Timber Framing derives lineal metres of timber, so it always displays as "length".
const DISPLAYS_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  count: [{ value: "count", label: "Count" }],
  length: [
    { value: "length", label: "Length" },
    { value: "area", label: "Area" },
    { value: "wall_area", label: "Wall Area" },
    { value: "volume", label: "Volume" },
    { value: "weight", label: "Weight" },
  ],
  area: [
    { value: "area", label: "Area" },
    { value: "perimeter", label: "Perimeter" },
    { value: "wall_area", label: "Wall Area" },
    { value: "volume", label: "Volume" },
    { value: "weight", label: "Weight" },
  ],
  timber_framing: [{ value: "length", label: "Timber (lineal m)" }],
  array: [
    { value: "length", label: "Length" },
    { value: "count", label: "Count" },
  ],
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", alignItems: "center", gap: 10, minHeight: 28 }}>
      <span style={{ color: theme.text.secondary, fontSize: 12, textAlign: "right" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </div>
  );
}

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

export function DimensionGroupPropertiesDialog({
  groupName,
  initial,
  framingWalls = [],
  onCancel,
  onConfirm,
}: {
  groupName: string;
  initial: DimensionGroupPropsDto;
  framingWalls?: FramingWallInput[];
  onCancel: () => void;
  onConfirm: (props: DimensionGroupPropsDto) => void;
}) {
  const [measurementType, setMeasurementType] = useState(initial.measurement_type);
  const [defaultDisplay, setDefaultDisplay] = useState(initial.default_display);
  const [multiplier, setMultiplier] = useState(String(initial.default_multiplier));
  const [width, setWidth] = useState(String(initial.default_width));
  const [height, setHeight] = useState(String(initial.default_height));
  const [offset, setOffset] = useState(String(initial.default_offset));
  const [addToGfa, setAddToGfa] = useState(initial.add_to_gfa);
  const [posColour, setPosColour] = useState(initial.pos_colour);
  const [posStyle, setPosStyle] = useState(initial.pos_style);
  const [negColour, setNegColour] = useState(initial.neg_colour);
  const [negStyle, setNegStyle] = useState(initial.neg_style);
  const [weightUom, setWeightUom] = useState(initial.weight_uom ?? "");

  // Timber-framing settings (shown only when measurement type = Timber Framing). Kept as
  // editable strings/booleans, mirroring the numeric fields above; serialised on confirm.
  const initialFraming = parseFramingSettings(initial.framing_props_json);
  const [framingSize, setFramingSize] = useState<FramingSize>(initialFraming.framingSize);
  const [studSpacing, setStudSpacing] = useState(String(initialFraming.studSpacingMm));
  const [topPlateOn, setTopPlateOn] = useState(initialFraming.topPlate.on);
  const [topPlateDouble, setTopPlateDouble] = useState(initialFraming.topPlate.double);
  const [bottomPlateOn, setBottomPlateOn] = useState(initialFraming.bottomPlate.on);
  const [bottomPlateDouble, setBottomPlateDouble] = useState(initialFraming.bottomPlate.double);
  const [wallHeight, setWallHeight] = useState(String(initialFraming.wallHeightMm));
  const [dwangCentres, setDwangCentres] = useState(String(initialFraming.dwangCentresMm));
  const [dwangsOn, setDwangsOn] = useState(initialFraming.dwangsOn);

  const isFraming = measurementType === "timber_framing";
  const isArray = measurementType === "array";
  const displayOptions = DISPLAYS_BY_TYPE[measurementType] ?? DISPLAYS_BY_TYPE.length;

  function changeMeasurementType(next: string) {
    setMeasurementType(next);
    // Keep the display valid for the new measurement type.
    const allowed = DISPLAYS_BY_TYPE[next] ?? [];
    if (!allowed.some((option) => option.value === defaultDisplay)) {
      setDefaultDisplay(allowed[0]?.value ?? "length");
    }
  }

  function parseNumber(value: string, fallback: number) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  const framingSettings: FramingSettings = {
    framingSize,
    studSpacingMm: parseNumber(studSpacing, 600),
    topPlate: { on: topPlateOn, double: topPlateDouble },
    bottomPlate: { on: bottomPlateOn, double: bottomPlateDouble },
    wallHeightMm: parseNumber(wallHeight, 2400),
    dwangCentresMm: parseNumber(dwangCentres, 800),
    dwangsOn,
  };

  // Live makeup summary (recomputed as the settings are edited).
  const framingLayers = plateLayerCount(framingSettings);
  const framingStudHeight = studHeightMm(framingSettings);
  const framingDwangRows = dwangRowCount(framingSettings);
  const framingSummary = isFraming ? aggregateFramingGroup(framingWalls, framingSettings) : null;

  function confirm() {
    onConfirm({
      node_id: initial.node_id,
      measurement_type: measurementType,
      // Framing always displays as length. Array displays as length or count.
      default_display: isFraming ? "length" : defaultDisplay,
      default_multiplier: parseNumber(multiplier, 1),
      default_width: parseNumber(width, 0),
      default_height: parseNumber(height, 0),
      default_offset: parseNumber(offset, 0),
      add_to_gfa: addToGfa,
      pos_colour: posColour,
      pos_style: posStyle,
      neg_colour: negColour,
      neg_style: negStyle,
      weight_uom: weightUom.trim() ? weightUom.trim() : null,
      // Persist framing settings when this is a framing group; otherwise keep any existing blob.
      framing_props_json: isFraming ? serializeFramingSettings(framingSettings) : initial.framing_props_json,
    });
  }

  const isWeight = defaultDisplay === "weight";

  return (
    <DialogShell title={`Dimension Group Properties — ${groupName}`} width={460} zIndex={1250} onClose={onCancel}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
          <Field label="Measurement Type">
            <select value={measurementType} onChange={(e) => changeMeasurementType(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              {MEASUREMENT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </Field>
          {!isFraming ? (
            <>
              <Field label="Default Display">
                <select value={defaultDisplay} onChange={(e) => setDefaultDisplay(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
                  {displayOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Default Multiplier">
                <input type="number" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              </Field>
              <Field label={isArray ? "Default Spacing" : "Default Width"}>
                <input type="number" value={width} onChange={(e) => setWidth(e.target.value)} style={{ ...inputStyle, flex: 1 }} title={isArray ? "Centre-to-centre spacing between array members (metres)" : undefined} />
                <span style={{ color: theme.text.secondary, fontSize: 12 }}>m</span>
              </Field>
              {!isArray ? (
                <Field label="Default Height">
                  <input type="number" value={height} onChange={(e) => setHeight(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                  <span style={{ color: theme.text.secondary, fontSize: 12 }}>m</span>
                </Field>
              ) : null}
            </>
          ) : (
            <>
              <Field label="Framing Size">
                <select value={framingSize} onChange={(e) => setFramingSize(e.target.value as FramingSize)} style={{ ...inputStyle, flex: 1 }}>
                  {FRAMING_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size.replace("x", " × ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Stud Spacing">
                <input type="number" value={studSpacing} onChange={(e) => setStudSpacing(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
              </Field>
              <Field label="Top Plate">
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.text.secondary }}>
                  <input type="checkbox" checked={topPlateOn} onChange={(e) => setTopPlateOn(e.target.checked)} /> On
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.text.secondary, opacity: topPlateOn ? 1 : 0.5 }}>
                  <input type="checkbox" checked={topPlateDouble} disabled={!topPlateOn} onChange={(e) => setTopPlateDouble(e.target.checked)} /> Double
                </label>
              </Field>
              <Field label="Bottom Plate">
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.text.secondary }}>
                  <input type="checkbox" checked={bottomPlateOn} onChange={(e) => setBottomPlateOn(e.target.checked)} /> On
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.text.secondary, opacity: bottomPlateOn ? 1 : 0.5 }}>
                  <input type="checkbox" checked={bottomPlateDouble} disabled={!bottomPlateOn} onChange={(e) => setBottomPlateDouble(e.target.checked)} /> Double
                </label>
              </Field>
              <Field label="Wall Height">
                <input type="number" value={wallHeight} onChange={(e) => setWallHeight(e.target.value)} style={{ ...inputStyle, flex: 1 }} title="Bottom of bottom plate to top of top plate" />
                <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
              </Field>
              <Field label="Dwang Centres">
                <input type="number" value={dwangCentres} disabled={!dwangsOn} onChange={(e) => setDwangCentres(e.target.value)} style={{ ...inputStyle, flex: 1, opacity: dwangsOn ? 1 : 0.5 }} />
                <span style={{ color: theme.text.secondary, fontSize: 12 }}>mm</span>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.text.secondary }}>
                  <input type="checkbox" checked={dwangsOn} onChange={(e) => setDwangsOn(e.target.checked)} /> On
                </label>
              </Field>
            </>
          )}
          <Field label="Default Offset">
            <input type="number" value={offset} onChange={(e) => setOffset(e.target.value)} style={{ ...inputStyle, flex: 1 }} title="Height above datum (3D only); no effect on 2D quantity" />
            <span style={{ color: theme.text.secondary, fontSize: 12 }}>m</span>
          </Field>
          <Field label="Add To GFA">
            <input type="checkbox" checked={addToGfa} onChange={(e) => setAddToGfa(e.target.checked)} />
          </Field>
          {/* Timber Framing has no positive/negative polarity, so its colour/style is set via
              the group's "Change Colour" menu, not here. */}
          {!isFraming ? (
            <>
              <Field label="Positive Dimensions">
                <input type="color" value={posColour} onChange={(e) => setPosColour(e.target.value)} style={{ width: 40, height: 26, padding: 0, background: theme.bg.input, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }} />
                <select value={posStyle} onChange={(e) => setPosStyle(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
                  {LINE_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Negative Dimensions">
                <input type="color" value={negColour} onChange={(e) => setNegColour(e.target.value)} style={{ width: 40, height: 26, padding: 0, background: theme.bg.input, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }} />
                <select value={negStyle} onChange={(e) => setNegStyle(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
                  {LINE_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}
          {!isFraming ? (
            <Field label="Weight UOM">
              <input
                value={weightUom}
                onChange={(e) => setWeightUom(e.target.value)}
                disabled={!isWeight}
                placeholder={isWeight ? "kg, t…" : "(weight display not enabled)"}
                style={{ ...inputStyle, flex: 1, opacity: isWeight ? 1 : 0.5 }}
              />
            </Field>
          ) : (
            <div style={{ marginTop: 4, border: `1px solid ${theme.border.divider}`, background: theme.bg.input }}>
              <div style={{ padding: "5px 8px", borderBottom: `1px solid ${theme.border.subtle}`, fontSize: 12, fontWeight: 600 }}>
                Makeup summary
              </div>
              <div style={{ padding: "6px 8px", fontSize: 11, color: theme.text.secondary, display: "flex", flexDirection: "column", gap: 3 }}>
                <div>Plate layers: <span style={{ color: theme.text.primary }}>{framingLayers}</span></div>
                <div>Stud height: <span style={{ color: theme.text.primary }}>{framingSettings.wallHeightMm} − 45×{framingLayers} = {framingStudHeight} mm</span></div>
                <div>Dwang rows: <span style={{ color: theme.text.primary }}>{framingSettings.dwangsOn ? `⌊${framingSettings.wallHeightMm}/${framingSettings.dwangCentresMm}⌋ = ${framingDwangRows}` : "off"}</span></div>
              </div>
              {framingSummary && framingSummary.totalM > 0 ? (
                <table style={{ width: "100%", borderTop: `1px solid ${theme.border.subtle}`, borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: theme.text.secondary }}>
                      <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Component</th>
                      <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Total (m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {framingSummary.components.map((c) => (
                      <tr key={c.kind + (c.sizeOverride ?? "")}>
                        <td style={{ padding: "3px 8px" }}>{c.count > 1 ? `${c.label} (${c.count})` : c.label}</td>
                        <td style={{ padding: "3px 8px", textAlign: "right" }}>{c.totalM.toFixed(3)}</td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: `1px solid ${theme.border.subtle}`, fontWeight: 600, color: theme.text.primary }}>
                      <td style={{ padding: "4px 8px" }}>Total</td><td style={{ padding: "4px 8px", textAlign: "right" }}>{framingSummary.totalM.toFixed(3)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: "6px 8px", borderTop: `1px solid ${theme.border.subtle}`, fontSize: 11, color: theme.text.disabled }}>
                  Draw walls on a scaled page to see component totals.
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
          <button onClick={onCancel} style={{ height: 28, padding: "0 12px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={confirm} style={{ height: 28, padding: "0 12px", background: theme.bg.active, color: "#FFFFFF", border: `1px solid ${theme.accent}`, cursor: "pointer" }}>
            Save
          </button>
        </div>
    </DialogShell>
  );
}
