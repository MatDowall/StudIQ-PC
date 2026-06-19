/* global Office, Excel */
import "./taskpane.css";

declare const __BUILD_TIME__: string;

// Flags set by the ExcelDNA host before page load (TaskPaneControl.cs)
declare global {
  interface Window {
    __studiqHost?: boolean;
    chrome?: { webview?: { postMessage(msg: unknown): void; addEventListener(type: string, handler: (e: MessageEvent) => void): void } };
  }
}

function isExcelDnaHost(): boolean {
  return !!window.__studiqHost || !!window.chrome?.webview;
}

const BRIDGE = "https://localhost:3998";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BridgeGroup {
  id: number;
  name: string;
  measurement_type: string | null;
  default_display: string | null;
  framing_size: string | null;
  uom: string | null;
}

interface BridgeMeasurement {
  id: number;
  label: string;
  value: number | null;
  uom: string;
}

interface FramingBreakdown {
  matching: { size: string; value: number; uom: string } | null;
  lintels: { size: string; value: number; uom: string }[];
}


// ─── State ────────────────────────────────────────────────────────────────────

const expandedGroups = new Set<number>();
const groupDisplays = new Map<number, string>();

// ─── Display labels ───────────────────────────────────────────────────────────

const DISPLAY_LABELS: Record<string, string> = {
  count: "Count",
  length: "Length",
  area: "Area",
  perimeter: "Perimeter",
  wall_area: "Wall area",
  volume: "Volume",
};

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function setStatus(msg: string, isError = false) {
  const el = document.getElementById("status")!;
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
}
function clearStatus() {
  const el = document.getElementById("status")!;
  el.textContent = "";
  el.className = "status";
}
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmt(v: number | null, uom: string): string {
  if (v == null) return "—";
  const prec = uom === "m" ? 3 : uom.includes("²") || uom.includes("³") ? 2 : 0;
  return `${v.toFixed(prec)}${uom ? " " + uom : ""}`.trim();
}

// ─── Default display per measurement type ────────────────────────────────────

function defaultDisplay(g: BridgeGroup): string {
  if (g.default_display) return g.default_display;
  switch (g.measurement_type) {
    case "timber_framing": return "length";
    case "length":         return "length";
    case "area":           return "area";
    case "count":          return "count";
    case "array":          return "count";
    default:               return "length";
  }
}

function typeLabel(g: BridgeGroup): string {
  if (g.measurement_type === "timber_framing") return g.framing_size ? `Framing ${g.framing_size}` : "Framing";
  if (g.measurement_type) return g.measurement_type.charAt(0).toUpperCase() + g.measurement_type.slice(1);
  return "";
}

// ─── Formula insertion ────────────────────────────────────────────────────────

async function insertFormula(formula: string) {
  try {
    if (isExcelDnaHost()) {
      window.chrome?.webview?.postMessage({ type: "insertFormula", formula });
    } else {
      await Excel.run(async (ctx) => {
        const range = ctx.workbook.getSelectedRange();
        range.formulas = [[formula]];
        await ctx.sync();
      });
    }
  } catch (err) {
    setStatus(`Insert failed: ${err}`, true);
  }
}

// ─── Drag-to-insert ───────────────────────────────────────────────────────────
//
// Uses pointer events (not the HTML5 drag API).
//
// How it works:
//   1. pointerdown on a row → set activeDrag (drag-visual state only, no arm yet).
//   2. pointerup fires in WebView2 even when released over Excel because
//      WebView2 holds Win32 SetCapture while the button is down.
//      • If released INSIDE the viewport → user clicked the row → arm the
//        formula and show the arm bar (user then clicks a target cell).
//      • If released OUTSIDE the viewport → user dragged to Excel →
//        arm + send pointerReleased with screen coords so C# can call
//        ActiveWindow.RangeFromPoint and insert directly (no second click).
//      • Office.js (non-ExcelDNA): arm + start JS polling in both cases.
//
// Why not arm on pointer-exit (pointermove out-of-bounds)?
//   Win32 SetCapture means the WM_LBUTTONUP goes to WebView2, so Excel never
//   sees the mouse release and ActiveCell does not change. Arming on exit and
//   polling for ActiveCell change therefore requires a second click.
//   The pointerReleased + RangeFromPoint path eliminates that second click.

