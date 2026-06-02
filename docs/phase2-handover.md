# Phase 2 Handover: Vector Extraction and Snap Engine
## Desktop CAD/Takeoff Application — Rust + Tauri + React
## Target platforms: Windows and macOS

---

## How To Use This Document

This spec is structured as five sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

---

## Context and Goal

Phase 1.7 left the app with a persistent renderer service, stable PDF rendering,
and a working project file system. Phase 2 adds the ability to snap to vectors
on a drawing — the foundational capability that makes accurate measurement
possible in Phase 3.

When this phase is complete, a user must be able to:
1. Open a PDF drawing
2. Move the cursor over the drawing and see snap indicators appear near line
   endpoints, midpoints, and intersections
3. The snap indicator must feel generous — activating from approximately 12px
   screen distance from the nearest snap point
4. Snap must be fast enough to feel instantaneous at mouse-move speed

Phase 2 does **not** implement measurement tools. It proves that the snap engine
works accurately and responsively on real drawings. Measurement tools are Phase 3.

---

## Pre-Flight Fix — Complete Before Any Phase 2 Work

The Phase 1.7 completion report noted this warning during the installer build:

```
The bundle identifier "com.pdfcad.app" ends with ".app".
This is not recommended on macOS.
```

Fix this before starting Phase 2 to avoid macOS packaging problems later.

In `desktop/tauri.conf.json`, change:
```json
"identifier": "com.pdfcad.app"
```
to:
```json
"identifier": "com.takeitoff.app"
```

Verify `cargo tauri build` still succeeds after this change before proceeding
to Milestone 1.

---

## Decisions Already Made — Do Not Revisit

- **PDFium must not run inside `desktop`.** All PDF operations including vector
  extraction go through `pdf_renderer` via the JSON lines IPC protocol.
- **IPC protocol is stdin/stdout JSON lines.** Do not change the protocol format.
- **`worker_count` stays at 1.**
- **Renderer path: `pdf_renderer.exe` on Windows, `pdf_renderer` on macOS/Linux.**
- **PDFium library path: `pdfium.dll` on Windows, `libpdfium.dylib` on macOS.**
- **`CREATE_NO_WINDOW` on Windows only, behind `#[cfg(target_os = "windows")]`.**
- **Sibling path first, bundled resource fallback for renderer resolution.**
- **Tile rendering uses PDFium clipping per tile — do not remove this.**
- **Viewport prioritisation uses batch IDs and newest-batch-first scheduling —
  do not remove this.**
- **Single canvas compositor with overlay canvas above it.**
- **Inline styles only. No Tailwind.**
- **Zustand for all frontend state.**
- **`fs:allow-mkdir` not `fs:allow-create-dir` in capabilities.**
- **Snap types for Phase 2: endpoint, midpoint, intersection only.**
  Perpendicular and nearest-edge are out of scope.
- **Snap activation radius: 12px screen distance** (generous, matching CostX feel).
- **Geometry focus: straight lines and rectangles.** Arc/curve snap is out of
  scope for Phase 2.
- **R-tree spatial index (`rstar` crate) for snap candidate lookup.**
- **Snap runs on the frontend side using extracted vector data passed from Rust.**
  Do not run snap queries inside the renderer or desktop backend — the frontend
  has the cursor position and viewport transform, making it the right place for
  real-time snap resolution.
- **Vector extraction happens once per page per zoom-independent scale.**
  Vectors are in PDF point coordinates. The frontend transforms them to screen
  coordinates using the current viewport state.

---

## Critical Tauri v2 Rules — unchanged from previous phases

**Rule 1 — `main.rs` is a thin wrapper only.**
**Rule 2 — Capabilities file controls all plugin access.**
**Rule 3 — v2 syntax only in `tauri.conf.json`.**
**Rule 4 — `invoke<T>()` must match Rust return types exactly.**
**Rule 5 — Plugin imports use the plugin package.**
**Rule 6 — Every plugin initialised in the builder.**

---

