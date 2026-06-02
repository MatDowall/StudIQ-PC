import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useAppStore, type SnapPoint, type SnapType } from "../store/appStore";

const TILE_SIZE = 512;

export interface PageMeta {
  index: number;
  width_pts: number;
  height_pts: number;
}

export interface DocumentMeta {
  path: string;
  page_count: number;
  pages: PageMeta[];
}

interface TileKey {
  page: number;
  zoom_level: number;
  tile_x: number;
  tile_y: number;
}

interface TileData {
  key: TileKey;
  image_path: string;
  x: number;
  y: number;
  generation: number;
}

interface PreviewData {
  page: number;
  width: number;
  height: number;
  image_path: string;
}

interface ViewportState {
  page_index: number;
  zoom: number;
  pan_x: number;
  pan_y: number;
  width: number;
  height: number;
}

export interface MeasurementDto {
  id: number;
  dimension_group_id: number;
  drawing_id: number;
  page_index: number;
  measurement_type: string;
  geometry_json: string;
  quantity: number | null;
  uom: string | null;
}

interface ViewerCanvasProps {
  doc: DocumentMeta | null;
  pageIndex: number;
  onStatusChange: (status: string) => void;
  overlayMeasurements?: MeasurementDto[];
  overlayColour?: string;
}

function zoomBucket(zoom: number) {
  if (zoom <= 0.3) return 0;
  if (zoom <= 0.6) return 1;
  if (zoom <= 1.25) return 2;
  if (zoom <= 2.5) return 3;
  return 4;
}

function bucketZoom(zoomLevel: number) {
  return Math.pow(2, zoomLevel - 2);
}

function tileId(key: TileKey) {
  return `${key.page}:${key.zoom_level}:${key.tile_x}:${key.tile_y}`;
}

function pagePixelSize(page: PageMeta, zoom: number) {
  return {
    width: Math.ceil((page.width_pts * zoom * 96) / 72),
    height: Math.ceil((page.height_pts * zoom * 96) / 72),
  };
}

function pageToScreen(
  ptX: number,
  ptY: number,
  pageHeightPts: number,
  pan: { x: number; y: number },
  zoom: number,
) {
  const scale = (zoom * 96) / 72;
  return {
    x: ptX * scale - pan.x,
    y: (pageHeightPts - ptY) * scale - pan.y,
  };
}