interface ArmedInsert { formula: string; label: string; }

let armedInsert: ArmedInsert | null = null;
let armPollTimer: ReturnType<typeof setTimeout> | null = null;
let armPollLastAddress = "";

interface ActiveDrag {
  formula: string;
  label: string;
  row: HTMLElement;
}

let activeDrag: ActiveDrag | null = null;

// ── Arm / disarm ──

function armFormula(formula: string, label: string) {
  armedInsert = { formula, label };
  document.getElementById("arm-label")!.textContent = `Click a cell to insert: ${label}`;
  document.getElementById("arm-bar")!.classList.remove("hidden");

  if (isExcelDnaHost()) {
    window.chrome?.webview?.postMessage({ type: "armFormula", formula });
  } else {
    startArmPoll();
  }
}

function disarmFormula() {
  if (!armedInsert) return;
  armedInsert = null;
  document.getElementById("arm-bar")!.classList.add("hidden");
  stopArmPoll();
  if (isExcelDnaHost()) {
    window.chrome?.webview?.postMessage({ type: "disarmFormula" });
  }
}

// ── Office.js polling ──
// Used in the non-ExcelDNA host path. Captures a baseline address then polls
// every 200 ms; inserts when the address changes.

function startArmPoll() {
  stopArmPoll();
  armPollLastAddress = "";
  void Excel.run(async (ctx) => {
    const r = ctx.workbook.getSelectedRange();
    r.load("address");
    await ctx.sync();
    armPollLastAddress = r.address ?? "";
    scheduleArmPoll();
  }).catch(() => { /* Excel not ready */ });
}

function scheduleArmPoll() {
  if (!armedInsert) return;
  armPollTimer = setTimeout(async () => {
    if (!armedInsert) return;
    try {
      await Excel.run(async (ctx) => {
        const r = ctx.workbook.getSelectedRange();
        r.load("address");
        await ctx.sync();
        const addr = r.address ?? "";
        if (addr && addr !== armPollLastAddress) {
          const formula = armedInsert?.formula;
          if (formula) { disarmFormula(); await insertFormula(formula); }
        } else {
          scheduleArmPoll();
        }
      });
    } catch {
      scheduleArmPoll();
    }
  }, 200);
}

function stopArmPoll() {
  if (armPollTimer !== null) { clearTimeout(armPollTimer); armPollTimer = null; }
  armPollLastAddress = "";
}

// ── Drag visual ──

function cancelActiveDrag() {
  if (!activeDrag) return;
  activeDrag.row.classList.remove("dragging");
  document.body.classList.remove("is-dragging");
  activeDrag = null;
}

function startRowDrag(e: PointerEvent, formula: string, label: string, row: HTMLElement) {
  if (e.button !== 0) return;
  if ((e.target as Element).closest("button, select")) return;
  cancelActiveDrag();

  row.classList.add("dragging");
  document.body.classList.add("is-dragging");

  activeDrag = { formula, label, row };
}

// Pointer move: clean up if button was released outside our knowledge,
// and send throttled hover coordinates to C# while dragging over Excel.
let lastHoverSend = 0;

document.addEventListener("pointermove", (e: PointerEvent) => {
  if (!activeDrag) return;
  if (e.buttons === 0) { cancelActiveDrag(); return; }

  const outside = e.clientX < 0 || e.clientX > window.innerWidth ||
                  e.clientY < 0 || e.clientY > window.innerHeight;

  if (outside && isExcelDnaHost()) {
    const now = Date.now();
    if (now - lastHoverSend >= 50) {
      lastHoverSend = now;
      const dpr = window.devicePixelRatio || 1;
      window.chrome?.webview?.postMessage({
        type: "hoverCell",
        screenX: Math.round(e.screenX * dpr),
        screenY: Math.round(e.screenY * dpr),
      });
    }
  }
});