## Architecture Overview

```
Mouse move event (frontend)
        │
        ▼
Snap Engine (TypeScript — runs in frontend)
  ├── Transform cursor to page coordinates
  ├── Query R-tree with 12px radius bounding box
  ├── Resolve snap priority: endpoint > midpoint > intersection
  └── Return best snap point (or null)
        │
        ▼
Overlay Canvas — draw snap indicator at snap point
```

```
Page load / drawing open (backend)
        │
        ▼
desktop invokes renderer: {"cmd": "vectors", "pdf_path": "...", "page": 0}
        │
        ▼
pdf_renderer extracts paths from PDF content stream via pdfium-render
Returns JSON array of primitives:
  [
    {"type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 0},
    {"type": "rect", "x": 10, "y": 10, "width": 80, "height": 60},
    ...
  ]
        │
        ▼
desktop passes primitives to frontend via new Tauri command
        │
        ▼
Frontend builds R-tree from primitives
Snap engine queries R-tree on every mouse move
```

---

## New `vectors` Command in Renderer

Replace the Phase 1.7 stub with a real implementation.

### Request
```json
{ "id": 5, "cmd": "vectors", "pdf_path": "...", "page": 0 }
```

### Response
```json
{
  "id": 5,
  "ok": true,
  "data": {
    "page": 0,
    "primitives": [
      { "type": "line", "x1": 72.0, "y1": 144.0, "x2": 504.0, "y2": 144.0 },
      { "type": "rect", "x": 72.0, "y": 72.0, "width": 432.0, "height": 576.0 },
      { "type": "line", "x1": 100.0, "y1": 200.0, "x2": 300.0, "y2": 200.0 }
    ]
  }
}
```

All coordinates are in **PDF points** (origin at bottom-left of page).

### Primitive types for Phase 2

Only `line` and `rect` in Phase 2. Arcs, beziers, and other curve types are
extracted but **filtered out** — do not include them in the response. This keeps
the snap engine simple and matches the geometry profile of typical structural
and architectural drawings.

```rust
// In handle_vectors():
// Iterate page objects via pdfium-render
// For each path object:
//   - If it has exactly 2 points and is a straight segment → emit "line"
//   - If it is an axis-aligned closed rectangle → emit "rect"
//     (detect by: 4 or 5 points, all right angles, closed)
//   - All other geometry → skip
```

### pdfium-render API for vector extraction

```rust
use pdfium_render::prelude::*;

fn handle_vectors(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = req["pdf_path"].as_str().ok_or("missing pdf_path")?;
    let page_index = req["page"].as_u64().unwrap_or(0) as u16;

    let doc = pdfium.load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;

    let page = doc.pages().get(page_index)
        .map_err(|e| format!("Page not found: {e}"))?;

    let mut primitives: Vec<serde_json::Value> = Vec::new();

    for object in page.objects().iter() {
        if let Some(path) = object.as_path_object() {
            // Extract segments from path
            // Filter to lines and rects only
            // Push to primitives
        }
    }

    Ok(serde_json::json!({
        "page": page_index,
        "primitives": primitives
    }))
}
```

---

## New Tauri Command — `get_page_vectors`

