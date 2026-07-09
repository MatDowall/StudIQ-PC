# PDF Rendering Performance Review

*Date: 2026-07-09 · Scope: review + research only, no code changes yet.*

Continuous-improvement target: reduce the visible delay between panning/zooming and tiles
appearing. This report reviews the current pipeline end-to-end, quantifies where the time
goes, and proposes a phased fix plan.

---

## 1. Executive summary

The tile pipeline is architecturally sound (tiles, zoom buckets, prefetch ring, priority
queue, LRU, stale-tile generations), but **each individual tile is enormously more expensive
than it needs to be**, and the delivery path from renderer to screen adds ~100–150 ms of
fixed latency per tile on top. The two dominant costs, both inside
`core/src/bin/pdf_renderer.rs`:

1. **Every tile re-opens and re-parses the PDF from disk** (`load_pdf_from_file` per
   request). For dense architectural sheets this is typically tens to hundreds of ms —
   *per 512×512 tile*.
2. **Every tile allocates, clears and double-copies a full-page-sized bitmap.** At zoom
   bucket 4 (384 DPI) an A1 sheet is ~12,700×9,000 px → a **~460 MB** RGBA buffer is
   allocated and cleared, then copied *twice* (raw copy + BGRA→RGBA conversion) — roughly
   **2.3 GB of memory traffic to produce one 1 MB tile**. Cost grows quadratically with
   zoom, which is exactly when users are doing takeoff work.

Fixing those two (renderer-internal, no protocol change) should take per-tile cost from
~100–400 ms down to **~5–20 ms regardless of zoom**. A second phase removes the
PNG-encode → disk → 75 ms poll → asset-fetch → PNG-decode delivery chain. Together these
should make pan/zoom feel near-instant without changing the app's architecture.

A separate quality target (F8 / Phase R5): the settled image is never pixel-exact —
zoom-bucket quantization plus uncompensated Windows display scaling means linework is
always fractionally resampled, which is why it reads as "a raster" next to Bluebeam Revu.
Revu's settled crispness is not vector display; it re-rasterizes the visible viewport at
exact screen resolution once interaction stops. A "settle pass" replicates that exactly
and becomes cheap once the R1 renderer fixes land.

---

## 2. How the pipeline works today

```
pointermove/wheel → React state (pan/zoom)
  → 30 ms debounce → invoke update_viewport            (ViewerCanvas.tsx:1617)
    → compute visible tiles, centre-out order          (viewport/state.rs:18)
    → enqueue TileRenderJobs → single worker           (lib.rs:1057)
      → Mutex<RendererService>.request() — serialized  (lib.rs:102)
        → pdf_renderer.exe: open PDF, render full-page
          bitmap with clip, crop 512², PNG → disk      (pdf_renderer.rs:153)
    → complete_render → completion channel
  ← poll_tiles every 75 ms                             (ViewerCanvas.tsx:1646)
  ← new Image() + convertFileSrc (asset protocol,
    disk read, PNG decode)                             (ViewerCanvas.tsx:1512)
  → setImageVersion → React re-render → canvas redraw  (ViewerCanvas.tsx:1661)
```

Zoom buckets: 0–4, DPI = 96 × 2^(bucket−2) → 24/48/96/192/384 DPI
(`tile_manager.rs:100`). UI zoom is clamped to 0.08–8, so above zoom 4 tiles are upscaled.

### Per-tile cost breakdown (A1 sheet, 2384×1684 pts)