// Main dispatch: fires in WebView2 even when released over Excel (Win32 capture).
document.addEventListener("pointerup", (e: PointerEvent) => {
  if (!activeDrag) return;
  const { formula, label } = activeDrag;
  cancelActiveDrag();

  const outside = e.clientX < 0 || e.clientX > window.innerWidth ||
                  e.clientY < 0 || e.clientY > window.innerHeight;

  // Always arm so the arm bar appears as feedback / fallback.
  armFormula(formula, label);

  // If dragged outside and in ExcelDNA host: also send screen coords for
  // RangeFromPoint direct insert (avoids needing a second click).
  if (outside && isExcelDnaHost()) {
    const dpr = window.devicePixelRatio || 1;
    window.chrome?.webview?.postMessage({
      type: "pointerReleased",
      screenX: Math.round(e.screenX * dpr),
      screenY: Math.round(e.screenY * dpr),
      formula,
    });
  }
});

// ─── Dimensions tab ──────────────────────────────────────────────────────────

async function loadGroups() {
  setStatus("Loading…");
  try {
    const resp = await fetch(`${BRIDGE}/api/groups`);
    const data = (await resp.json()) as { groups?: BridgeGroup[]; error?: string };
    if (data.error) { setStatus(data.error, true); return; }
    renderGroups(data.groups ?? []);
    clearStatus();
  } catch {
    setStatus("StudIQ instance not open, open a project to view dimensions", true);
  }
}

function renderGroups(groups: BridgeGroup[]) {
  const list = document.getElementById("group-list")!;
  list.innerHTML = "";

  if (groups.length === 0) {
    list.innerHTML = '<p class="empty">No dimension groups in this project.</p>';
    return;
  }

  for (const g of groups) {
    const isExpanded = expandedGroups.has(g.id);
    const isFraming = g.measurement_type === "timber_framing";

    const item = document.createElement("div");
    item.className = "group-item";
    item.dataset.groupId = String(g.id);

    const header = document.createElement("div");
    header.className = "group-header";
    header.innerHTML = `
      <span class="material-symbols-outlined drag-handle">drag_indicator</span>
      <button class="expand-btn" aria-expanded="${isExpanded}">${isExpanded ? "▾" : "▸"}</button>
      <div class="group-info">
        <span class="group-name">${escHtml(g.name)}</span>
        <span class="group-type">${escHtml(typeLabel(g))}</span>
      </div>
    `;

    header.addEventListener("pointerdown", (e) => {
      const selectedDisplay = groupDisplays.get(g.id) ?? defaultDisplay(g);
      const formula = isFraming
        ? `=STUDIQ.FRAMING(${g.id})`
        : `=STUDIQ.QTY(${g.id},"${selectedDisplay}")`;
      startRowDrag(e, formula, g.name, header);
    });

    header.querySelector<HTMLButtonElement>(".expand-btn")!
      .addEventListener("click", () => void toggleExpand(g, item));

    const subRows = document.createElement("div");
    subRows.className = "sub-rows" + (isExpanded ? " visible" : "");
    subRows.dataset.loaded = "false";

    item.appendChild(header);
    item.appendChild(subRows);
    list.appendChild(item);

    if (isExpanded) void loadSubRows(g, subRows);
  }
}

async function toggleExpand(g: BridgeGroup, item: HTMLElement) {
  const subRows = item.querySelector<HTMLElement>(".sub-rows")!;
  const expandBtn = item.querySelector<HTMLButtonElement>(".expand-btn")!;
  const isNowExpanded = !expandedGroups.has(g.id);

  if (isNowExpanded) {
    expandedGroups.add(g.id);
    expandBtn.textContent = "▾";
    expandBtn.setAttribute("aria-expanded", "true");
    subRows.classList.add("visible");
    if (subRows.dataset.loaded === "false") await loadSubRows(g, subRows);
  } else {
    expandedGroups.delete(g.id);
    expandBtn.textContent = "▸";
    expandBtn.setAttribute("aria-expanded", "false");
    subRows.classList.remove("visible");
  }
}