Add to `desktop/src/lib.rs`. Do not modify existing command signatures.

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VectorPrimitive {
    #[serde(rename = "type")]
    pub primitive_type: String,      // "line" or "rect"
    // line fields
    pub x1: Option<f64>,
    pub y1: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    // rect fields
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PageVectors {
    pub page: u32,
    pub primitives: Vec<VectorPrimitive>,
}

/// Extracts vector primitives from a page via the renderer service.
/// Returns line and rect primitives in PDF point coordinates.
/// Called once per page when the page is first displayed.
#[tauri::command]
pub async fn get_page_vectors(
    page_index: u32,
    state: tauri::State<'_, AppState>,
) -> Result<PageVectors, String> {
    let doc_path = {
        let guard = state.open_document.lock();
        guard.as_ref().ok_or("No document open")?.path.clone()
    };

    let request = serde_json::json!({
        "cmd": "vectors",
        "pdf_path": doc_path,
        "page": page_index,
    });

    let data = {
        let mut renderer = state.renderer.lock();
        renderer.as_mut()
            .ok_or("Renderer not running")?
            .request(request)?
    };

    serde_json::from_value::<PageVectors>(data)
        .map_err(|e| format!("PageVectors deserialise error: {e}"))
}
```

Add `get_page_vectors` to `.invoke_handler`.

---

## Frontend — Snap Engine

### Vector cache

Vectors are fetched once per page and cached. Do not re-fetch on pan/zoom.

```typescript
// In appStore.ts — add to store
interface SnapState {
  // page index → array of primitives in PDF point coords
  vectorCache: Record<number, VectorPrimitive[]>;
  snapPoint: SnapPoint | null;
  snapType: 'endpoint' | 'midpoint' | 'intersection' | null;

  loadVectors: (pageIndex: number) => Promise<void>;
  resolveSnap: (
    cursorPageX: number,
    cursorPageY: number,
    pageIndex: number,
    radiusPts: number
  ) => void;
  clearSnap: () => void;
}

interface SnapPoint {
  x: number;   // PDF point coordinates
  y: number;
}
```

### Snap radius conversion

The snap radius is 12px screen distance. Convert to PDF points using the
current zoom level before querying:

```typescript
// In ViewerCanvas.tsx on mouse move:
const radiusPts = 12 / zoom * (72 / 96);  // 12px → PDF points at current zoom
```

### R-tree index

Use an in-memory R-tree built from the vector primitives when vectors are loaded.
Implement a simple R-tree in TypeScript — do not add an npm dependency.

A minimal R-tree for this use case can be a flat array with bounding-box
pre-computation, since Phase 2 geometry is all straight lines and rectangles
and the query radius is fixed. A full R-tree implementation is not required —
a bounding box pre-filter followed by exact distance check is sufficient:

```typescript
interface IndexedPrimitive {
  primitive: VectorPrimitive;
  // Precomputed snap points for this primitive
  snapPoints: { x: number; y: number; type: 'endpoint' | 'midpoint' }[];
  // Bounding box for fast rejection
  minX: number; minY: number; maxX: number; maxY: number;
}

function buildIndex(primitives: VectorPrimitive[]): IndexedPrimitive[] {
  return primitives.map(p => {
    if (p.type === 'line') {
      return {
        primitive: p,
        snapPoints: [
          { x: p.x1!, y: p.y1!, type: 'endpoint' },
          { x: p.x2!, y: p.y2!, type: 'endpoint' },
          { x: (p.x1! + p.x2!) / 2, y: (p.y1! + p.y2!) / 2, type: 'midpoint' },
        ],
        minX: Math.min(p.x1!, p.x2!),
        minY: Math.min(p.y1!, p.y2!),
        maxX: Math.max(p.x1!, p.x2!),
        maxY: Math.max(p.y1!, p.y2!),
      };
    } else {
      // rect — four corners and four edge midpoints as snap points
      const x2 = p.x! + p.width!;
      const y2 = p.y! + p.height!;
      return {
        primitive: p,
        snapPoints: [
          { x: p.x!, y: p.y!, type: 'endpoint' },
          { x: x2,   y: p.y!, type: 'endpoint' },
          { x: x2,   y: y2,   type: 'endpoint' },
          { x: p.x!, y: y2,   type: 'endpoint' },
          { x: (p.x! + x2) / 2, y: p.y!, type: 'midpoint' },
          { x: x2, y: (p.y! + y2) / 2, type: 'midpoint' },
          { x: (p.x! + x2) / 2, y: y2,  type: 'midpoint' },
          { x: p.x!, y: (p.y! + y2) / 2, type: 'midpoint' },
        ],
        minX: p.x!, minY: p.y!, maxX: x2, maxY: y2,
      };
    }
  });
}
```

### Intersection snap

Intersections are not stored as snap points on primitives — they are computed
on the fly from candidate pairs returned by the bounding box query:

```typescript
function findIntersection(
  a: VectorPrimitive,
  b: VectorPrimitive
): { x: number; y: number } | null {
  // Line-line intersection only in Phase 2
  // Use standard parametric line intersection formula
  // Return null if parallel or no intersection within segment bounds
}
```

### Snap priority

When multiple snap candidates are within the radius, resolve in this order:
1. Endpoint (highest priority)
2. Midpoint
3. Intersection (lowest priority)

Return only the single highest-priority nearest snap point.

### Viewport transform

Vectors are stored in PDF point coordinates (origin bottom-left).
The canvas draws with origin top-left. Apply this transform when drawing
the snap indicator:

```typescript
function pageToScreen(
  ptX: number,
  ptY: number,
  pageHeightPts: number,
  pan: { x: number; y: number },
  zoom: number
): { x: number; y: number } {
  // PDF points to pixels at current zoom (96dpi base)
  const scale = zoom * 96 / 72;
  // Flip Y axis: PDF origin is bottom-left, canvas is top-left
  const screenX = ptX * scale - pan.x;
  const screenY = (pageHeightPts - ptY) * scale - pan.y;
  return { x: screenX, y: screenY };
}
```

---

## Snap Indicator Visual

Draw on the overlay canvas. Do not modify the tile canvas.

**Endpoint snap:** Yellow square, 10×10px, 2px stroke, no fill.
```
colour: '#FFD700'
shape: square centered on snap point
size: 10×10px
stroke: 2px
fill: none
```

**Midpoint snap:** Yellow triangle, pointing up, 10px height, 2px stroke,
no fill.

**Intersection snap:** Yellow cross (×), 10px diameter, 2px stroke.

All indicators:
- Drawn on the overlay canvas
- Cleared and redrawn on every mouse move
- Not drawn when cursor is not near any snap point
- Do not interfere with existing measurement overlay drawing

---

## Mouse Move Handler

Add to `ViewerCanvas.tsx`. The snap resolution must run on every mouse move
while a drawing is open. It must not block the render loop.

```typescript
function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
  if (!doc || !page) return;

  const rect = viewportRef.current!.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Convert screen coords to PDF point coords
  const scale = zoom * 96 / 72;
  const pagePtX = (screenX + pan.x) / scale;
  const pagePtY = page.height_pts - (screenY + pan.y) / scale;  // flip Y

  const radiusPts = 12 / (zoom * 96 / 72);

  useAppStore.getState().resolveSnap(pagePtX, pagePtY, pageIndex, radiusPts);
}
```

Throttle snap resolution to once per animation frame using a ref flag — do
not debounce with setTimeout as that introduces visible lag.

---

## Zustand Store Additions

```typescript
// Add to appStore.ts