| Step | Bucket 2 (96 DPI) | Bucket 4 (384 DPI) |
|---|---|---|
| `load_pdf_from_file` + page load (re-parse content stream) | 20–200 ms (content-dependent) | same |
| Full-page bitmap alloc + `FPDFBitmap_FillRect` clear | 28.5 MB | 457 MB |
| PDFium raster (clip-bounded — OK) | ~5–15 ms | ~5–20 ms |
| `as_rgba_bytes()`: full-buffer copy **+** BGRA→RGBA second copy | ~57 MB traffic | ~914 MB traffic |
| Row-copy crop to 512² | ~1 MB | ~1 MB |
| PNG encode (`image` crate, default zlib) + disk write | ~5–15 ms | ~5–15 ms |
| poll_tiles latency (avg) | ~37 ms | ~37 ms |
| Asset-protocol fetch + PNG decode + React round trip | ~10–25 ms | ~10–25 ms |

At bucket 4 the memory traffic alone is ~200–300 ms per tile; a fresh viewport needs
12–35 tiles **serialized through one worker**, so multi-second fill-in matches what's
observed. At bucket ≤2 the same overheads exist but are small enough that the system
feels "not terrible" — which is exactly the reported behaviour.

---

## 3. Findings (ranked)

### F1 — Full-page bitmap per tile (critical) — `pdf_renderer.rs:153-229`
`PdfRenderConfig::set_target_size(page_w, page_h).clip(...)` allocates the bitmap at
**full page size** (verified in pdfium-render 0.8.37 source: `render_with_config` creates
the bitmap from `settings.width/height`, which the clip does not reduce; the clip only
bounds rasterization). Then `as_rgba_bytes()` copies the *entire* buffer
(`FPDFBitmap_GetBuffer_as_vec`) and converts BGRA→RGBA into a second full-size buffer.
Cost scales with page area × zoom², not tile size.

**Fix:** render directly into a 512×512 bitmap using a transform matrix
(`FPDF_RenderPageBitmapWithMatrix`: matrix = scale + translate(−tile offset), clip =
0,0,512,512 in device space). pdfium-render supports this via
`set_fixed_size(512,512)` + `.transform(...)` + `.clip(...)` (custom matrices are honoured
whenever form-data rendering is off, which `.clip()` already forces); if the config
plumbing fights, ~30 lines of raw `pdfium.bindings()` calls do it directly. Also set
`set_reverse_byte_order(true)` so PDFium emits RGBA order and the conversion pass
disappears.

### F2 — Document re-opened per tile (critical) — `pdf_renderer.rs:165`
`load_pdf_from_file` per request; PDFium re-parses the page content stream into its
display list every time (`FPDF_LoadPage`). For heavy tender drawings this is routinely the
largest single cost, and it is paid ~30× per screenful.

**Fix:** cache the open `PdfDocument` (and last-used `PdfPage`) in the renderer process,
keyed by path. The borrow-lifetime knot is cleanly solved by leaking the `Pdfium` instance
once at startup (`Box::leak` → `&'static Pdfium`), making `PdfDocument<'static>` storable
in a `HashMap`. Invalidate on `meta` for a new path / file mtime change. Tile bursts hit
the same page, so a one-entry page cache captures ~100% of them.

### F3 — Delivery chain: PNG → disk → poll → asset fetch → decode (high)
- PNG encode at default compression (`pdf_renderer.rs:214`), write to cache dir.
- Frontend polls `poll_tiles` every **75 ms** (`ViewerCanvas.tsx:1646`) — average +37 ms,
  worst +75 ms, per batch.
- Loads via `convertFileSrc` (asset protocol → disk read → PNG decode on the main thread).

**Fix (preferred):** keep completed tiles in RAM in the desktop process and deliver
without disk or codecs:
- Renderer → desktop: length-prefixed raw-RGBA frames on stdout (JSON header line +
  N raw bytes), or a shared-memory mapping. 1 MB/tile is trivial for a pipe.
- Desktop → frontend: two good options on Windows/WebView2:
  a) **Custom URI scheme** (`tile://g/p/z/x/y`) registered with
     `register_uri_scheme_protocol`, serving bytes from the in-memory store. This is
     Tauri's fast path (the v2 IPC rewrite itself rides custom protocols; ~150 MB served
     in <60 ms). Frontend keeps using image URLs — smallest diff.
  b) **Binary IPC**: push completion via a Tauri `Channel`/event, then `invoke` returning
     `tauri::ipc::Response(bytes)` → `ImageData` → `createImageBitmap`. No polling at all.
