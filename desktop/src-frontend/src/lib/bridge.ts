// Excel bridge — frontend half of the StudIQ ↔ Excel live link.
//
// The Rust bridge server (desktop/src/bridge.rs) receives HTTP requests from the
// Excel add-in and forwards each as a `bridge://request` Tauri event. We compute
// the answer here using the *same* derivation helpers the in-app Workbook uses
// (lib/groupImport.ts → lib/quantity.ts / lib/framing.ts), then hand the result
// back to Rust via the `bridge_respond` command, which the server relays to Excel.
//
// Keeping compute on the frontend means there is one source of truth for the
// quantity-derivation matrix; Rust never re-implements it.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNodeDto } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import { loadGroupImportContext, deriveLinkedQuantity, buildImportOptions, possibleImportDisplays } from "./groupImport";
import { deriveQuantity, type PagePoint } from "./quantity";
import { parseFramingSettings } from "./framing";

interface BridgeRequest {
  id: number;
  op: string;
  args: Record<string, unknown> | null;
}

let started = false;

/** Mounts the bridge listener exactly once (idempotent). Call from App. */
export function startBridgeListener(): void {
  if (started) return;
  started = true;
  void listen<BridgeRequest>("bridge://request", async (event) => {
    const { id, op, args } = event.payload;
    let result: unknown;
    try {
      result = await handleOp(op, args ?? {});
    } catch (err) {
      result = { error: String(err) };
    }
    try {
      await invoke("bridge_respond", { id, result });
    } catch {
      /* server may have already timed out the request — nothing to do */
    }
  });
}