// Vector cache — keyed by page index
vectorCache: {} as Record<number, VectorPrimitive[]>,
vectorIndex: {} as Record<number, IndexedPrimitive[]>,
snapPoint: null as SnapPoint | null,
snapType: null as 'endpoint' | 'midpoint' | 'intersection' | null,

loadVectors: async (pageIndex: number) => {
  // Skip if already cached
  if (get().vectorCache[pageIndex]) return;
  const result = await invoke<PageVectors>('get_page_vectors', { pageIndex });
  const index = buildIndex(result.primitives);
  set(state => ({
    vectorCache: { ...state.vectorCache, [pageIndex]: result.primitives },
    vectorIndex: { ...state.vectorIndex, [pageIndex]: index },
  }));
},

resolveSnap: (cursorPtX, cursorPtY, pageIndex, radiusPts) => {
  const index = get().vectorIndex[pageIndex];
  if (!index) { set({ snapPoint: null, snapType: null }); return; }
  // Query index, resolve priority, set snapPoint and snapType
},

clearSnap: () => set({ snapPoint: null, snapType: null }),
```

Clear `vectorCache` and `vectorIndex` when a new document is opened or the
project is closed.

---

## ViewerCanvas.tsx Changes

1. Add `onMouseMove` handler that calls `resolveSnap`
2. Add `onMouseLeave` handler that calls `clearSnap`
3. Read `snapPoint`, `snapType` from Zustand store
4. Draw snap indicator on overlay canvas when `snapPoint` is not null
5. Call `loadVectors(pageIndex)` when `pageIndex` changes and a document is open
6. Clear snap state when `pageIndex` changes

The snap indicator drawing runs inside the existing overlay canvas `useEffect`
that already watches for overlay measurement changes. Add `snapPoint` and
`snapType` to its dependency array.

Do not modify tile rendering logic.

---

## Performance Requirements

Snap resolution must complete within **8ms** on a page with up to 5,000
vector primitives. This keeps the snap engine within one animation frame budget.

Test with a real A0 structural drawing. If snap resolution exceeds 8ms:
- Tighten the bounding box pre-filter before running exact distance checks
- Do not remove snap types to hit the budget

---

## Files to Create or Modify

**Modified — Rust:**
1. `core/src/bin/pdf_renderer.rs` — replace `vectors` stub with real extraction
2. `desktop/src/lib.rs` — add `VectorPrimitive`, `PageVectors`, `get_page_vectors`
   command
3. `desktop/tauri.conf.json` — fix bundle identifier (pre-flight)

**Modified — Frontend:**
4. `desktop/src-frontend/src/store/appStore.ts` — add snap state, vector cache,
   `loadVectors`, `resolveSnap`, `clearSnap`
5. `desktop/src-frontend/src/components/ViewerCanvas.tsx` — add mouse move
   handler, snap indicator drawing, vector load on page change

**No new files required.**

---

## MILESTONE 1 — Vectors Extracted and Logged to Terminal

**Goal:** The renderer extracts vector primitives from a real PDF page and
returns them as JSON. Verified via direct stdin/stdout test — no Tauri app
needed.

**Implement:** Replace the `vectors` stub in `pdf_renderer.rs` with the real
pdfium-render path extraction.

**Verification:**

Create `test_vectors.txt`:
```
{"id":1,"cmd":"vectors","pdf_path":"C:\\path\\to\\your\\drawing.pdf","page":0}
{"id":2,"cmd":"shutdown"}
```

```powershell
cargo build --package core --bin pdf_renderer