- Either way: replace the 75 ms poll with an event/channel push, and decode with
  `createImageBitmap` (off-main-thread) instead of `new Image()`.

### F4 — Generation invalidation discards valid work (medium) — `lib.rs:961-969`
`advance_generation()` fires on every (page, zoom-bucket) change. In-flight renders for
the old context are thrown away on completion (`tile_manager.rs:112`) even though a
`TileKey` (page, zoom, x, y) fully determines pixel content — the result is still valid
cache material. Crossing a bucket boundary while zooming (very common: wheel zoom passes
through buckets) wastes every in-flight tile and re-renders on the way back.

**Fix:** advance the generation **only on document change** (that's what actually
invalidates content — `open_document` also wipes the cache dir). Keep batch priority for
scheduling, but let stale-generation completions still be inserted into the LRU.

### F5 — Backend LRU too small for high buckets (medium) — `tile_manager.rs:13`
`MAX_CACHED_TILES = 256`, but one A1 page at bucket 4 is ~25×18 = **450 tiles**. Panning
across a sheet at high zoom evicts tiles behind you; returning re-renders them. Entries
are just paths (bytes), so the limit is arbitrary.

**Fix:** raise to a few thousand and cap the actual store (disk or RAM) by size instead
(e.g. 1–2 GB of raw tiles ≈ 1–2 k tiles).

### F6 — One renderer, one worker; vectors/preview block tiles (medium) — `lib.rs:102,894,932`
`RendererService::request` is synchronous behind a global `Mutex`. `get_page_vectors`
(snap engine, fired on every page open — `ViewerCanvas.tsx:1543`) and `render_preview`
queue behind, and block, tile renders. On a dense sheet, vector extraction can stall the
tile pipeline for seconds right when the user starts panning.

**Fix:** PDFium is explicitly not thread-safe (pdfium-render's `thread_safe` feature just
serializes calls), so the existing out-of-process design is the *correct* skeleton for
parallelism: spawn a small pool (2–4) of `pdf_renderer.exe` workers and shard jobs across
them; dedicate one to non-tile ops (meta/preview/vectors). After F1+F2, one process may
already be fast enough — make the pool size a config knob and tune empirically.

### F7 — Frontend housekeeping (low, cumulative)
- `tiles` map and `imageCacheRef` grow unboundedly per document
  (`ViewerCanvas.tsx:1182,1512-1526`); every redraw sorts and draws **all** tiles ever
  received for the page, including offscreen and fully-covered stale-bucket tiles
  (`ViewerCanvas.tsx:1712-1733`). After a long session this costs sort time, draw fill
  rate, and hundreds of MB of decoded images.
  **Fix:** cull offscreen tiles when drawing; skip stale-bucket tiles fully covered by
  active-bucket tiles; evict cache entries far from the current viewport/bucket.
- 30 ms debounce before `update_viewport` (`ViewerCanvas.tsx:1638`) adds fixed latency to
  every gesture. Fire the first request immediately, then throttle to rAF cadence.
- `handleWheel` listener re-subscribes on every render (effect with no dep array,
  `ViewerCanvas.tsx:3297-3303`) — harmless but untidy.
- Preview underlay is max 1200 px (`lib.rs:928`); on an A1 sheet at zoom 1 it's upscaled
  ~2.6× and looks smeared until tiles land. After F2 a ~2400–3000 px preview is nearly
  free and markedly improves perceived quality during fill-in.