async function loadSubRows(g: BridgeGroup, container: HTMLElement) {
  container.innerHTML = '<div class="sub-loading">Loading…</div>';
  try {
    if (g.measurement_type === "timber_framing") {
      await loadFramingSubRows(g, container);
    } else {
      await loadMeasurementSubRows(g, container);
    }
    container.dataset.loaded = "true";
  } catch {
    container.innerHTML = '<div class="sub-error">Failed to load details.</div>';
  }
}

async function loadMeasurementSubRows(g: BridgeGroup, container: HTMLElement, displayOverride?: string) {
  const display = displayOverride ?? groupDisplays.get(g.id) ?? defaultDisplay(g);
  const resp = await fetch(`${BRIDGE}/api/measurements?groupId=${g.id}&display=${display}`);
  const data = (await resp.json()) as {
    measurements?: BridgeMeasurement[];
    error?: string;
    display?: string;
    possible_displays?: string[];
  };
  const items = data.measurements ?? [];
  const chosenDisplay = data.display ?? display;
  const possibleDisplays = data.possible_displays ?? [chosenDisplay];

  container.innerHTML = "";

  if (possibleDisplays.length > 1) {
    const selectorRow = document.createElement("div");
    selectorRow.className = "display-selector-row";
    const label = document.createElement("span");
    label.className = "display-selector-label";
    label.textContent = "Drag as:";
    const select = document.createElement("select");
    select.className = "display-selector";
    for (const d of possibleDisplays) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = DISPLAY_LABELS[d] ?? d;
      if (d === chosenDisplay) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const newDisplay = select.value;
      groupDisplays.set(g.id, newDisplay);
      container.innerHTML = '<div class="sub-loading">Loading…</div>';
      void loadMeasurementSubRows(g, container, newDisplay);
    });
    selectorRow.appendChild(label);
    selectorRow.appendChild(select);
    container.appendChild(selectorRow);
  }

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sub-empty";
    empty.textContent = "No measurements.";
    container.appendChild(empty);
    return;
  }

  for (const m of items) {
    container.appendChild(makeSubRow(
      m.label,
      fmt(m.value, m.uom),
      `=STUDIQ.MEASUREMENT(${g.id},${m.id},"${chosenDisplay}")`,
    ));
  }
}

async function loadFramingSubRows(g: BridgeGroup, container: HTMLElement) {
  const resp = await fetch(`${BRIDGE}/api/framing?groupId=${g.id}`);
  const data = (await resp.json()) as FramingBreakdown & { error?: string };
  if (data.error) { container.innerHTML = `<div class="sub-error">${escHtml(data.error)}</div>`; return; }

  container.innerHTML = "";

  if (data.matching) {
    const m = data.matching;
    container.appendChild(makeSubRow(
      `Framing ${m.size}`,
      fmt(m.value, m.uom),
      `=STUDIQ.FRAMING(${g.id})`,
    ));
  }

  for (const l of data.lintels ?? []) {
    container.appendChild(makeSubRow(
      `Lintel ${l.size}`,
      fmt(l.value, l.uom),
      `=STUDIQ.LINTEL(${g.id},"${l.size}")`,
    ));
  }

  if (!data.matching && (data.lintels ?? []).length === 0) {
    container.innerHTML = '<div class="sub-empty">No framing data.</div>';
  }
}

function makeSubRow(label: string, value: string, formula: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "sub-row";
  row.innerHTML = `
    <span class="material-symbols-outlined drag-handle">drag_indicator</span>
    <div class="sub-info">
      <span class="sub-label">${escHtml(label)}</span>
      <span class="sub-value">${escHtml(value)}</span>
    </div>
  `;
  row.addEventListener("pointerdown", (e) => startRowDrag(e, formula, label, row));
  return row;
}

