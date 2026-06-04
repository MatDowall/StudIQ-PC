// CostX-style quantity derivation. Geometry is in PDF points; scale (mm per point)
// converts to real-world metres. Width/height come from the dimension group and are
// in metres. See docs/phase3-plan.md for the derivation matrix.

export interface GroupProps {
  node_id: number;
  measurement_type: string; // count | length | area  (how it's drawn)
  default_display: string; // count | length | area | wall_area | volume | weight
  default_multiplier: number;
  default_width: number; // metres
  default_height: number; // metres
  default_offset: number; // metres (Z datum; no 2D effect)
  add_to_gfa: boolean;
  pos_colour: string;
  pos_style: string;
  neg_colour: string;
  neg_style: string;
  weight_uom: string | null;
  // Timber-framing settings (framing size, stud spacing, plate config, wall height, dwang
  // centres) as a JSON blob; null for non-framing groups. Parsed via lib/framing.ts.
  framing_props_json: string | null;
}

export interface PagePoint {
  x: number;
  y: number;
}

export interface Quantity {
  value: number;
  uom: string;
}

export function polylineLengthPts(points: PagePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Closed-polygon perimeter (includes the closing edge back to the first point). */
export function polygonPerimeterPts(points: PagePoint[]): number {
  if (points.length < 2) return 0;
  return polylineLengthPts(points) + Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
}

/** Absolute polygon area via the shoelace formula (PDF points²). */
export function polygonAreaPts(points: PagePoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Derives the display quantity (magnitude, unsigned) for one dimension's geometry.
 * Returns null when it can't be computed (no scale, or the deferred weight display).
 */
export function deriveQuantity(points: PagePoint[], mmPerPoint: number | null, props: GroupProps): Quantity | null {
  if (points.length < 1) return null;
  // Count needs no scale or geometry beyond a single point — each marker counts as the multiplier.
  if (props.default_display === "count") return { value: props.default_multiplier, uom: "no" };
  if (points.length < 2 || mmPerPoint == null || !(mmPerPoint > 0)) return null;

  const mPerPt = mmPerPoint / 1000;
  const m = props.default_multiplier;
  const w = props.default_width;
  const h = props.default_height;
  const isAreaMeasure = props.measurement_type === "area";

  const lengthM = polylineLengthPts(points) * mPerPt;
  const perimeterM = polygonPerimeterPts(points) * mPerPt;
  const areaM2 = polygonAreaPts(points) * mPerPt * mPerPt;
  // Linear extent of the boundary: the run for a line, the perimeter for an area.
  const boundaryM = isAreaMeasure ? perimeterM : lengthM;

  switch (props.default_display) {
    case "count":
      return { value: m, uom: "" };
    case "length":
      return { value: boundaryM * m, uom: "m" };
    case "area":
      return { value: (isAreaMeasure ? areaM2 : lengthM * w) * m, uom: "m²" };
    case "wall_area":
      return { value: boundaryM * h * m, uom: "m²" };
    case "volume":
      return { value: (isAreaMeasure ? areaM2 * h : lengthM * w * h) * m, uom: "m³" };
    case "weight":
      return null; // deferred — no density/rate model yet
    default:
      return null;
  }
}

const UOM_PRECISION: Record<string, number> = { "": 0, no: 0, m: 3, "m²": 2, "m³": 2 };

/** The numeric part only (no unit), at the unit-appropriate precision. */
export function quantityValueText(quantity: Quantity): string {
  const precision = UOM_PRECISION[quantity.uom] ?? 2;
  return quantity.value.toFixed(precision);
}

export function formatQuantity(quantity: Quantity | null): string {
  if (!quantity) return "—";
  return quantity.uom ? `${quantityValueText(quantity)} ${quantity.uom}` : quantityValueText(quantity);
}

interface MeasurementLike {
  geometry_json: string;
  polarity: number;
  drawing_id: number;
  page_index: number;
}

/** Net quantity for a group: Σ(positive) − Σ(negative), via polarity-signed sum. */
export function groupNetQuantity(
  measurements: MeasurementLike[],
  props: GroupProps,
  scaleFor: (drawingId: number, pageIndex: number) => number | null,
): Quantity | null {
  let total = 0;
  let uom = "";
  let computed = false;
  for (const measurement of measurements) {
    let points: PagePoint[];
    try {
      points = JSON.parse(measurement.geometry_json);
    } catch {
      continue;
    }
    if (!Array.isArray(points)) continue;
    const quantity = deriveQuantity(points, scaleFor(measurement.drawing_id, measurement.page_index), props);
    if (!quantity) continue;
    total += (measurement.polarity ?? 1) * quantity.value;
    uom = quantity.uom;
    computed = true;
  }
  return computed ? { value: total, uom } : null;
}
