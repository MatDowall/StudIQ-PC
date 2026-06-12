// Debug/QA export: renders timber-framing wall elevations to a PDF so quantities and member
// layout can be checked visually outside the app. Console-only — see Viewer.tsx, which exposes
// `window.exportFramingElevations()`.

import { jsPDF } from "jspdf";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { MEMBER_COLOURS } from "./framing3d";
import type { WallElevation } from "./elevation2d";
import { framingDepthMm, type FramingSettings } from "./framing";

export interface WallElevationExport {
  label: string;
  settings: FramingSettings;
  elevations: WallElevation[];
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [150, 150, 150];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 15;
const HEADER_H = 18;

/** Builds a multi-page A4-landscape PDF, one page per wall segment, and returns the bytes. */
export function buildElevationPdf(walls: WallElevationExport[]): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const drawW = PAGE_W - 2 * MARGIN;
  const drawH = PAGE_H - 2 * MARGIN - HEADER_H;

  let firstPage = true;
  for (const wall of walls) {
    for (const [segIndex, elev] of wall.elevations.entries()) {
      if (!firstPage) doc.addPage();
      firstPage = false;

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text(`${wall.label} — segment ${segIndex + 1}`, MARGIN, MARGIN);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(
        `Framing ${wall.settings.framingSize} | studs @ ${wall.settings.studSpacingMm}mm | ` +
          `wall height ${wall.settings.wallHeightMm}mm | length ${(elev.widthM).toFixed(2)}m | height ${(elev.heightM).toFixed(2)}m`,
        MARGIN,
        MARGIN + 6,
      );

      if (elev.widthM <= 0 || elev.heightM <= 0) continue;

      const scale = Math.min(drawW / elev.widthM, drawH / elev.heightM);
      const originX = MARGIN;
      const originY = MARGIN + HEADER_H + drawH; // bottom-left of drawing area, PDF y grows down

      const toX = (x: number) => originX + x * scale;
      const toY = (y: number) => originY - y * scale;

      // Frame border for reference.
      doc.setDrawColor(180, 180, 180);
      doc.rect(originX, originY - elev.heightM * scale, elev.widthM * scale, elev.heightM * scale);

      doc.setLineWidth(0.15);
      for (const r of elev.rects) {
        const [cr, cg, cb] = hexToRgb(MEMBER_COLOURS[r.kind] ?? "#999999");
        doc.setFillColor(cr, cg, cb);
        doc.setDrawColor(40, 40, 40);
        const px = toX(r.x);
        const py = toY(r.y + r.h);
        const pw = r.w * scale;
        const ph = r.h * scale;
        doc.rect(px, py, pw, ph, "FD");

        if (pw > 10 && ph > 4) {
          const sizeMm = r.sizeOverride ?? wall.settings.framingSize;
          const depthMm = framingDepthMm(sizeMm);
          doc.setFontSize(5);
          doc.setTextColor(20, 20, 20);
          const label = `${r.kind}${r.sizeOverride ? ` (${sizeMm})` : ""}\n${depthMm}x45 ${(r.lengthM * 1000).toFixed(0)}mm`;
          doc.text(label, px + pw / 2, py + ph / 2, { align: "center", baseline: "middle" });
        }
      }

      for (const w of elev.wedges) {
        const [cr, cg, cb] = hexToRgb(MEMBER_COLOURS[w.kind] ?? "#999999");
        doc.setFillColor(cr, cg, cb);
        doc.setDrawColor(40, 40, 40);
        const pts = w.points.map(([x, y]) => [toX(x), toY(y)] as [number, number]);
        const lines = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]);
        doc.lines(lines, pts[0][0], pts[0][1], [1, 1], "FD", true);
      }

      doc.setTextColor(0, 0, 0);
    }
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

/** Builds the elevation PDF and prompts the user to save it. */
export async function exportElevationPdf(walls: WallElevationExport[]): Promise<string | null> {
  const bytes = buildElevationPdf(walls);
  const path = await save({
    title: "Export framing elevation (debug)",
    defaultPath: "framing-elevation.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return null;
  await writeFile(path, bytes);
  return path;
}