cmd /c "echo off && .\target\debug\pdf_renderer.exe .\target\debug\libs\pdfium\pdfium.dll < test_vectors.txt"
```

Expected: JSON response containing a `primitives` array with line and rect
objects. Print the count of primitives extracted to confirm extraction is
working.

Confirm:
- Response is valid JSON
- `primitives` array is not empty for a drawing with visible lines
- All entries are `type: "line"` or `type: "rect"`
- Coordinates are non-zero floating point values

**Gate: do not proceed until vector extraction returns real primitives from
a real drawing.**

---

## MILESTONE 2 — Vectors Available in Frontend via Tauri Command

**Goal:** `get_page_vectors` Tauri command works. Vectors for the current
page are available in the frontend. Verified via browser console.

**Implement:** `VectorPrimitive`, `PageVectors` structs and `get_page_vectors`
command in `lib.rs`. `loadVectors` action in Zustand store. Call
`loadVectors(0)` when a document is opened.

**Verification:**
```powershell
cargo build --package core --bin pdf_renderer
cargo build --package desktop
Start-Process -FilePath ".\target\debug\desktop.exe" `
  -WorkingDirectory "C:\Users\Admin\Documents\Take-it-Off"
```

Open a project, open a PDF. In browser console (F12):
```javascript
window.__TAURI__.core.invoke('get_page_vectors', { pageIndex: 0 })
  .then(r => console.log('primitives:', r.primitives.length))
```

Expected: `primitives: N` where N > 0 for any drawing with visible lines.