### F8 — Settled view is never pixel-exact — no "settle pass" (high, quality)
Benchmark: Bluebeam Revu. During interaction Revu shows the previous raster scaled
(blurry) — identical to our stale-tile layer. But when interaction stops it
**re-rasterizes the visible viewport at exactly the current zoom × physical screen
resolution**, which is why its settled output looks "vector crisp." Its screen output is
still a raster; the crispness comes from 1:1 device-pixel rendering. Our app never
produces that image, for three compounding reasons:

1. **Zoom buckets quantize render DPI** (24/48/96/192/384). Tiles are pixel-exact only at
   zoom 0.25/0.5/1/2/4; at every other zoom the canvas rescales them fractionally (up to
   ~1.4×) with bilinear smoothing (`ViewerCanvas.tsx:1725-1732`). Fractionally resampled
   1 px CAD linework is exactly the "clearly a raster" look.
2. **`devicePixelRatio` is never compensated.** The canvas backing store is dpr-scaled
   (`ViewerCanvas.tsx:1665-1679`) but tiles are rasterized at CSS-pixel DPI, so on a
   125 %/150 % Windows display everything is additionally upscaled 1.25–1.5× — soft even
   at exact bucket zooms.
3. **Nothing ever re-renders at true screen resolution** — bucket tiles are the final image.

**Fix — settle pass (see Phase R5):** ~150–250 ms after the last pan/zoom input, issue one
render of the visible viewport only, at exact `zoom × dpr` DPI, and composite it above the
tile layer; discard it on the next input. A 1920×1080 viewport at 150 % scaling is a
~2880×1620 bitmap (~18 MB) — *smaller than the full-page bitmap the current code allocates
per 512 px tile* — and after R1 costs one ~20–80 ms render. Not cached (keyed by exact
zoom+pan, so never reused); the bucket-tile layer remains the interactive/stale underlay,
which already matches Revu's during-interaction behaviour. Prerequisite: R1 (with today's
per-request document re-parse + full-page allocation, a settle render would cost 100 ms+
of avoidable overhead every time the user pauses).

### F8b — Cosmetic
- `render_tile` hardcodes `zoom_level: 0` in its response key (`pdf_renderer.rs:220`);
  the desktop reconstructs the key itself so it's harmless, but it's a trap.
- `update_viewport` calls `drain_completed()` and discards the result (`lib.rs:984`) —
  works (tiles land in cache and surface later) but subtle.

---

## 4. Proposed plan (phased, in priority order)

### Phase R1 — Renderer-internal fixes *(highest impact; no protocol change; ~1 day)*
**Status: IMPLEMENTED 2026-07-09.** Awaiting in-app sign-off.

1. Document + page cache in `pdf_renderer` (F2). Implemented as raw-handle cache
   (`DocCache`): documents loaded once via `FPDF_LoadMemDocument64` (backing bytes held
   in RAM — no per-tile disk I/O and no file lock on the source PDF), pages kept open
   across requests. Bounded: 2 documents × 3 pages. `meta` (the app's document-open
   signal) re-checks the file fingerprint (length + mtime) and drops a stale entry, so a
   replaced drawing file is picked up without restarting the renderer.