// Measurement geometry is stored in `geometry_json` as PDF points with a
// Y-up, bottom-left origin — the same convention the snap engine produces
// (see resolveSnap / scheduleSnapResolution). Render it through pageToScreen
// so overlays and snap indicators stay in the same coordinate space.
function drawOverlays(
  ctx: CanvasRenderingContext2D,
  measurements: MeasurementDto[],
  colour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  pageIndex: number,
) {
  const pageMeasurements = measurements.filter((measurement) => measurement.page_index === pageIndex);
  if (pageMeasurements.length === 0) return;

  ctx.fillStyle = `${colour}55`;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;

  for (const measurement of pageMeasurements) {
    let points: { x: number; y: number }[];
    try {
      points = JSON.parse(measurement.geometry_json);
    } catch {
      continue;
    }

    if (!Array.isArray(points) || points.length < 2) continue;

    const first = pageToScreen(points[0].x, points[0].y, page.height_pts, pan, zoom);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of points.slice(1)) {
      const screen = pageToScreen(point.x, point.y, page.height_pts, pan, zoom);
      ctx.lineTo(screen.x, screen.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  snapPoint: SnapPoint | null,
  snapType: SnapType | null,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
) {
  if (!snapPoint || !snapType) return;

  const screen = pageToScreen(snapPoint.x, snapPoint.y, page.height_pts, pan, zoom);
  ctx.save();
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;

  if (snapType === "endpoint") {
    ctx.strokeRect(screen.x - 5, screen.y - 5, 10, 10);
  } else if (snapType === "midpoint") {
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y - 5);
    ctx.lineTo(screen.x + 5, screen.y + 5);
    ctx.lineTo(screen.x - 5, screen.y + 5);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(screen.x - 5, screen.y - 5);
    ctx.lineTo(screen.x + 5, screen.y + 5);
    ctx.moveTo(screen.x + 5, screen.y - 5);
    ctx.lineTo(screen.x - 5, screen.y + 5);
    ctx.stroke();
  }

  ctx.restore();
}

export function ViewerCanvas({ doc, pageIndex, onStatusChange, overlayMeasurements = [], overlayColour = "#4A9EFF" }: ViewerCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [tiles, setTiles] = useState<Map<string, TileData>>(new Map());
  const [previews, setPreviews] = useState<Map<number, PreviewData>>(new Map());
  const [imageVersion, setImageVersion] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const loadingImagesRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  const latestSnapPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const snapPoint = useAppStore((state) => state.snapPoint);
  const snapType = useAppStore((state) => state.snapType);
  const loadVectors = useAppStore((state) => state.loadVectors);
  const resolveSnap = useAppStore((state) => state.resolveSnap);
  const clearSnap = useAppStore((state) => state.clearSnap);

  const page = doc?.pages[pageIndex] ?? null;
  const preview = previews.get(pageIndex) ?? null;
  const pageSize = useMemo(() => (page ? pagePixelSize(page, zoom) : { width: 0, height: 0 }), [page, zoom]);
  const activeZoomBucket = zoomBucket(zoom);

  const mergeTiles = useCallback((incoming: TileData[]) => {
    if (incoming.length === 0) return;
    setTiles((current) => {
      const next = new Map(current);
      for (const tile of incoming) {
        next.set(tileId(tile.key), tile);
      }
      return next;
    });
  }, []);

  const loadImage = useCallback((imagePath: string) => {
    if (imageCacheRef.current.has(imagePath) || loadingImagesRef.current.has(imagePath)) return;

    loadingImagesRef.current.add(imagePath);
    const image = new Image();
    image.onload = () => {
      imageCacheRef.current.set(imagePath, image);
      loadingImagesRef.current.delete(imagePath);
      setImageVersion((version) => version + 1);
    };
    image.onerror = () => {
      loadingImagesRef.current.delete(imagePath);
    };
    image.src = convertFileSrc(imagePath);
  }, []);

  useEffect(() => {
    setTiles(new Map());
    setPreviews(new Map());
    imageCacheRef.current.clear();
    loadingImagesRef.current.clear();
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [doc?.path]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    clearSnap();
  }, [pageIndex]);

  useEffect(() => {
    if (!doc || !page) {
      clearSnap();
      return;
    }

    let cancelled = false;
    loadVectors(pageIndex).catch((e) => {
      if (!cancelled) onStatusChange(`ERROR: ${e}`);
    });

    return () => {
      cancelled = true;
    };
  }, [clearSnap, doc, loadVectors, onStatusChange, page, pageIndex]);

  useEffect(() => {
    return () => {
      if (snapFrameRef.current !== null) {
        window.cancelAnimationFrame(snapFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateSize = () => {
      setViewportSize({
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    for (const previewData of previews.values()) {
      loadImage(previewData.image_path);
    }
    for (const tile of tiles.values()) {
      loadImage(tile.image_path);
    }
  }, [loadImage, previews, tiles]);

  useEffect(() => {
    if (!doc || previews.has(pageIndex)) return;

    let cancelled = false;
    onStatusChange(`Preparing page ${pageIndex + 1}`);
    invoke<PreviewData>("render_preview", { pageIndex })
      .then((previewData) => {
        if (cancelled) return;
        setPreviews((current) => {
          const next = new Map(current);
          next.set(pageIndex, previewData);
          return next;
        });
        onStatusChange(`Page ${pageIndex + 1} ready`);
      })
      .catch((e) => {
        if (!cancelled) onStatusChange(`ERROR: ${e}`);
      });

    return () => {
      cancelled = true;
    };
  }, [doc, onStatusChange, pageIndex, previews]);

  useEffect(() => {
    if (!doc || !page) return;

    const viewport: ViewportState = {
      page_index: pageIndex,
      zoom,
      pan_x: pan.x,
      pan_y: pan.y,
      width: viewportSize.width,
      height: viewportSize.height,
    };

    let cancelled = false;
    const timer = window.setTimeout(() => {
      invoke<TileData[]>("update_viewport", { viewport })
        .then((newTiles) => {
          if (!cancelled) mergeTiles(newTiles);
        })
        .catch((e) => {
          if (!cancelled) onStatusChange(`ERROR: ${e}`);
        });
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [doc, page, pageIndex, pan.x, pan.y, viewportSize.height, viewportSize.width, zoom, mergeTiles, onStatusChange]);

  useEffect(() => {
    if (!doc) return;

    const timer = window.setInterval(() => {
      invoke<TileData[]>("poll_tiles")
        .then((newTiles) => {
          mergeTiles(newTiles);
          if (newTiles.length > 0) onStatusChange("Rendered tiles");
        })
        .catch((e) => onStatusChange(`ERROR: ${e}`));
    }, 75);

    return () => window.clearInterval(timer);
  }, [doc, mergeTiles, onStatusChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = viewportSize.width;
    const height = viewportSize.height;
    const targetWidth = Math.max(1, Math.floor(width * dpr));
    const targetHeight = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#15171a";
    ctx.fillRect(0, 0, width, height);

    if (!doc || !page) {
      ctx.fillStyle = "#6f7682";
      ctx.font = "14px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Open a PDF to begin", width / 2, height / 2);
      return;
    }

    const pageLeft = -pan.x;
    const pageTop = -pan.y;
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(pageLeft, pageTop, pageSize.width, pageSize.height);
    ctx.strokeStyle = "#3c4048";
    ctx.strokeRect(pageLeft, pageTop, pageSize.width, pageSize.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pageLeft, pageTop, pageSize.width, pageSize.height);
    ctx.clip();

    if (preview?.page === pageIndex) {
      const previewImage = imageCacheRef.current.get(preview.image_path);
      if (previewImage) {
        ctx.drawImage(previewImage, pageLeft, pageTop, pageSize.width, pageSize.height);
      }
    }

    const pageTiles = Array.from(tiles.values())
      .filter((tile) => tile.key.page === pageIndex)
      .sort((a, b) => {
        const aDistance = Math.abs(a.key.zoom_level - activeZoomBucket);
        const bDistance = Math.abs(b.key.zoom_level - activeZoomBucket);
        if (aDistance !== bDistance) return bDistance - aDistance;
        return a.key.zoom_level - b.key.zoom_level;
      });

    for (const tile of pageTiles) {
      const image = imageCacheRef.current.get(tile.image_path);
      if (!image) continue;

      const scale = zoom / bucketZoom(tile.key.zoom_level);
      ctx.drawImage(
        image,
        pageLeft + tile.x * scale,
        pageTop + tile.y * scale,
        TILE_SIZE * scale,
        TILE_SIZE * scale,
      );
    }

    ctx.restore();
  }, [activeZoomBucket, doc, imageVersion, page, pageIndex, pageSize.height, pageSize.width, pan.x, pan.y, preview, tiles, viewportSize.height, viewportSize.width, zoom]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = viewportSize.width;
    const height = viewportSize.height;
    const targetWidth = Math.max(1, Math.floor(width * dpr));
    const targetHeight = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!doc || !page) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(-pan.x, -pan.y, pageSize.width, pageSize.height);
    ctx.clip();
    drawOverlays(ctx, overlayMeasurements, overlayColour, pan, zoom, page, pageIndex);
    drawSnapIndicator(ctx, snapPoint, snapType, pan, zoom, page);
    ctx.restore();
  }, [doc, overlayColour, overlayMeasurements, page, pageIndex, pageSize.height, pageSize.width, pan, snapPoint, snapType, viewportSize.height, viewportSize.width, zoom]);

  function clampPan(nextPan: { x: number; y: number }, nextZoom = zoom) {
    if (!page) return nextPan;
    const size = pagePixelSize(page, nextZoom);
    return {
      x: Math.max(0, Math.min(nextPan.x, Math.max(0, size.width - viewportSize.width))),
      y: Math.max(0, Math.min(nextPan.y, Math.max(0, size.height - viewportSize.height))),
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!doc) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    scheduleSnapResolution(event.clientX, event.clientY);

    const drag = dragRef.current;
    if (!drag) return;

    setPan(
      clampPan({
        x: drag.panX - (event.clientX - drag.startX),
        y: drag.panY - (event.clientY - drag.startY),
      }),
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  function scheduleSnapResolution(clientX: number, clientY: number) {
    latestSnapPointerRef.current = { clientX, clientY };
    if (snapFrameRef.current !== null) return;

    snapFrameRef.current = window.requestAnimationFrame(() => {
      snapFrameRef.current = null;
      const latest = latestSnapPointerRef.current;
      const element = viewportRef.current;
      if (!latest || !element || !doc || !page) {
        clearSnap();
        return;
      }

      const rect = element.getBoundingClientRect();
      const screenX = latest.clientX - rect.left;
      const screenY = latest.clientY - rect.top;
      const scale = (zoom * 96) / 72;
      const pagePtX = (screenX + pan.x) / scale;
      const pagePtY = page.height_pts - (screenY + pan.y) / scale;
      const radiusPts = 12 / scale;
      resolveSnap(pagePtX, pagePtY, pageIndex, radiusPts);
    });
  }

  function handleWheel(event: WheelEvent) {
    if (!doc || !page) return;
    event.preventDefault();

    const element = viewportRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const oldZoom = zoom;
    const nextZoom = Math.max(0.08, Math.min(8, oldZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const scale = nextZoom / oldZoom;
    const nextPan = {
      x: (pan.x + cursorX) * scale - cursorX,
      y: (pan.y + cursorY) * scale - cursorY,
    };

    setZoom(nextZoom);
    setPan(clampPan(nextPan, nextZoom));
  }

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  });

  return (
    <div
      ref={viewportRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={clearSnap}
      style={{
        flex: 1,
        position: "relative",
        minHeight: 0,
        overflow: "hidden",
        cursor: doc ? (dragRef.current ? "grabbing" : "grab") : "default",
        background: "#15171a",
        touchAction: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <canvas
        ref={overlayCanvasRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
