// Hover-on-committed-measurement card. Visual spec is the reference template supplied by the
// user (hover-card.html) — replicate its layout/colours literally rather than pulling from
// theme.ts, since this card is intentionally styled independently of the app chrome.

export interface HoverCardRow {
  label: string;
  value: string;
}

export interface HoverCardData {
  x: number;
  y: number;
  icon: string;
  groupTypeLabel: string;
  /** Subtitle text — the dimension group's name for a normal measurement, or the opening's
   *  "WIDTHmm x HEIGHTmm" daylight size for a door/window opening card. */
  groupName: string;
  /** Only set for timber-framing groups (e.g. "90 × 45"); renders as the top-right subtitle. */
  framingSize?: string;
  mainValue: string;
  /** Unit shown small and grey after the main value (e.g. "m²", "m", "no"). */
  mainValueUom?: string;
  rows: HoverCardRow[];
  /** Set when the hovered measurement's group has a pitch angle > 0 — drives a separate
   *  double-headed arrow + angle-label overlay rendered alongside this card (see ViewerCanvas's
   *  pitch indicator render, next to where this card itself is rendered). Deliberately PAGE-space
   *  (not pre-transformed through pageToScreen): pan/zoom can change without a mousemove event
   *  (e.g. scroll-to-zoom with the cursor stationary), so the screen transform is applied at
   *  render time against current pan/zoom rather than cached from whenever the hover was detected. */
  pitchIndicator?: {
    cxPt: number;
    cyPt: number;
    dirRad: number;
    pitchDeg: number;
    halfDiagPts: number;
  };
}

const CARD_BG = "#fff6b4";
const CARD_BORDER = "#bfc5a2";
const DIVIDER = "#888";
const TEXT_MUTED = "#444";
const ICON_COLOUR = "#00690e";
const DIM_UOM = "#616161";

export function MeasurementHoverCard({ data }: { data: HoverCardData }) {
  return (
    <div
      style={{
        width: 260,
        border: `1px solid ${CARD_BORDER}`,
        background: CARD_BG,
        padding: 0,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ padding: 10 }}>
        <div style={{ fontWeight: "bold", fontSize: 18, marginBottom: 2, color: "#000" }}>{data.groupTypeLabel}</div>

        {data.framingSize ? (
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: TEXT_MUTED }}>{data.groupName}</div>
            <div style={{ fontSize: 9, color: TEXT_MUTED, textAlign: "right" }}>{data.framingSize}</div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: TEXT_MUTED, marginBottom: 8 }}>{data.groupName}</div>
        )}

        <div style={{ display: "flex", alignItems: "baseline", fontSize: 40, fontWeight: "bold", color: "#000" }}>
          <span
            className="material-symbols-outlined"
            style={{
              color: ICON_COLOUR,
              paddingRight: 4,
              fontVariationSettings: "'FILL' 0, 'wght' 350, 'GRAD' 0, 'opsz' 48",
            }}
          >
            {data.icon}
          </span>
          {data.mainValue}
          {data.mainValueUom ? (
            <span style={{ fontSize: 20, color: DIM_UOM, paddingLeft: 4 }}>{data.mainValueUom}</span>
          ) : null}
        </div>
      </div>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          borderSpacing: 0,
          margin: 0,
          fontSize: 13,
          fontWeight: "normal",
          color: TEXT_MUTED,
        }}
      >
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              <td
                style={{
                  padding: "4px 6px",
                  textAlign: "left",
                  borderTop: `1px dashed ${DIVIDER}`,
                  borderRight: `1px dashed ${DIVIDER}`,
                }}
              >
                {row.label}
              </td>
              <td
                style={{
                  padding: "4px 6px",
                  textAlign: "right",
                  fontWeight: "bold",
                  borderTop: `1px dashed ${DIVIDER}`,
                }}
              >
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