2. Matrix-based direct-to-512×512 rendering (F1): `FPDF_RenderPageBitmapWithMatrix` with
   matrix `[s 0 0 s −tx −ty]` into a tile-sized bitmap, flags `FPDF_ANNOT |
   FPDF_REVERSE_BYTE_ORDER` (identical to the old path's effective flags). Per-tile
   timing (`page_load_ms`/`render_ms`/`encode_ms`) is now reported in the tile response
   and printed to stderr when `TILE_TIMING` is set.
3. Verification (2_1 – 3 Floor Plans.pdf, 13 tiles per DPI, old vs new binary driven
   directly over the stdin/stdout protocol):

   | | old | new |
   |---|---|---|
   | 96 DPI per tile | 54.7 ms mean | **9.1 ms mean / 4.8 ms median** (first tile 50 ms = one-off document parse) |
   | 384 DPI per tile | 99.5 ms mean | **4.3 ms mean** |

   Warm-tile speedup ~12× at 96 DPI, ~23× at 384 DPI on this (modest, sub-A1) sheet; the
   old path degrades with page size × zoom² while the new path is flat, so the gap is
   larger on A1 tender sheets at deep zoom. Output verified pixel-equivalent: visual
   comparison identical; remaining byte-level diffs are sub-pixel AA jitter because the
   old path rendered at `ceil(page_px)/page_pts` scale while the new path uses exact
   `dpi/72` — the scale the frontend's tile-grid math assumes, so alignment is now
   marginally *more* correct.

**Expected outcome:** per-tile cost roughly 10–50× better at high zoom; the existing
pipeline (PNG, poll) becomes the remaining bottleneck but the app should already feel
dramatically snappier.

### Phase R2 — Delivery: RAM + push instead of disk + poll *(~1–2 days)*
**Status: IMPLEMENTED 2026-07-09.** Awaiting in-app sign-off.

1. Framed binary transport renderer → desktop: tile responses carry a `bin` byte count on
   the JSON line, followed by the raw PNG bytes on stdout. (PNG kept over raw RGBA —
   encode is ~1 ms and it keeps store memory at ~50 KB/tile instead of 1 MB/tile.)
   Tiles no longer touch disk at any point; page previews still use the old file path.
2. In-memory `TileStore` (LRU, 512 entries ≈ ~27 MB for line art) in the desktop process,
   served to the webview via a custom `tile` URI scheme
   (`http://tile.localhost/<key>` under WebView2) with `Access-Control-Allow-Origin: *`.
   `update_viewport` re-queues any metadata-cache hit whose bytes were evicted from the
   store, so the two caches cannot serve dead references.
3. `poll_tiles` (75 ms interval) deleted. The tile worker pushes a `tile-rendered` Tauri
   event per completed tile; the frontend coalesces bursts with requestAnimationFrame
   (one merge/redraw per frame) and decodes with `createImageBitmap` (off-main-thread;
   bitmaps are `close()`d on document switch). The completion channel in `TileManager`
   was removed outright.
4. Verification (binary-framing-aware harness): protocol round-trips cleanly; median
   tile 3.3 ms at 96 DPI / 3.5 ms at 384 DPI (slightly better than R1 — no disk write);
   all 25 unique tiles byte-identical to the R1 output. Delivery latency drops from
   up-to-75 ms poll + disk round-trip + `<img>` decode to event push + in-memory fetch +
   async decode (~1–2 frames).

### Phase R3 — Cache & scheduling policy *(~1 day)*
**Status: IMPLEMENTED 2026-07-09.** Awaiting in-app sign-off.

1. Generation advances only on document change (F4). Removed the `render_context`
   page/zoom-bucket tracking that used to call `advance_generation()` on every page
   switch and zoom-bucket crossing; a `TileKey` already fully encodes
   `(page, zoom_level, x, y)`, so that content is never actually invalidated by
   switching page or crossing a bucket edge — it was discarding valid in-flight and
   cached work on a very common gesture (wheel-zooming through a bucket boundary).
   Generation now only advances via `tile_manager.clear()`, called from `open_document`
   and `close_project`.
2. Caches resized (F5): `TileManager` metadata LRU raised 256 → 4096 entries (cheap —
   a key + a few ints + a short string per entry; an A1 sheet at the top zoom bucket
   alone is ~450 tiles). `TileStore` (the actual PNG bytes) switched from a fixed
   512-entry cap to a **200 MB byte-budget** LRU, since tile size varies ~5×
   (sparse vs. dense linework) so a fixed count either wastes memory or evicts too
   early depending on drawing content.
3. Stale pending-job drop: `update_viewport` now publishes the current batch's visible
   `TileKey` set to shared state; the tile worker checks a popped job against it before
   spending a render, and drops (rather than renders) any tile the user has since panned
   away from. Previously such jobs sat at low priority and eventually rendered anyway —
   wasted work, not a correctness issue, but real render-worker time.
4. Frontend (F7), all in `ViewerCanvas.tsx`:
   - **Draw-loop offscreen culling**: tiles whose screen footprint doesn't intersect the
     viewport are skipped before `drawImage`.
   - **Covered-stale-tile skip**: a stale (non-active-bucket) tile fully hidden behind
     already-loaded active-bucket tiles is skipped — it's fully occluded either way, so
     this is a pure draw-call reduction. Coverage is computed with exact integer grid
     arithmetic (tile_x/tile_y are already grid indices, and every zoom bucket's pixel
     grid is a power-of-two subdivision of the same page origin), so there's no
     floating-point edge case that could produce a visible gap.
   - **Tile cache eviction**: the `tiles` map (each entry keeps a ~1 MB uncompressed
     `ImageBitmap` alive regardless of PNG size) is capped at 800 entries; over the cap,
     entries for other pages or zoom buckets more than 1 away from the active one are
     evicted first (bitmaps `close()`d), via refs so the stable tile-event listener
     doesn't need to resubscribe on every pan/zoom.
5. Verification: renderer output re-benchmarked and diffed against R2 — all 25 sample
   tiles byte-identical (confirms R3 touched only caching/scheduling/draw code, not
   pixels); backend and frontend both build clean (`cargo build --release`, `tsc
   --noEmit`).

   **Bug caught by launch verification, fixed before sign-off:** the first `TileStore`
   implementation passed `u32::MAX` as the `LruCache::new()` capacity to mean
   "effectively unbounded, `insert` enforces the real byte budget." `lru` 0.12's
   `new(cap)` pre-reserves `HashMap::with_capacity(cap)`, so this tried to allocate room
   for ~4.3 billion entries on first use and crashed the app on launch (`memory
   allocation of 146028888080 bytes failed`, STATUS_STACK_BUFFER_OVERRUN). Fixed by
   switching to `LruCache::unbounded()`, which skips the pre-reservation and matches the
   intent (entry count is unbounded; `insert` still evicts on the 200 MB byte budget).
   Relaunched clean — this is exactly why R1–R3 are gated on an in-app run before
   sign-off rather than build success alone.

### Phase R4 — Parallelism & polish *(incremental, after measuring R1–R3)*
**Status: IMPLEMENTED 2026-07-09** (items 1–3, 5; item 4 deliberately deferred — see
below). Awaiting in-app sign-off.

1. **Renderer process pool (F6).** `state.renderer` (meta/preview/vectors) stays a
   single dedicated process, unchanged. Tiles now go through
   `state.tile_renderer_pool` — 3 processes by default (`TILE_RENDERER_POOL_SIZE` env
   var to tune without a rebuild). The dispatcher in `run_tile_render_worker` stays a
   single consumer of the job channel (so the existing dedup/priority queue logic keeps
   working on one coherent view of pending work), but each render is now
   `tauri::async_runtime::spawn`-ed against a round-robin pool slot instead of awaited
   inline — the dispatcher moves on to the next job immediately rather than blocking the
   whole pipeline behind one render. Concurrency is naturally capped at the pool size,
   since jobs landing on the same slot still serialize on that slot's mutex. This is
   also what actually fixes vectors/preview stalling tiles (F6's second half): those
   commands were already routed through the separate `state.renderer` handle before this
   phase, but R1's per-process document cache means they now benefit from the same
   caching as tiles without contending with them.
2. **Zoom bucket 5, 768 DPI (F-none, new).** Added a 6th bucket (0–5) so zoom levels
   above ~2.5–5× render natively instead of upscaling a 384 DPI tile. Threshold (5.0)
   follows the existing pattern (each bucket's cutover sits at ~1.25× its own native
   zoom). Changed identically in both authoritative copies —
   `core/src/viewport/state.rs::zoom_bucket` (backend) and
   `ViewerCanvas.tsx::zoomBucket` (frontend, used for draw-side sorting/coverage) — the
   two have always been parallel implementations, not a shared crate.
3. **Bigger preview underlay**: 1200 px → 2400 px `max_dim`. Affordable now — R1 already
   sped up the underlying per-call reparse for every preview render, this just spends
   more of that budget on resolution.
4. **Prefetch ring widened, not direction-weighted.** `TILE_PREFETCH_RADIUS` 1 → 2 (one
   line, `core/src/viewport/state.rs`). **Deliberately did not implement** idle
   adjacent-bucket prefetch or velocity-weighted directional prefetch: both need state
   this codebase doesn't track yet (pan velocity/history, idle-timer coordination with
   the generation/visible-set invalidation model from R3) and the report itself flagged
   this as the most speculative item in R4. Building it without that design work risks
   wasted background renders for uncertain payoff — flagging as a candidate follow-up
   rather than rushing it into this pass.
5. **Debounce → immediate-then-throttle.** The old code was a pure debounce
   (`setTimeout(fn, 30)`, reset on every pan/zoom state change) — during a fast drag,
   `pan`/`zoom` change on nearly every pointermove, so the timer kept getting cancelled
   and `update_viewport` was never actually invoked until the user let go. All fill-in
   landed in one visible burst at release. Replaced with fire-immediately-if-the-16ms-
   window-has-elapsed, else schedule one trailing call for the final state — tiles now
   stream in during the gesture instead of only after it.

Verification: renderer output re-diffed against R3 — all 25 sample tiles at existing
DPIs (96/384) byte-identical, confirming the pool/threshold changes didn't touch
pixels. New bucket-5 path tested directly: 9 tiles at 768 DPI rendered correctly across
3 concurrent processes (simulating the pool), valid PNGs, visually confirmed crisp at
that zoom depth. Backend and frontend both build clean in release
(`cargo build --release` for `core`+`desktop`, `tsc --noEmit`).

### Phase R5 — Bluebeam-parity settle pass *(~0.5–1 day; requires R1, ideally R2)*
**Status: IMPLEMENTED 2026-07-10.** Awaiting in-app sign-off — this is the final phase;
per the release-gating decision, the overhaul ships as one release once this is signed
off.

Goal: settled view is pixel-identical to Bluebeam Revu's — crisp, device-native raster.

1. New renderer command `view` (`pdf_renderer.rs`): generalises the R1 tile path
   (matrix + clip into a bitmap of the target size) from a fixed 512² tile to an
   arbitrary crop size at a continuous, non-bucketed DPI. Reuses the R1 `DocCache`, so
   it's cheap once the page is already warm from tile rendering. Not cached
   server-side — the caller invalidates on the next pan/zoom, so there's nothing to key
   a cache on.
2. Backend command `render_settle_view` computes the exact device-pixel crop of the
   page for the current viewport (`dpi = 96 × zoom × devicePixelRatio`, crop clamped to
   the page's own pixel bounds at that DPI — returns `None` if the page isn't visible
   at all) and routes the render through the R4 tile pool (not the dedicated
   meta/preview/vectors renderer, so it never contends with vector extraction on page
   open). Result lands in a new single-slot `SettleStore` (deliberately not folded into
   `TileStore` — a settle image is short-lived and needs guaranteed delivery, whereas
   `TileStore`'s LRU could evict it under tile churn or vice versa), served over a new
   `settle://` URI scheme mirroring the `tile://` one from R2.
3. Frontend (`ViewerCanvas.tsx`): 200 ms after pan/zoom/page settles, fetches the
   settle image and decodes it with `createImageBitmap`. Drawn with an **identity (1:1
   device-pixel) transform**, not the dpr-scaled CSS-pixel transform the rest of the
   draw effect uses — that resampling is exactly what makes the tile layer read as "a
   raster" at non-bucket-exact zooms or fractional Windows scaling. The page-rect clip
   established earlier in the same effect is already in device-space, so it still
   applies correctly under the identity transform without re-establishing it.
   Invalidation is comparison-based, not an explicit clear: the settle image is only
   drawn when its stored `(page, zoom, panX, panY, dpr)` exactly matches the *current*
   viewport, checked at draw time; any pan/zoom/page change makes an old settle image
   stop matching automatically, falling back to the tile layer until a fresh one lands
   — matching Revu's "blurry during interaction, crisp once settled" behaviour without
   needing a separate "clear settle state" effect.
4. Implemented the plan's "skip when bucket-exact and dpr = 1" optimisation (the tile
   layer is already pixel-exact there — notably the common case of a freshly opened
   page at zoom 1, 100% Windows scaling). **Did not** implement the other two "optional
   follow-ups" (`imageSmoothingQuality` tuning, debounce-free re-fire on wheel-zoom
   end) — genuinely cosmetic polish with no correctness stakes; left for a future pass
   if the base settle pass isn't itself sufficient.
