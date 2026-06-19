// Shared dimension-group import/derivation helpers.
//
// These were originally private to WorkbookView.tsx; they are extracted here so
// both the in-app Workbook and the Excel bridge listener (lib/bridge.ts) derive
// quantities through the *same* code path — there must be one source of truth for
// the derivation matrix (see CLAUDE.md and lib/quantity.ts / lib/framing.ts).

import { invoke } from "@tauri-apps/api/core";
import { groupNetQuantity, type GroupProps, type PagePoint, type Quantity } from "./quantity";
import {
  aggregateFramingGroup,
  parseFramingSettings,
  parseWallFraming,
  type FramingGroupBreakdown,
  type FramingWallInput,
} from "./framing";
import type { MeasurementDto, DimensionGroupPropsDto, PageScaleDto } from "../store/appStore";

/** Human-readable labels for each derived display key. */
export const IMPORT_DISPLAY_LABELS: Record<string, string> = {
  count: "Count",
  length: "Length",
  area: "Area",
  perimeter: "Perimeter",
  wall_area: "Wall surface area",
  volume: "Volume",
};

export interface ImportDisplayOption {
  key: string;
  label: string;
  quantity: Quantity;
}

/**
 * All derived displays a dimension group's geometry can possibly be brought in
 * as, given its measurement type and default width/height settings — mirrors the
 * derivation matrix in lib/quantity.ts (`deriveQuantity`). E.g. a length measure
 * with a default height can come in as Length or Wall surface area; with both
 * width and height it can also come in as Volume.
 */
export function possibleImportDisplays(props: GroupProps): string[] {
  switch (props.measurement_type) {
    case "count":
      return ["count"];
    case "length": {
      const out = ["length"];
      if (props.default_width > 0) out.push("area");
      if (props.default_height > 0) out.push("wall_area");
      if (props.default_width > 0 && props.default_height > 0) out.push("volume");
      return out;
    }
    case "area": {
      const out = ["area", "perimeter"];
      if (props.default_height > 0) out.push("wall_area", "volume");
      return out;
    }
    case "array":
      return ["count", "length"];
    default:
      return [];
  }
}

export interface GroupImportContext {
  props: GroupProps;
  measurements: MeasurementDto[];
  scaleFor: (drawingId: number, pageIndex: number) => number | null;
  framingBreakdown: FramingGroupBreakdown | null;
}

/** Loads everything needed to derive a dimension group's quantity outside of the
 *  Dimensions sidebar (which only keeps this in memory for the selected groups). */
export async function loadGroupImportContext(groupId: number): Promise<GroupImportContext> {
  const [measurements, props] = await Promise.all([
    invoke<MeasurementDto[]>("get_measurements_for_group", { groupId }),
    invoke<DimensionGroupPropsDto>("get_dimension_group_props", { nodeId: groupId }),
  ]);

  const pageKeys = Array.from(new Set(measurements.map((m) => `${m.drawing_id}:${m.page_index}`)));
  const scaleEntries = await Promise.all(
    pageKeys.map(async (key) => {
      const [drawingId, pageIndex] = key.split(":").map(Number);
      const scale = await invoke<PageScaleDto | null>("get_page_scale", { drawingId, pageIndex });
      return [key, scale?.mm_per_point ?? null] as const;
    }),
  );
  const scaleMap = new Map(scaleEntries);
  const scaleFor = (drawingId: number, pageIndex: number) => scaleMap.get(`${drawingId}:${pageIndex}`) ?? null;

  let framingBreakdown: FramingGroupBreakdown | null = null;
  if (props.measurement_type === "timber_framing") {
    const walls: FramingWallInput[] = measurements.map((m) => {
      let points: PagePoint[] = [];
      try {
        const parsed = JSON.parse(m.geometry_json);
        if (Array.isArray(parsed)) points = parsed;
      } catch { /* ignore malformed geometry */ }
      return {
        id: m.id,
        points,
        mmPerPoint: scaleFor(m.drawing_id, m.page_index),
        framing: parseWallFraming(m.framing_json),
      };
    });
    framingBreakdown = aggregateFramingGroup(walls, parseFramingSettings(props.framing_props_json));
  }

  return { props, measurements, scaleFor, framingBreakdown };
}

/** Builds the option list — one entry per possible derived display that actually
 *  yields a quantity for this group's current measurements. */
export function buildImportOptions(ctx: GroupImportContext): ImportDisplayOption[] {
  const out: ImportDisplayOption[] = [];
  for (const display of possibleImportDisplays(ctx.props)) {
    const quantity = groupNetQuantity(ctx.measurements, { ...ctx.props, default_display: display }, ctx.scaleFor);
    if (!quantity) continue;
    out.push({ key: display, label: IMPORT_DISPLAY_LABELS[display] ?? display, quantity });
  }
  return out;
}

/** Re-derives a linked cell's current quantity, for the chosen display. */
export function deriveLinkedQuantity(ctx: GroupImportContext, display: string): Quantity | null {
  if (ctx.props.measurement_type === "timber_framing") {
    const value = ctx.framingBreakdown?.matchingTotalM ?? 0;
    return value > 0 ? { value, uom: "m" } : null;
  }
  return groupNetQuantity(ctx.measurements, { ...ctx.props, default_display: display }, ctx.scaleFor);
}