async function handleOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "ping":
      return { ok: true, projectOpen: useAppStore.getState().activeProject != null };

    case "groups":
      return { groups: await listDimensionGroups() };

    case "quantity": {
      const groupId = Number(args.groupId);
      if (!Number.isFinite(groupId)) return { error: "groupId required" };
      const ctx = await loadGroupImportContext(groupId);
      const requested = args.display != null ? String(args.display) : "";
      const chosen =
        requested || ctx.props.default_display || buildImportOptions(ctx)[0]?.key || "count";
      const q = deriveLinkedQuantity(ctx, chosen);
      if (!q) return { error: "no quantity for this group/display" };
      return { value: q.value, uom: q.uom, display: chosen };
    }

    // ── per-measurement list (for task-pane expansion) ───────────────────────
    case "measurements": {
      const groupId = Number(args.groupId);
      if (!Number.isFinite(groupId)) return { error: "groupId required" };
      const ctx = await loadGroupImportContext(groupId);
      const display = String(args.display ?? "") || ctx.props.default_display || "length";

      if (ctx.props.measurement_type === "timber_framing") {
        const perWall = (ctx.framingBreakdown?.perWall ?? []).map((w) => {
          const matchingM = w.quantities.components
            .filter((c) => !c.sizeOverride)
            .reduce((sum, c) => sum + c.totalM, 0);
          const m = ctx.measurements.find((ms) => ms.id === w.id);
          return { id: w.id, label: m ? `Page ${m.page_index + 1}` : `Wall ${w.id}`, value: matchingM, uom: "m" };
        });
        return { measurements: perWall, display: "length" };
      }

      const result = ctx.measurements.map((m) => {
        let points: PagePoint[] = [];
        try { const p = JSON.parse(m.geometry_json); if (Array.isArray(p)) points = p; } catch { /* skip */ }
        const q = deriveQuantity(points, ctx.scaleFor(m.drawing_id, m.page_index), { ...ctx.props, default_display: display }, m.framing_json);
        return { id: m.id, label: `Page ${m.page_index + 1}`, value: q ? (m.polarity ?? 1) * q.value : null, uom: q?.uom ?? "" };
      });
      return { measurements: result, display, possible_displays: possibleImportDisplays(ctx.props) };
    }

    // ── single-measurement value (for STUDIQ.MEASUREMENT custom function) ────
    case "measurement": {
      const groupId = Number(args.groupId);
      const measurementId = Number(args.measurementId);
      if (!Number.isFinite(groupId) || !Number.isFinite(measurementId)) return { error: "groupId and measurementId required" };
      const ctx = await loadGroupImportContext(groupId);
      const display = String(args.display ?? "") || ctx.props.default_display || "length";

      if (ctx.props.measurement_type === "timber_framing") {
        const wall = ctx.framingBreakdown?.perWall.find((w) => w.id === measurementId);
        if (!wall) return { error: "measurement not found" };
        const matchingM = wall.quantities.components
          .filter((c) => !c.sizeOverride)
          .reduce((sum, c) => sum + c.totalM, 0);
        return { value: matchingM, uom: "m", display: "length" };
      }

      const m = ctx.measurements.find((ms) => ms.id === measurementId);
      if (!m) return { error: "measurement not found" };
      let points: PagePoint[] = [];
      try { const p = JSON.parse(m.geometry_json); if (Array.isArray(p)) points = p; } catch { /* skip */ }
      const q = deriveQuantity(points, ctx.scaleFor(m.drawing_id, m.page_index), { ...ctx.props, default_display: display }, m.framing_json);
      if (!q) return { error: "cannot derive quantity" };
      return { value: (m.polarity ?? 1) * q.value, uom: q.uom, display };
    }

    // ── framing group breakdown (for task-pane expansion) ────────────────────
    case "framing": {
      const groupId = Number(args.groupId);
      if (!Number.isFinite(groupId)) return { error: "groupId required" };
      const ctx = await loadGroupImportContext(groupId);
      if (ctx.props.measurement_type !== "timber_framing" || !ctx.framingBreakdown) {
        return { error: "not a framing group" };
      }
      const settings = parseFramingSettings(ctx.props.framing_props_json);
      const [d, t] = settings.framingSize.split("x").map(Number);
      const sizeStr = `${d}x${t}`;

      const lintelTotals = new Map<string, number>();
      for (const c of ctx.framingBreakdown.components) {
        if (c.sizeOverride) {
          const k = c.sizeOverride;
          lintelTotals.set(k, (lintelTotals.get(k) ?? 0) + c.totalM);
        }
      }

      return {
        matching: { size: sizeStr, value: ctx.framingBreakdown.matchingTotalM, uom: "m" },
        lintels: Array.from(lintelTotals.entries()).map(([size, value]) => ({ size, value, uom: "m" })),
      };
    }

    // ── STUDIQ.FRAMING(groupId) — matchingTotalM ─────────────────────────────
    case "framing_size": {
      const groupId = Number(args.groupId);
      if (!Number.isFinite(groupId)) return { error: "groupId required" };
      const ctx = await loadGroupImportContext(groupId);
      if (ctx.props.measurement_type !== "timber_framing" || !ctx.framingBreakdown) {
        return { error: "not a framing group" };
      }
      return { value: ctx.framingBreakdown.matchingTotalM, uom: "m" };
    }

    // ── STUDIQ.LINTEL(groupId, size) — sum for one lintel size ───────────────
    case "lintel_size": {
      const groupId = Number(args.groupId);
      const size = String(args.size ?? "");
      if (!Number.isFinite(groupId) || !size) return { error: "groupId and size required" };
      const ctx = await loadGroupImportContext(groupId);
      if (ctx.props.measurement_type !== "timber_framing" || !ctx.framingBreakdown) {
        return { error: "not a framing group" };
      }
      const total = ctx.framingBreakdown.components
        .filter((c) => c.sizeOverride === size)
        .reduce((sum, c) => sum + c.totalM, 0);
      return { value: total, uom: "m" };
    }

    // ── focus: navigate StudIQ to a dimension group ──────────────────────────
    case "focus": {
      const groupId = Number(args.groupId);
      if (!Number.isFinite(groupId)) return { error: "groupId required" };
      try {
        await useAppStore.getState().goToDimensionGroup(groupId);
        return { ok: true };
      } catch (err) {
        return { error: String(err) };
      }
    }

    // ── STUDIQ.RATE(id) ───────────────────────────────────────────────────────
    case "rate": {
      const id = Number(args.id);
      if (!Number.isFinite(id)) return { error: "id required" };
      const row = await invoke<{ id: number; code: string; description: string; rate: number; unit: string } | null>(
        "get_rate", { id }
      );
      if (!row) return { error: `rate ${id} not found` };
      return { value: row.rate, unit: row.unit, code: row.code };
    }

    // ── STUDIQ.CONST(name) ────────────────────────────────────────────────────
    case "constant": {
      const name = String(args.name ?? "");
      if (!name) return { error: "name required" };
      const rows = await invoke<{ name: string; value: number }[]>("list_constants");
      const row = rows.find((r) => r.name === name);
      if (!row) return { error: `constant '${name}' not found` };
      return { value: row.value, name: row.name };
    }

    // ── task-pane list ops ────────────────────────────────────────────────────
    case "rates": {
      const rows = await invoke<{ id: number; code: string; description: string; rate: number; unit: string }[]>("list_rates");
      return { rates: rows };
    }

    case "constants": {
      const rows = await invoke<{ name: string; value: number }[]>("list_constants");
      return { constants: rows };
    }

    default:
      return { error: `unknown op: ${op}` };
  }
}

interface BridgeGroup {
  id: number;
  name: string;
  measurement_type: string | null;
  default_display?: string | null;
  framing_size: string | null;
  uom: string | null;
}

/** Walks the dimensions tree (via existing commands) and returns every
 *  dimension-group node, flat. Works regardless of sidebar lazy-load state. */
async function listDimensionGroups(): Promise<BridgeGroup[]> {
  const out: BridgeGroup[] = [];
  const stack: TreeNodeDto[] = await invoke<TreeNodeDto[]>("get_root_nodes", { tree: "dimensions" });
  while (stack.length) {
    const node = stack.shift()!;
    if (node.node_type === "dimension_group") {
      out.push({
        id: node.id,
        name: node.name,
        measurement_type: node.measurement_type,
        default_display: node.default_display,
        framing_size: node.framing_size,
        uom: node.uom,
      });
    }
    if (node.has_children) {
      const children = await invoke<TreeNodeDto[]>("get_children", { parentId: node.id });
      stack.push(...children);
    }
  }
  return out;
}