5. Verification: direct protocol-level test of the `view` command with a realistic
   150% dpr / zoom 1.7 viewport crop (1920×1200 px, the exact scenario from the
   Bluebeam screenshots) — 30 ms warm-cache round trip (target was <100 ms), output
   visually confirmed crisp and correctly positioned against the source drawing.
   Backend and frontend both build clean in release.

   **Design note on why this can't accidentally regress interactive performance:**
   the settle pass is purely additive — it's a new command, a new store, a new draw
   call gated by an exact-match check. Nothing about R1–R4's tile pipeline was
   modified to add it, so a bug in the settle path degrades at worst to "no crisp
   settle image, tile layer shows instead" (i.e. today's R4 behaviour), never to a
   broken tile pipeline.

---

## 5. Alternatives considered, not recommended

| Option | Verdict |
|---|---|
| In-process PDFium (drop the child process) | Loses crash isolation (malformed tender PDFs do crash PDFium); stdio hop is not a bottleneck once R1/R2 land; out-of-process is also the only route to true parallelism. Keep the current architecture. |
| pdf.js in the webview (no IPC at all) | Slower than PDFium on huge vector sheets; loses fidelity parity with the existing vector/snap extraction. |
| MuPDF | Technically excellent, but AGPL — commercial licence required. |
| Skia/GPU PDFium build | Custom-build maintenance burden; AGG raster of line art is not the bottleneck. |
| Vector-first GPU renderer | Whole-app rewrite territory. However, a cheap hybrid is available later: the snap engine already holds extracted lines/rects client-side — drawing them as an instant "wireframe" underlay while raster tiles load would mask latency almost entirely. Optional garnish after R2. |

## 6. Sources

- pdfium-render 0.8.37 source (local cargo registry): `render_with_config` bitmap sizing,
  `clip()`/matrix interaction, `as_rgba_bytes()` double copy.
- [Tauri IPC — Calling Rust](https://v2.tauri.app/develop/calling-rust/) — `tauri::ipc::Response`, channels.
- [Tauri IPC improvements discussion #5690](https://github.com/tauri-apps/tauri/discussions/5690) and
  [discussion #5511](https://github.com/tauri-apps/tauri/discussions/5511) — custom-protocol fast path
  (150 MB in <60 ms after the v2 IPC rewrite, [PR #7170](https://github.com/tauri-apps/tauri/pull/7170)).
- [PDFium fpdfview.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h) —
  `FPDF_RenderPageBitmapWithMatrix` semantics (device-space clip, matrix render).
- [pdfium-render README](https://github.com/ajrcarey/pdfium-render) and
  [issue #20](https://github.com/ajrcarey/pdfium-render/issues/20) — PDFium thread-unsafety;
  `thread_safe` feature is a global mutex; authors recommend process-level parallelism.