Also confirm in Zustand devtools or console:
```javascript
// vectorCache should have an entry for page 0
```

**Gate: do not proceed until `get_page_vectors` returns primitives and
the frontend vector cache is populated.**

---

## MILESTONE 3 — Snap Indicator Appears on Canvas

**Goal:** Moving the cursor over a line endpoint on a drawing shows the
yellow square snap indicator. Verified visually.

**Implement:** `buildIndex`, `resolveSnap` in store. Mouse move handler and
snap indicator drawing in `ViewerCanvas.tsx`. Snap indicator drawn on overlay
canvas.

**Verification:**
Open a drawing with visible lines. Move the cursor slowly toward the end of
a line.

Confirm:
- Yellow square appears near line endpoints
- Indicator disappears when cursor moves away
- Indicator updates in real time with no visible lag
- No console errors
- Tile rendering and pan/zoom still work normally

**Gate: do not proceed until the endpoint snap indicator is visually
confirmed on a real drawing.**

---

## MILESTONE 4 — All Three Snap Types Working

**Goal:** Endpoint, midpoint, and intersection snap all work correctly.
Priority resolution works — endpoint wins over midpoint when both are nearby.

**Implement:** Midpoint snap points added to index. Intersection detection
(`findIntersection`). Priority resolution in `resolveSnap`. Midpoint triangle
and intersection cross indicators on overlay canvas.

**Verification:**
On a drawing with rectangular geometry:

- Move cursor to corner of a rectangle → yellow square (endpoint)
- Move cursor to middle of a rectangle edge → yellow triangle (midpoint)
- Move cursor to where two lines cross → yellow cross (intersection)
- Move cursor to area where endpoint and midpoint are both within radius →
  endpoint indicator wins

Confirm all four behaviours before proceeding.

**Gate: do not proceed until all three snap types are confirmed on a real
drawing.**

---

## MILESTONE 5 — Performance Verified and Full Regression

**Goal:** Snap resolution stays within 8ms on a complex drawing. All Phase 1,
1.5, 1.6, and 1.7 functionality still works.

**Implement:** Performance measurement in `resolveSnap` using
`performance.now()`. Log to console during testing only — remove logging
before final build.

**Verification:**
Open the most complex A0/A1 drawing available. Open browser console.
Temporarily add timing:
```typescript
const t0 = performance.now();
// ... resolveSnap logic ...
const t1 = performance.now();
if (t1 - t0 > 8) console.warn(`Snap slow: ${(t1-t0).toFixed(1)}ms`);
```

Move cursor rapidly across the drawing. Confirm no `Snap slow` warnings appear.

Then full regression:
- Pan and zoom work, tiles render correctly
- Page navigation works
- Drawing register and dimension group trees work
- Project create, open, close all work
- No orphaned renderer processes
- Bundle identifier is `com.takeitoff.app`

Then run:
```powershell
cargo tauri build
```

Confirm MSI and NSIS installers produced.

**Gate: Phase 2 complete when all Definition of Done items confirmed.**

---

## Definition of Done

- [ ] Pre-flight: bundle identifier changed to `com.takeitoff.app`
- [ ] Milestone 1: vector extraction returns real primitives from renderer
- [ ] Milestone 2: `get_page_vectors` command works, frontend vector cache
      populated
- [ ] Milestone 3: endpoint snap indicator visible on real drawing
- [ ] Milestone 4: all three snap types work with correct priority resolution
- [ ] Milestone 5: snap resolution within 8ms on complex drawing
- [ ] Timing log removed before final build
- [ ] All Phase 1 through 1.7 functionality regression-tested
- [ ] No console errors
- [ ] `cargo tauri build` produces MSI and NSIS installers

---

## Out of Scope for Phase 2

Do not implement:
- Perpendicular snap
- Nearest-edge snap
- Arc or curve snap
- Snap to text or annotation objects
- Snap settings UI (radius adjustment etc.)
- Any measurement drawing tools
- Scale calibration
- Quantity calculation
- Any costing or reporting features