// ─── Cell bar: parse STUDIQ formula → groupId for "Show on plan" ─────────────

const STUDIQ_GROUP_RE = /=STUDIQ\.(QTY|MEASUREMENT|FRAMING|LINTEL)\s*\(\s*(\d+)/i;

let currentGroupId: number | null = null;

function updateCellBar(formula: string) {
  const bar = document.getElementById("cell-bar")!;
  const formulaEl = document.getElementById("cell-formula")!;
  const match = STUDIQ_GROUP_RE.exec(formula);
  if (match) {
    currentGroupId = parseInt(match[2], 10);
    formulaEl.textContent = formula.replace(/^=/, "");
    bar.classList.remove("hidden");
  } else {
    currentGroupId = null;
    bar.classList.add("hidden");
  }
}

async function watchSelection() {
  if (isExcelDnaHost()) return;
  try {
    await Excel.run(async (ctx) => {
      const handler = ctx.workbook.onSelectionChanged.add(async () => {
        // If a formula is armed, insert it into the newly selected cell
        if (armedInsert) {
          const formula = armedInsert.formula;
          const label = armedInsert.label;
          disarmFormula();
          await insertFormula(formula);
          setStatus(`Inserted: ${label}`, false);
          setTimeout(() => clearStatus(), 1500);
          return;
        }
        // Otherwise update the cell bar for "Show on plan"
        try {
          await Excel.run(async (ctx2) => {
            const range = ctx2.workbook.getSelectedRange();
            range.load("formulas");
            await ctx2.sync();
            const f = String((range.formulas as unknown[][])[0]?.[0] ?? "");
            updateCellBar(f.startsWith("=") ? f : "");
          });
        } catch { /* ignore — cell may not be readable */ }
      });
      await ctx.sync();
      void handler;
    });
  } catch { /* Excel not ready yet */ }
}

async function showOnPlan() {
  if (currentGroupId == null) return;
  try {
    await fetch(`${BRIDGE}/api/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: currentGroupId }),
    });
  } catch {
    setStatus("Could not reach StudIQ.", true);
  }
}

// ─── Refresh all ─────────────────────────────────────────────────────────────

async function refreshAll() {
  if (isExcelDnaHost()) {
    window.chrome?.webview?.postMessage({ type: "refreshAll" });
    setStatus("Recalculating…", false);
    setTimeout(() => clearStatus(), 2000);
    return;
  }
  try {
    await Excel.run(async (ctx) => {
      ctx.workbook.application.calculate(Excel.CalculationType.full);
      await ctx.sync();
    });
    setStatus("Recalculated.", false);
    setTimeout(() => clearStatus(), 2000);
  } catch (err) {
    setStatus(`Refresh failed: ${err}`, true);
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

Office.onReady(() => {
  const buildEl = document.getElementById("build-time");
  if (buildEl) buildEl.textContent = __BUILD_TIME__;

  document.getElementById("refresh-btn")!.addEventListener("click", () => {
    expandedGroups.clear();
    groupDisplays.clear();
    void loadGroups();
  });
  document.getElementById("show-on-plan-btn")!.addEventListener("click", () => void showOnPlan());
  document.getElementById("refresh-all-btn")!.addEventListener("click", () => void refreshAll());
  document.getElementById("arm-cancel")!.addEventListener("click", () => disarmFormula());

  // Cancel arm on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armedInsert) disarmFormula();
  });

  // ExcelDNA host: listen for messages back from C# (formulaInserted)
  if (window.chrome?.webview) {
    window.chrome.webview.addEventListener("message", (e: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof e.data === "string" ? e.data : JSON.stringify(e.data));
        if (msg.type === "formulaInserted") {
          const label = armedInsert?.label ?? "";
          disarmFormula();
          if (label) { setStatus(`Inserted: ${label}`, false); setTimeout(() => clearStatus(), 1500); }
        }
      } catch { /* ignore malformed */ }
    });
  }

  void loadGroups();
  void watchSelection();
});
