import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { GroupProps } from "../lib/quantity";
import type { OpeningTemplate } from "../lib/framing";

export type DimensionGroupPropsDto = GroupProps;

export interface TreeNodeDto {
  id: number;
  tree: string;
  node_type: "folder" | "drawing" | "drawing_page" | "dimension_group";
  parent_id: number | null;
  name: string;
  sort_order: number;
  has_children: boolean;
  file_path: string | null;
  page_count: number | null;
  uom: string | null;
  colour: string | null;
  // Framing size (e.g. "90x45") for timber-framing groups; null otherwise. Lets the tree row
  // show the size without loading the group's props.
  framing_size: string | null;
  // measurement_type from dimension_group_props; null for non-dimension-group nodes.
  measurement_type: string | null;
}

export interface MeasurementDto {
  id: number;
  dimension_group_id: number;
  drawing_id: number;
  page_index: number;
  measurement_type: string;
  geometry_json: string;
  polarity: number;
  quantity: number | null;
  uom: string | null;
  // Per-wall timber-framing extras (door/window openings, raking, manual studs) as JSON; null
  // for non-framing measurements. Parsed via lib/framing.ts.
  framing_json: string | null;
}

export interface PageScaleDto {
  drawing_id: number;
  page_index: number;
  mm_per_point: number;
  unit: string;
}

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

export interface ProjectMeta {
  name: string;
  client: string;
  contract_number: string;
  status: string;
  file_path: string;
  created_at: string;
  last_opened_at: string;
}

export interface RecentProject {
  name: string;
  client: string;
  contract_number: string;
  status: string;
  file_path: string;
  last_opened_at: string;
  file_exists: boolean;
}

export interface WorkbookRevisionDto {
  id: number;
  workbook_id: number;
  name: string;
  created_at: string;
  sort_order: number;
}

export interface WorkbookDto {
  id: number;
  name: string;
  revisions: WorkbookRevisionDto[];
}

// Snapshot of the active cell's text format — drives the Format toolbar's
// font/size selects and the pressed state of its toggle buttons.
export interface WorkbookFormatSnapshot {
  enabled: boolean;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right";
  decimals: number;
}

// Imperative bridge: WorkbookView registers these so the ribbon's Format
// toolbar can apply formatting to the grid's current selection.
export interface WorkbookFormatApi {
  setFontFamily: (family: string) => void;
  setFontSize: (size: number) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  setAlign: (align: "left" | "center" | "right") => void;
  adjustDecimals: (delta: number) => void;
}

export const DEFAULT_WORKBOOK_FORMAT: WorkbookFormatSnapshot = {
  enabled: false,
  fontFamily: "Arial",
  fontSize: 9,
  bold: false,
  italic: false,
  underline: false,
  align: "left",
  decimals: 2,
};

export interface TemplateDto {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  revision_id: number;
}

export interface TemplateEditMode {
  templateId: number;
  revisionId: number;
  name: string;
}

export interface VectorPrimitive {
  type: "line" | "rect";
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PageVectors {
  page: number;
  primitives: VectorPrimitive[];
}

/** A destination folder for the copy dialog: id plus its full `/`-joined path. */
export interface FolderOption {
  id: number;
  path: string;
}

/** Ribbon-triggered actions handled by the dimension-group pane (which owns the dialogs). */
export type DgPaneCommand = "add" | "properties" | "copy";

export type SnapType = "endpoint" | "midpoint" | "intersection";

/** Viewer interaction mode: place new dimensions, or select/edit existing ones. */
export type ViewerMode = "add" | "select";

export interface SnapPoint {
  x: number;
  y: number;
}

interface IndexedSnapPoint extends SnapPoint {
  type: SnapType;
}

interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface IndexedPrimitive {
  primitive: VectorPrimitive;
  snapPoints: IndexedSnapPoint[];
  segments: LineSegment[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface AppStore {
  activeProject: ProjectMeta | null;
  recentProjects: RecentProject[];

  /** Which top-level workflow tab is active. */
  activeTab: "dimensions" | "workbook";
  setActiveTab: (tab: "dimensions" | "workbook") => void;

  drawingRoots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;
  treeRevision: number;
  activeDrawingId: number | null;
  activePageIndex: number;
  activePageNodeId: number | null;
  currentDocument: DocumentMeta | null;
  vectorCache: Record<number, VectorPrimitive[]>;
  vectorIndex: Record<number, IndexedPrimitive[]>;
  snapPoint: SnapPoint | null;
  snapType: SnapType | null;
  snapEnabled: boolean;
  // "point" = click-to-place vertices (default); "line" = auto-detect wall segment on hover.
  drawingType: "point" | "line";
  // Live proposed measurement for line mode: the detected wall extended to its intersections.
  lineSnapResult: { start: SnapPoint; end: SnapPoint } | null;

  dimensionRoots: TreeNodeDto[];
  // The "active" group is where new dimensions are added (the primary selection).
  activeDimensionGroupId: number | null;
  // All selected groups render concurrently (CostX Ctrl-click multi-select).
  selectedGroupIds: number[];
  groupColours: Record<number, string>;
  activeBreadcrumb: string;
  overlayMeasurements: MeasurementDto[];
  overlayColour: string;
  // "add" = click to place new dimensions; "select" = pick/edit/delete existing ones.
  viewerMode: ViewerMode;
  selectedMeasurementIds: number[];
  // When set, the viewer is placing a door/window opening: hovering a framing wall shows a ghost
  // that commits onto the wall on click. Overrides add/select while active.
  openingPlacement: OpeningTemplate | null;
  // Drawing ribbon: false = 2D plan view (default), true = 3D framing view.
  view3d: boolean;
  // 0..1: opacity of PDF linework (1 = full, no dimming). Lets measurements stand out.
  drawingDimmer: number;
  // Scale of the active drawing page, and whether the calibration capture is in progress.
  pageScale: PageScaleDto | null;
  calibrating: boolean;
  // CostX props for each selected group, scales for every page referenced by loaded
  // measurements (keyed `${drawingId}:${pageIndex}`), and the polarity new dimensions take.
  groupProps: Record<number, DimensionGroupPropsDto>;
  scaleCache: Record<string, PageScaleDto | null>;
  drawPolarity: number;
  // Ribbon → dimension-group pane bridge: the pane watches `seq` and opens the matching
  // dialog for the active group (the pane owns the Add / Properties / Copy dialogs).
  dgPaneCommand: { action: DgPaneCommand; seq: number } | null;

  workbooks: WorkbookDto[];
  activeRevisionId: number | null;

  // Format toolbar bridge: WorkbookView publishes the active selection's format
  // here and registers an imperative API the ribbon's Format toolbar calls.
  workbookFormat: WorkbookFormatSnapshot;
  workbookFormatApi: WorkbookFormatApi | null;
  setWorkbookFormat: (format: WorkbookFormatSnapshot) => void;
  setWorkbookFormatApi: (api: WorkbookFormatApi | null) => void;

  templates: TemplateDto[];
  templateManagerOpen: boolean;
  templateEditMode: TemplateEditMode | null;
  preTemplateRevisionId: number | null;

  setActiveProject: (project: ProjectMeta | null) => void;
  setSnapEnabled: (on: boolean) => void;
  setViewerMode: (mode: ViewerMode) => void;
  setOpeningPlacement: (template: OpeningTemplate | null) => void;
  setView3d: (on: boolean) => void;
  setDrawingDimmer: (value: number) => void;
  selectMeasurement: (measurementId: number | null) => void;
  toggleSelectMeasurement: (measurementId: number) => void;
  setSelectedMeasurementIds: (ids: number[]) => void;
  updateMeasurementGeometry: (measurementId: number, geometryJson: string) => Promise<void>;
  updateMeasurementFraming: (measurementId: number, framingJson: string | null) => Promise<void>;
  setCalibrating: (calibrating: boolean) => void;
  loadPageScale: (drawingId: number, pageIndex: number) => Promise<void>;
  setPageScale: (drawingId: number, pageIndex: number, mmPerPoint: number, unit: string) => Promise<void>;
  setDrawPolarity: (polarity: number) => void;
  saveGroupProps: (props: DimensionGroupPropsDto) => Promise<void>;
  createProject: (name: string, client: string, contractNumber: string, filePath: string) => Promise<void>;
  openProject: (filePath: string) => Promise<void>;
  closeProject: () => Promise<void>;
  exportProject: (destPath: string) => Promise<void>;
  removeRecentProject: (filePath: string) => Promise<void>;
  updateProjectMeta: (name: string, client: string, contractNumber: string, status: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  loadRoots: (tree: "drawings" | "dimensions") => Promise<void>;
  loadChildren: (parentId: number, force?: boolean) => Promise<void>;
  createFolder: (tree: string, parentId: number | null, name: string) => Promise<TreeNodeDto>;
  addDrawing: (parentId: number | null, name: string, filePath: string) => Promise<void>;
  addDrawingToFolderPath: (folderPath: string, name: string, filePath: string) => Promise<void>;
  createDimensionGroupInFolderPath: (folderPath: string, name: string, colour: string, measurementType: string) => Promise<void>;
  listDimensionFolders: () => Promise<FolderOption[]>;
  copyDimensionGroup: (sourceNodeId: number, targetFolderId: number, name: string, copyDimensions: boolean) => Promise<void>;
  requestDgPaneCommand: (action: DgPaneCommand) => void;
  deleteNode: (node: TreeNodeDto) => Promise<void>;
  renameNode: (node: TreeNodeDto, name: string) => Promise<void>;
  updateDimensionGroupColour: (nodeId: number, colour: string) => Promise<void>;
  selectDimensionGroup: (node: TreeNodeDto, additive?: boolean) => Promise<void>;
  /** Switches to the Dimensions tab, selects the group, and navigates the viewer
   *  to the drawing/page of its first measurement — used by the workbook's
   *  "Show dimension group" context menu. */
  goToDimensionGroup: (groupId: number) => Promise<void>;
  createMeasurement: (input: {
    measurementType?: string;
    geometryJson: string;
    polarity?: number;
    quantity?: number | null;
    uom?: string | null;
  }) => Promise<MeasurementDto>;
  deleteMeasurement: (measurementId: number) => Promise<void>;
  openDrawing: (node: TreeNodeDto) => Promise<void>;
  openDrawingPage: (node: TreeNodeDto) => Promise<void>;
  loadVectors: (pageIndex: number) => Promise<void>;
  setDrawingType: (type: "point" | "line") => void;
  resolveSnap: (cursorPageX: number, cursorPageY: number, pageIndex: number, radiusPts: number) => void;
  resolveLineSnap: (cursorPageX: number, cursorPageY: number, pageIndex: number, radiusPts: number) => void;
  clearSnap: () => void;
  loadWorkbooks: () => Promise<void>;
  setActiveRevisionId: (id: number | null) => void;
  createWorkbookRevision: (workbookId: number, name: string) => Promise<void>;
  createWorkbookRevisionFromTemplate: (workbookId: number, name: string, templateId: number) => Promise<void>;
  deleteWorkbookRevision: (revisionId: number) => Promise<void>;
  renameWorkbookRevision: (revisionId: number, name: string) => Promise<void>;

  loadTemplates: () => Promise<void>;
  openTemplateManager: () => void;
  closeTemplateManager: () => void;
  createTemplate: (name: string, description: string) => Promise<void>;
  renameTemplate: (templateId: number, name: string) => Promise<void>;
  updateTemplateDescription: (templateId: number, description: string) => Promise<void>;
  deleteTemplate: (templateId: number) => Promise<void>;
  enterTemplateEdit: (template: TemplateDto) => void;
  exitTemplateEdit: () => void;
}

export function drawingPageNodeId(drawingId: number, pageIndex: number) {
  return -(drawingId * 1_000_000 + pageIndex + 1);
}

function findNode(nodes: TreeNodeDto[], childCache: Record<number, TreeNodeDto[]>, nodeId: number): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const found = findNode(childCache[node.id] ?? [], childCache, nodeId);
    if (found) return found;
  }
  return null;
}

function markHasChildren(nodes: TreeNodeDto[], nodeId: number): TreeNodeDto[] {
  return nodes.map((node) => (node.id === nodeId ? { ...node, has_children: true } : node));
}

function containsKnownNode(node: TreeNodeDto, targetId: number | null, childCache: Record<number, TreeNodeDto[]>): boolean {
  if (targetId === null) return false;
  if (node.id === targetId) return true;
  return (childCache[node.id] ?? []).some((child) => containsKnownNode(child, targetId, childCache));
}

function pathForNode(nodes: TreeNodeDto[], childCache: Record<number, TreeNodeDto[]>, targetId: number, path: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextPath = node.node_type === "folder" || node.node_type === "dimension_group" ? [...path, node.name] : path;
    if (node.id === targetId) return nextPath;
    const found = pathForNode(childCache[node.id] ?? [], childCache, targetId, nextPath);
    if (found) return found;
  }
  return null;
}

async function refreshTree(tree: "drawings" | "dimensions", setState: typeof useAppStore.setState) {
  const roots = await invoke<TreeNodeDto[]>("get_root_nodes", { tree });
  setState((state) =>
    tree === "drawings"
      ? { drawingRoots: roots, childCache: {}, treeRevision: state.treeRevision + 1 }
      : { dimensionRoots: roots, childCache: {}, treeRevision: state.treeRevision + 1 },
  );
}

function buildIndex(primitives: VectorPrimitive[]): IndexedPrimitive[] {
  return primitives
    .map((primitive) => {
      if (primitive.type === "line") {
        const x1 = primitive.x1 ?? 0;
        const y1 = primitive.y1 ?? 0;
        const x2 = primitive.x2 ?? 0;
        const y2 = primitive.y2 ?? 0;
        return {
          primitive,
          snapPoints: [
            { x: x1, y: y1, type: "endpoint" as const },
            { x: x2, y: y2, type: "endpoint" as const },
            { x: (x1 + x2) / 2, y: (y1 + y2) / 2, type: "midpoint" as const },
          ],
          segments: [{ x1, y1, x2, y2 }],
          minX: Math.min(x1, x2),
          minY: Math.min(y1, y2),
          maxX: Math.max(x1, x2),
          maxY: Math.max(y1, y2),
        };
      }

      const x = primitive.x ?? 0;
      const y = primitive.y ?? 0;
      const x2 = x + (primitive.width ?? 0);
      const y2 = y + (primitive.height ?? 0);
      return {
        primitive,
        snapPoints: [
          { x, y, type: "endpoint" as const },
          { x: x2, y, type: "endpoint" as const },
          { x: x2, y: y2, type: "endpoint" as const },
          { x, y: y2, type: "endpoint" as const },
          { x: (x + x2) / 2, y, type: "midpoint" as const },
          { x: x2, y: (y + y2) / 2, type: "midpoint" as const },
          { x: (x + x2) / 2, y: y2, type: "midpoint" as const },
          { x, y: (y + y2) / 2, type: "midpoint" as const },
        ],
        segments: [
          { x1: x, y1: y, x2, y2: y },
          { x1: x2, y1: y, x2, y2 },
          { x1: x2, y1: y2, x2: x, y2 },
          { x1: x, y1: y2, x2: x, y2: y },
        ],
        minX: Math.min(x, x2),
        minY: Math.min(y, y2),
        maxX: Math.max(x, x2),
        maxY: Math.max(y, y2),
      };
    })
    .filter((item) => item.snapPoints.length > 0);
}

function findIntersection(a: LineSegment, b: LineSegment): SnapPoint | null {
  const denominator = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(denominator) < 1e-9) return null;

  const aCross = a.x1 * a.y2 - a.y1 * a.x2;
  const bCross = b.x1 * b.y2 - b.y1 * b.x2;
  const x = (aCross * (b.x1 - b.x2) - (a.x1 - a.x2) * bCross) / denominator;
  const y = (aCross * (b.y1 - b.y2) - (a.y1 - a.y2) * bCross) / denominator;

  const within = (value: number, start: number, end: number) =>
    value >= Math.min(start, end) - 1e-6 && value <= Math.max(start, end) + 1e-6;

  if (
    !within(x, a.x1, a.x2) ||
    !within(y, a.y1, a.y2) ||
    !within(x, b.x1, b.x2) ||
    !within(y, b.y1, b.y2)
  ) {
    return null;
  }

  return { x, y };
}

function distanceToSegmentSq(pointX: number, pointY: number, segment: LineSegment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    const pointDx = pointX - segment.x1;
    const pointDy = pointY - segment.y1;
    return pointDx * pointDx + pointDy * pointDy;
  }

  const t = Math.max(0, Math.min(1, ((pointX - segment.x1) * dx + (pointY - segment.y1) * dy) / lengthSq));
  const nearestX = segment.x1 + t * dx;
  const nearestY = segment.y1 + t * dy;
  const nearestDx = pointX - nearestX;
  const nearestDy = pointY - nearestY;
  return nearestDx * nearestDx + nearestDy * nearestDy;
}

// Line-mode collinear-merge tolerances (all in PDF points unless noted).
// A wall drawn as many small segments needs these to be recognised as one surface.
const COLLINEAR_ANGLE_SIN = Math.sin((2 * Math.PI) / 180); // 2° — must be nearly parallel
const COLLINEAR_PERP_TOL = 2; // max perpendicular offset to the same wall line
const COLLINEAR_GAP_TOL = 60; // max end-to-end gap to merge through (covers door openings)
// Crossings within this many points along the wall collapse to one junction, so a thick
// crossing wall's two faces (or a multi-line corner) read as one. Tunable: must exceed a
// single wall's face-to-face thickness (~2–6pt) but stay BELOW the spacing between distinct
// walls (~10pt+), or separate cross-walls chain into one over-wide junction.
const LINE_JUNCTION_CLUSTER_PTS = 8;

// Merges `seed` with every adjacent collinear segment in `allSegs` that lies on the same
// physical wall line. Returns the bounding LineSegment covering the full merged run.
// Uses iterative expansion so chains of individually-adjacent segments are fully coalesced.
function mergeCollinearSegments(seed: LineSegment, allSegs: LineSegment[]): LineSegment {
  const dx = seed.x2 - seed.x1;
  const dy = seed.y2 - seed.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return seed;
  const ux = dx / len;
  const uy = dy / len;

  // Expand the parametric range [tMin, tMax] until stable.
  let tMin = 0;
  let tMax = 1;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 30) {
    changed = false;
    for (const Q of allSegs) {
      if (Q === seed) continue;
      const qdx = Q.x2 - Q.x1;
      const qdy = Q.y2 - Q.y1;
      const qlen = Math.hypot(qdx, qdy);
      if (qlen < 1e-9) continue;

      // Must be nearly parallel to seed.
      const crossMag = Math.abs(ux * qdy - uy * qdx) / qlen;
      if (crossMag > COLLINEAR_ANGLE_SIN) continue;

      // Perpendicular distance from Q's first endpoint to the infinite line through seed.
      const perp = Math.abs(ux * (Q.y1 - seed.y1) - uy * (Q.x1 - seed.x1));
      if (perp > COLLINEAR_PERP_TOL) continue;

      // Project Q's endpoints onto seed's parametric axis.
      const qt1 = ((Q.x1 - seed.x1) * ux + (Q.y1 - seed.y1) * uy) / len;
      const qt2 = ((Q.x2 - seed.x1) * ux + (Q.y2 - seed.y1) * uy) / len;
      const qMin = Math.min(qt1, qt2);
      const qMax = Math.max(qt1, qt2);

      // Only merge if Q is adjacent to (or overlapping with) the current accumulated range.
      const gapTolT = COLLINEAR_GAP_TOL / len;
      if (qMax < tMin - gapTolT || qMin > tMax + gapTolT) continue;

      const nextMin = Math.min(tMin, qMin);
      const nextMax = Math.max(tMax, qMax);
      if (nextMin !== tMin || nextMax !== tMax) {
        tMin = nextMin;
        tMax = nextMax;
        changed = true;
      }
    }
  }

  return {
    x1: seed.x1 + tMin * dx,
    y1: seed.y1 + tMin * dy,
    x2: seed.x1 + tMax * dx,
    y2: seed.y1 + tMax * dy,
  };
}

// Returns the t-parameter on the infinite line through `S` at which it intersects the
// finite segment `Q`. Returns null if the lines are parallel or the intersection lies
// outside Q's bounds. Used by resolveLineSnap to extend a wall to its neighbours.
function infiniteLineSegmentT(S: LineSegment, Q: LineSegment): number | null {
  const dx = S.x2 - S.x1;
  const dy = S.y2 - S.y1;
  const b1 = Q.x2 - Q.x1;
  const b2 = Q.y2 - Q.y1;
  const c1 = Q.x1 - S.x1;
  const c2 = Q.y1 - S.y1;
  const denom = dx * b2 - dy * b1;
  if (Math.abs(denom) < 1e-9) return null;
  const t = (c1 * b2 - c2 * b1) / denom;
  const s = (c1 * dy - c2 * dx) / denom;
  if (s < -0.01 || s > 1.01) return null;
  return t;
}

export const useAppStore = create<AppStore>((set, get) => ({
  activeProject: null,
  recentProjects: [],

  activeTab: "dimensions",
  setActiveTab: (tab) => set({ activeTab: tab }),

  drawingRoots: [],
  childCache: {},
  treeRevision: 0,
  activeDrawingId: null,
  activePageIndex: 0,
  activePageNodeId: null,
  currentDocument: null,
  vectorCache: {},
  vectorIndex: {},
  snapPoint: null,
  snapType: null,
  snapEnabled: true,
  drawingType: "point",
  lineSnapResult: null,

  dimensionRoots: [],
  activeDimensionGroupId: null,
  selectedGroupIds: [],
  groupColours: {},
  activeBreadcrumb: "",
  overlayMeasurements: [],
  overlayColour: "#4A9EFF",
  viewerMode: "add",
  selectedMeasurementIds: [],
  openingPlacement: null,
  view3d: false,
  drawingDimmer: 1,
  pageScale: null,
  calibrating: false,
  groupProps: {},
  scaleCache: {},
  drawPolarity: 1,
  dgPaneCommand: null,

  workbooks: [],
  activeRevisionId: null,

  workbookFormat: DEFAULT_WORKBOOK_FORMAT,
  workbookFormatApi: null,
  setWorkbookFormat: (format) => set({ workbookFormat: format }),
  setWorkbookFormatApi: (api) => set({ workbookFormatApi: api }),

  templates: [],
  templateManagerOpen: false,
  templateEditMode: null,
  preTemplateRevisionId: null,

  setActiveProject: (project) => {
    set({ activeProject: project });
  },

  setSnapEnabled: (on) => {
    set({ snapEnabled: on, snapPoint: null, snapType: null, lineSnapResult: null });
  },

  setDrawPolarity: (polarity) => {
    set({ drawPolarity: polarity });
  },

  setDrawingType: (type) => {
    set({ drawingType: type, snapPoint: null, snapType: null, lineSnapResult: null });
  },

  saveGroupProps: async (props) => {
    const saved = await invoke<DimensionGroupPropsDto>("set_dimension_group_props", { props });
    await refreshTree("dimensions", set);
    set((state) => ({
      groupProps: { ...state.groupProps, [saved.node_id]: saved },
      groupColours: state.selectedGroupIds.includes(saved.node_id)
        ? { ...state.groupColours, [saved.node_id]: saved.pos_colour }
        : state.groupColours,
      overlayColour: state.activeDimensionGroupId === saved.node_id ? saved.pos_colour : state.overlayColour,
    }));
  },

  setCalibrating: (calibrating) => {
    set({ calibrating });
  },

  loadPageScale: async (drawingId, pageIndex) => {
    const scale = await invoke<PageScaleDto | null>("get_page_scale", { drawingId, pageIndex });
    const key = `${drawingId}:${pageIndex}`;
    set((state) => ({
      scaleCache: { ...state.scaleCache, [key]: scale },
      // Only update the toolbar's active-page scale if still on that page (guards races).
      pageScale: state.activeDrawingId === drawingId && state.activePageIndex === pageIndex ? scale : state.pageScale,
    }));
  },

  setPageScale: async (drawingId, pageIndex, mmPerPoint, unit) => {
    const scale = await invoke<PageScaleDto>("set_page_scale", { drawingId, pageIndex, mmPerPoint, unit });
    const key = `${drawingId}:${pageIndex}`;
    set((state) => ({
      calibrating: false,
      scaleCache: { ...state.scaleCache, [key]: scale },
      pageScale: state.activeDrawingId === drawingId && state.activePageIndex === pageIndex ? scale : state.pageScale,
    }));
  },

  setViewerMode: (mode) => {
    // Switching mode cancels any in-progress door/window placement.
    set((state) => ({ viewerMode: mode, openingPlacement: null, selectedMeasurementIds: mode === "add" ? [] : state.selectedMeasurementIds }));
  },

  setOpeningPlacement: (template) => {
    set({ openingPlacement: template });
  },

  setView3d: (on) => {
    set({ view3d: on });
  },

  setDrawingDimmer: (value) => {
    set({ drawingDimmer: value });
  },

  selectMeasurement: (measurementId) => {
    set({ selectedMeasurementIds: measurementId !== null ? [measurementId] : [] });
  },

  toggleSelectMeasurement: (measurementId) => {
    set((state) => ({
      selectedMeasurementIds: state.selectedMeasurementIds.includes(measurementId)
        ? state.selectedMeasurementIds.filter((id) => id !== measurementId)
        : [...state.selectedMeasurementIds, measurementId],
    }));
  },

  setSelectedMeasurementIds: (ids) => {
    set({ selectedMeasurementIds: ids });
  },

  updateMeasurementGeometry: async (measurementId, geometryJson) => {
    const updated = await invoke<MeasurementDto>("update_measurement_geometry", { measurementId, geometryJson });
    set((state) => ({
      overlayMeasurements: state.overlayMeasurements.map((measurement) =>
        measurement.id === updated.id ? updated : measurement,
      ),
    }));
  },

  updateMeasurementFraming: async (measurementId, framingJson) => {
    const updated = await invoke<MeasurementDto>("update_measurement_framing", { measurementId, framingJson });
    set((state) => ({
      overlayMeasurements: state.overlayMeasurements.map((measurement) =>
        measurement.id === updated.id ? updated : measurement,
      ),
    }));
  },

  createProject: async (name, client, contractNumber, filePath) => {
    const project = await invoke<ProjectMeta>("create_project", {
      name,
      client,
      contractNumber,
      filePath,
    });
    set({ activeProject: project, workbooks: [], activeRevisionId: null });
    await get().loadRecentProjects();
    await get().loadWorkbooks();
  },

  openProject: async (filePath) => {
    const project = await invoke<ProjectMeta>("open_project", { filePath });
    set({ activeProject: project, workbooks: [], activeRevisionId: null });
    await get().loadRecentProjects();
    await get().loadWorkbooks();
  },

  closeProject: async () => {
    await invoke<void>("close_project");
    set((state) => ({
      activeProject: null,
      drawingRoots: [],
      dimensionRoots: [],
      childCache: {},
      treeRevision: state.treeRevision + 1,
      activeDrawingId: null,
      activePageIndex: 0,
      activePageNodeId: null,
      currentDocument: null,
      vectorCache: {},
      vectorIndex: {},
      snapPoint: null,
      snapType: null,
      lineSnapResult: null,
      activeDimensionGroupId: null,
      selectedGroupIds: [],
      groupColours: {},
      selectedMeasurementIds: [],
      viewerMode: "add",
      openingPlacement: null,
      view3d: false,
      drawingDimmer: 1,
      pageScale: null,
      calibrating: false,
      groupProps: {},
      scaleCache: {},
      drawPolarity: 1,
      activeBreadcrumb: "",
      overlayMeasurements: [],
      overlayColour: "#4A9EFF",
      workbooks: [],
      activeRevisionId: null,
    }));
    await get().loadRecentProjects();
  },

  exportProject: async (destPath) => {
    await invoke<void>("export_project", { destPath });
  },

  removeRecentProject: async (filePath) => {
    await invoke<void>("remove_recent_project", { filePath });
    await get().loadRecentProjects();
  },

  updateProjectMeta: async (name, client, contractNumber, status) => {
    const meta = await invoke<ProjectMeta>("update_project_meta", { name, client, contractNumber, status });
    set({ activeProject: meta });
    await get().loadRecentProjects();
  },

  loadRecentProjects: async () => {
    const projects = await invoke<RecentProject[]>("get_recent_projects");
    set({ recentProjects: projects });
  },

  loadRoots: async (tree) => {
    const roots = await invoke<TreeNodeDto[]>("get_root_nodes", { tree });
    if (tree === "drawings") {
      set((state) => ({ drawingRoots: roots, treeRevision: state.treeRevision + 1 }));
    } else {
      set((state) => ({ dimensionRoots: roots, treeRevision: state.treeRevision + 1 }));
    }
  },

  loadChildren: async (parentId, force = false) => {
    if (!force && get().childCache[parentId]) return;
    const children = await invoke<TreeNodeDto[]>("get_children", { parentId });
    set((state) => ({
      childCache: {
        ...state.childCache,
        [parentId]: children,
      },
    }));
  },

  createFolder: async (tree, parentId, name) => {
    const folder = await invoke<TreeNodeDto>("create_folder", { tree, parentId, name });
    await refreshTree(tree === "dimensions" ? "dimensions" : "drawings", set);
    return folder;
  },

  addDrawing: async (parentId, name, filePath) => {
    const drawing = await invoke<TreeNodeDto>("add_drawing", { parentId, name, filePath });
    set((state) => {
      const nextChildCache = { ...state.childCache };
      if (parentId !== null) {
        const parent = findNode(state.drawingRoots, state.childCache, parentId);
        const currentChildren = nextChildCache[parentId];
        if (currentChildren) {
          nextChildCache[parentId] = [...currentChildren, drawing].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        } else if (parent && !parent.has_children) {
          nextChildCache[parentId] = [drawing];
        }

        for (const [cacheKey, children] of Object.entries(nextChildCache)) {
          nextChildCache[Number(cacheKey)] = markHasChildren(children, parentId);
        }
      }
      return {
        childCache: nextChildCache,
        drawingRoots: parentId === null ? [...state.drawingRoots, drawing] : markHasChildren(state.drawingRoots, parentId),
        treeRevision: state.treeRevision + 1,
      };
    });
  },

  addDrawingToFolderPath: async (folderPath, name, filePath) => {
    await invoke<TreeNodeDto>("add_drawing_to_folder_path", { folderPath, name, filePath });
    await refreshTree("drawings", set);
  },

  createDimensionGroupInFolderPath: async (folderPath, name, colour, measurementType) => {
    await invoke<TreeNodeDto>("create_dimension_group_in_folder_path", { folderPath, name, colour, measurementType });
    await refreshTree("dimensions", set);
  },

  listDimensionFolders: async () => {
    return invoke<FolderOption[]>("list_dimension_folders");
  },

  copyDimensionGroup: async (sourceNodeId, targetFolderId, name, copyDimensions) => {
    await invoke<TreeNodeDto>("copy_dimension_group", { sourceNodeId, targetFolderId, name, copyDimensions });
    await refreshTree("dimensions", set);
  },

  requestDgPaneCommand: (action) => {
    set((state) => ({ dgPaneCommand: { action, seq: (state.dgPaneCommand?.seq ?? 0) + 1 } }));
  },

  deleteNode: async (node) => {
    const state = get();
    if (node.node_type !== "folder" && node.node_type !== "drawing" && node.node_type !== "dimension_group") {
      throw new Error("Only folders, drawings, and dimension groups can be deleted");
    }
    const clearsActiveDocument = (node.node_type === "folder" && containsKnownNode(node, state.activeDrawingId, state.childCache)) || node.id === state.activeDrawingId;
    await invoke<void>("delete_node", { nodeId: node.id, expectedNodeType: node.node_type });

    if (node.tree === "dimensions") {
      const roots = await invoke<TreeNodeDto[]>("get_root_nodes", { tree: "dimensions" });
      set((latest) => ({
        dimensionRoots: roots,
        childCache: {},
        activeDimensionGroupId: null,
        selectedGroupIds: [],
        groupColours: {},
        groupProps: {},
        selectedMeasurementIds: [],
        activeBreadcrumb: "",
        overlayMeasurements: [],
        overlayColour: "#4A9EFF",
        treeRevision: latest.treeRevision + 1,
      }));
      return;
    }

    const roots = await invoke<TreeNodeDto[]>("get_root_nodes", { tree: "drawings" });
    set((latest) => ({
      drawingRoots: roots,
      childCache: {},
      activeDrawingId: clearsActiveDocument ? null : state.activeDrawingId,
      activePageIndex: clearsActiveDocument ? 0 : state.activePageIndex,
      activePageNodeId: clearsActiveDocument ? null : state.activePageNodeId,
      currentDocument: clearsActiveDocument ? null : state.currentDocument,
      vectorCache: clearsActiveDocument ? {} : state.vectorCache,
      vectorIndex: clearsActiveDocument ? {} : state.vectorIndex,
      snapPoint: clearsActiveDocument ? null : state.snapPoint,
      snapType: clearsActiveDocument ? null : state.snapType,
      lineSnapResult: clearsActiveDocument ? null : state.lineSnapResult,
      treeRevision: latest.treeRevision + 1,
    }));
  },

  renameNode: async (node, name) => {
    if (node.node_type !== "folder" && node.node_type !== "drawing" && node.node_type !== "dimension_group") {
      throw new Error("Unsupported node type for rename");
    }
    await invoke<TreeNodeDto>("rename_node", { nodeId: node.id, expectedNodeType: node.node_type, name });
    await refreshTree(node.tree === "dimensions" ? "dimensions" : "drawings", set);
  },

  updateDimensionGroupColour: async (nodeId, colour) => {
    await invoke<TreeNodeDto>("update_dimension_group_colour", { nodeId, colour });
    await refreshTree("dimensions", set);
    set((state) => {
      if (!state.selectedGroupIds.includes(nodeId)) return {};
      return {
        groupColours: { ...state.groupColours, [nodeId]: colour },
        overlayColour: state.activeDimensionGroupId === nodeId ? colour : state.overlayColour,
        groupProps: state.groupProps[nodeId]
          ? { ...state.groupProps, [nodeId]: { ...state.groupProps[nodeId], pos_colour: colour } }
          : state.groupProps,
      };
    });
  },

  // Plain click selects one group; Ctrl+click toggles a group in/out of the
  // selection. All selected groups render concurrently, each in its own colour;
  // the active (primary) group is where new dimensions are added.
  selectDimensionGroup: async (node, additive = false) => {
    if (node.node_type !== "dimension_group") return;
    const state = get();

    let selectedIds: number[];
    let activeId: number | null;
    if (additive) {
      if (state.selectedGroupIds.includes(node.id)) {
        selectedIds = state.selectedGroupIds.filter((id) => id !== node.id);
        activeId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
      } else {
        selectedIds = [...state.selectedGroupIds, node.id];
        activeId = node.id;
      }
    } else {
      selectedIds = [node.id];
      activeId = node.id;
    }

    // Load measurements + CostX props for every selected group.
    const [perGroup, propsList] = await Promise.all([
      Promise.all(selectedIds.map((id) => invoke<MeasurementDto[]>("get_measurements_for_group", { groupId: id }))),
      Promise.all(selectedIds.map((id) => invoke<DimensionGroupPropsDto>("get_dimension_group_props", { nodeId: id }))),
    ]);
    const measurements = perGroup.flat();

    const groupProps: Record<number, DimensionGroupPropsDto> = {};
    selectedIds.forEach((id, index) => {
      groupProps[id] = propsList[index];
    });

    // Each selected group's positive colour comes from its props.
    const groupColours: Record<number, string> = {};
    for (const id of selectedIds) {
      groupColours[id] = groupProps[id]?.pos_colour ?? "#4A9EFF";
    }

    // Load the scale for every page referenced by the loaded measurements.
    const pageKeys = Array.from(new Set(measurements.map((m) => `${m.drawing_id}:${m.page_index}`)));
    const scaleEntries = await Promise.all(
      pageKeys.map(async (key) => {
        const [drawingId, pageIndex] = key.split(":").map(Number);
        const scale = await invoke<PageScaleDto | null>("get_page_scale", { drawingId, pageIndex });
        return [key, scale] as const;
      }),
    );
    const scaleCache: Record<string, PageScaleDto | null> = Object.fromEntries(scaleEntries);

    const activeNode = activeId !== null ? findNode(state.dimensionRoots, state.childCache, activeId) : null;
    const breadcrumb =
      activeId !== null ? pathForNode(state.dimensionRoots, state.childCache, activeId)?.join(" / ") ?? node.name : "";
    const activeMeasurements = activeId !== null ? perGroup[selectedIds.indexOf(activeId)] ?? [] : [];
    const firstMeasurement = activeMeasurements[0] ?? null;
    const followsActiveDrawing =
      firstMeasurement && state.currentDocument && state.activeDrawingId === firstMeasurement.drawing_id;

    set({
      activeDimensionGroupId: activeId,
      selectedGroupIds: selectedIds,
      groupColours,
      groupProps,
      scaleCache,
      selectedMeasurementIds: [],
      activeBreadcrumb: breadcrumb,
      overlayMeasurements: measurements,
      overlayColour: (activeId !== null ? groupColours[activeId] : activeNode?.colour) ?? "#4A9EFF",
      activePageIndex: followsActiveDrawing ? firstMeasurement!.page_index : state.activePageIndex,
      activePageNodeId: followsActiveDrawing
        ? drawingPageNodeId(firstMeasurement!.drawing_id, firstMeasurement!.page_index)
        : state.activePageNodeId,
    });
  },

  goToDimensionGroup: async (groupId) => {
    const state = get();
    const groupNode = findNode(state.dimensionRoots, state.childCache, groupId);
    if (groupNode) await get().selectDimensionGroup(groupNode);

    const measurements = await invoke<MeasurementDto[]>("get_measurements_for_group", { groupId });
    const first = measurements[0];
    if (!first) {
      set({ activeTab: "dimensions" });
      return;
    }

    const after = get();
    const drawingNode = findNode(after.drawingRoots, after.childCache, first.drawing_id);
    if (drawingNode?.file_path && (after.activeDrawingId !== first.drawing_id || after.currentDocument?.path !== drawingNode.file_path)) {
      const document = await invoke<DocumentMeta>("open_document", { path: drawingNode.file_path });
      set({ currentDocument: document, vectorCache: {}, vectorIndex: {} });
      await get().loadVectors(first.page_index);
    }

    set({
      activeTab: "dimensions",
      activeDrawingId: first.drawing_id,
      activePageIndex: first.page_index,
      activePageNodeId: drawingPageNodeId(first.drawing_id, first.page_index),
    });
  },

  createMeasurement: async (input) => {
    const state = get();
    const { activeDimensionGroupId, activeDrawingId, activePageIndex, groupProps, drawPolarity } = state;
    if (activeDimensionGroupId === null) throw new Error("No active dimension group");
    if (activeDrawingId === null) throw new Error("No active drawing");

    // The group owns the measurement type; new dimensions take the current draw polarity.
    const measurementType = input.measurementType ?? groupProps[activeDimensionGroupId]?.measurement_type ?? "length";

    const created = await invoke<MeasurementDto>("create_measurement", {
      dimensionGroupId: activeDimensionGroupId,
      drawingId: activeDrawingId,
      pageIndex: activePageIndex,
      measurementType,
      geometryJson: input.geometryJson,
      polarity: input.polarity ?? drawPolarity,
      quantity: input.quantity ?? null,
      uom: input.uom ?? null,
    });

    set((latest) =>
      created.dimension_group_id === latest.activeDimensionGroupId
        ? { overlayMeasurements: [...latest.overlayMeasurements, created] }
        : {},
    );
    return created;
  },

  deleteMeasurement: async (measurementId) => {
    await invoke("delete_measurement", { measurementId });
    set((state) => ({
      overlayMeasurements: state.overlayMeasurements.filter((measurement) => measurement.id !== measurementId),
      selectedMeasurementIds: state.selectedMeasurementIds.filter((id) => id !== measurementId),
    }));
  },

  openDrawing: async (node) => {
    if (!node.file_path) return;
    const document = await invoke<DocumentMeta>("open_document", { path: node.file_path });
    set({ activeDrawingId: node.id, activePageIndex: 0, activePageNodeId: null, currentDocument: document, vectorCache: {}, vectorIndex: {}, snapPoint: null, snapType: null, lineSnapResult: null });
    await get().loadVectors(0);
  },

  openDrawingPage: async (node) => {
    if (!node.file_path || node.parent_id === null) return;
    const state = get();
    let document = state.currentDocument;
    let documentChanged = false;

    if (state.activeDrawingId !== node.parent_id || document?.path !== node.file_path) {
      document = await invoke<DocumentMeta>("open_document", { path: node.file_path });
      documentChanged = true;
    }

    set({
      activeDrawingId: node.parent_id,
      activePageIndex: node.sort_order,
      activePageNodeId: node.id,
      currentDocument: document,
      vectorCache: documentChanged ? {} : state.vectorCache,
      vectorIndex: documentChanged ? {} : state.vectorIndex,
      snapPoint: null,
      snapType: null,
      lineSnapResult: null,
    });
    await get().loadVectors(node.sort_order);
  },

  loadVectors: async (pageIndex) => {
    if (get().vectorCache[pageIndex]) return;
    const result = await invoke<PageVectors>("get_page_vectors", { pageIndex });
    const index = buildIndex(result.primitives);
    set((state) => ({
      vectorCache: {
        ...state.vectorCache,
        [pageIndex]: result.primitives,
      },
      vectorIndex: {
        ...state.vectorIndex,
        [pageIndex]: index,
      },
    }));
  },

  resolveSnap: (cursorPageX, cursorPageY, pageIndex, radiusPts) => {
    const index = get().vectorIndex[pageIndex];
    if (!index) {
      set({ snapPoint: null, snapType: null });
      return;
    }

    const radiusSq = radiusPts * radiusPts;
    const candidates: IndexedPrimitive[] = [];
    const bestByType: Record<SnapType, { point: SnapPoint; distanceSq: number } | null> = {
      endpoint: null,
      midpoint: null,
      intersection: null,
    };

    for (const item of index) {
      if (
        cursorPageX < item.minX - radiusPts ||
        cursorPageX > item.maxX + radiusPts ||
        cursorPageY < item.minY - radiusPts ||
        cursorPageY > item.maxY + radiusPts
      ) {
        continue;
      }

      candidates.push(item);
      for (const point of item.snapPoints) {
        const dx = point.x - cursorPageX;
        const dy = point.y - cursorPageY;
        const distanceSq = dx * dx + dy * dy;
        const current = bestByType[point.type];
        if (distanceSq <= radiusSq && (!current || distanceSq < current.distanceSq)) {
          bestByType[point.type] = { point: { x: point.x, y: point.y }, distanceSq };
        }
      }
    }

    for (const type of ["endpoint", "midpoint"] as const) {
      const best = bestByType[type];
      if (best) {
        set({ snapPoint: best.point, snapType: type });
        return;
      }
    }

    const nearbySegments: LineSegment[] = [];
    for (const item of candidates) {
      for (const segment of item.segments) {
        if (distanceToSegmentSq(cursorPageX, cursorPageY, segment) <= radiusSq) {
          nearbySegments.push(segment);
        }
      }
    }

    for (let i = 0; i < nearbySegments.length; i += 1) {
      for (let j = i + 1; j < nearbySegments.length; j += 1) {
        const intersection = findIntersection(nearbySegments[i], nearbySegments[j]);
        if (!intersection) continue;

        const dx = intersection.x - cursorPageX;
        const dy = intersection.y - cursorPageY;
        const distanceSq = dx * dx + dy * dy;
        const current = bestByType.intersection;
        if (distanceSq <= radiusSq && (!current || distanceSq < current.distanceSq)) {
          bestByType.intersection = { point: intersection, distanceSq };
        }
      }
    }

    const bestIntersection = bestByType.intersection;
    if (bestIntersection) {
      set({ snapPoint: bestIntersection.point, snapType: "intersection" });
      return;
    }

    set({ snapPoint: null, snapType: null });
  },

  resolveLineSnap: (cursorPageX, cursorPageY, pageIndex, radiusPts) => {
    const index = get().vectorIndex[pageIndex];
    if (!index) {
      set({ lineSnapResult: null });
      return;
    }

    // Step 1: collect every segment within the snap radius, nearest first. We also keep a
    // flat list of all segments (the merge and opposite-face search need the whole page).
    const radiusSq = radiusPts * radiusPts;
    const allSegs: LineSegment[] = [];
    const candidates: { seg: LineSegment; distSq: number }[] = [];
    for (const item of index) {
      for (const seg of item.segments) {
        allSegs.push(seg);
        if (
          cursorPageX >= item.minX - radiusPts &&
          cursorPageX <= item.maxX + radiusPts &&
          cursorPageY >= item.minY - radiusPts &&
          cursorPageY <= item.maxY + radiusPts
        ) {
          const dSq = distanceToSegmentSq(cursorPageX, cursorPageY, seg);
          if (dSq <= radiusSq) candidates.push({ seg, distSq: dSq });
        }
      }
    }

    if (candidates.length === 0) {
      set({ lineSnapResult: null });
      return;
    }
    candidates.sort((a, b) => a.distSq - b.distSq);

    // Step 2: choose the seed by *merged run length*, not by raw proximity. The cursor often
    // lands closest to a tiny facet of a circle/symbol (e.g. a column dot at a junction) whose
    // run is a fraction of a point; the actual wall is a long collinear run a hair further off.
    // We consider only candidates within a small distance band of the nearest hit (so a far
    // parallel wall can't hijack the pick) and take the one whose merged run is longest.
    const SEED_DIST_BAND = 8; // pts beyond the nearest hit still considered "the same spot"
    const nearestDist = Math.sqrt(candidates[0].distSq);
    const bandMaxSq = (nearestDist + SEED_DIST_BAND) * (nearestDist + SEED_DIST_BAND);
    let S: LineSegment | null = null;
    let bestRun = -1;
    for (const cand of candidates) {
      if (cand.distSq > bandMaxSq) break; // sorted — everything past here is further still
      const merged = mergeCollinearSegments(cand.seg, allSegs);
      const run = Math.hypot(merged.x2 - merged.x1, merged.y2 - merged.y1);
      if (run > bestRun + 1e-6) {
        bestRun = run;
        S = merged;
      }
    }
    if (!S) {
      set({ lineSnapResult: null });
      return;
    }

    const dx = S.x2 - S.x1;
    const dy = S.y2 - S.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) {
      set({ lineSnapResult: null });
      return;
    }

    // Step 3: project the cursor onto the merged wall to find which portion is active.
    const tCursor = ((cursorPageX - S.x1) * dx + (cursorPageY - S.y1) * dy) / lenSq;
    const len = Math.sqrt(lenSq);
    const ux = dx / len;
    const uy = dy / len;

    // Step 4: collect where genuinely *transverse* segments cross the detected wall face S.
    // We test against S only — NOT a synthesised opposite face. On hatched drawings the
    // opposite-face search locks onto a hatch line a wall-thickness+ away and injects phantom
    // crossings (door-swing arcs, hatch ticks) that fragment the wall. A perpendicular wall
    // that truly butts in crosses S directly at the junction, so S alone is sufficient and far
    // more robust. Near-parallel segments (the wall's own pieces/faces, and parallel hatching)
    // are skipped, or their approximately-collinear endpoints would leak in as phantom clips.
    const crossings: number[] = [];
    for (const seg of allSegs) {
      const qdx = seg.x2 - seg.x1;
      const qdy = seg.y2 - seg.y1;
      const qlen = Math.hypot(qdx, qdy);
      if (qlen < 1e-9) continue;
      const crossMag = Math.abs(ux * qdy - uy * qdx) / qlen;
      if (crossMag <= COLLINEAR_ANGLE_SIN) continue; // not transverse — ignore
      const t = infiniteLineSegmentT(S, seg);
      if (t !== null) crossings.push(t);
    }

    // Step 5: group crossings into junctions, each kept as a [lo, hi] range. A thick crossing
    // wall's two faces (and the cluttered corner lines around them) chain into one junction
    // when within a wall-thickness of each other. Crossings outside (0,1) are discarded — they
    // come from distant segments cutting the wall's *infinite* extension and would otherwise
    // place phantom junctions past the wall's physical ends.
    const onWall = crossings.filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b);
    const clusterTolT = LINE_JUNCTION_CLUSTER_PTS / len;
    const junctions: { lo: number; hi: number }[] = [];
    for (const t of onWall) {
      const last = junctions[junctions.length - 1];
      if (last && t - last.hi <= clusterTolT) {
        last.hi = t;
      } else {
        junctions.push({ lo: t, hi: t });
      }
    }

    // Step 6: bound the bay by the *near face* of the nearest junction on each side of the
    // cursor (where the cross-wall begins), not the junction centre — so the line ends exactly
    // where the perpendicular wall meets it. Wall ends bound the bay when no junction does. A
    // junction straddling the cursor (hovering directly on a cross-wall) is skipped, yielding a
    // full bay through it rather than a sliver.
    let tLeft = 0;
    let tRight = 1;
    for (const j of junctions) {
      if (j.hi <= tCursor) {
        if (j.hi > tLeft) tLeft = j.hi;
      } else if (j.lo >= tCursor) {
        if (j.lo < tRight) tRight = j.lo;
      }
    }
    tLeft = Math.max(0, Math.min(tLeft, 1));
    tRight = Math.max(0, Math.min(tRight, 1));

    const start: SnapPoint = { x: S.x1 + tLeft * dx, y: S.y1 + tLeft * dy };
    const end: SnapPoint = { x: S.x1 + tRight * dx, y: S.y1 + tRight * dy };
    set({ lineSnapResult: { start, end } });
  },

  clearSnap: () => set({ snapPoint: null, snapType: null, lineSnapResult: null }),

  loadWorkbooks: async () => {
    const workbooks = await invoke<WorkbookDto[]>("list_workbooks");
    set((state) => {
      // Auto-select the first revision if none is active.
      let activeRevisionId = state.activeRevisionId;
      if (activeRevisionId === null && workbooks.length > 0 && workbooks[0].revisions.length > 0) {
        activeRevisionId = workbooks[0].revisions[0].id;
      }
      return { workbooks, activeRevisionId };
    });
  },

  setActiveRevisionId: (id) => set({ activeRevisionId: id }),

  createWorkbookRevision: async (workbookId, name) => {
    await invoke<WorkbookRevisionDto>("create_workbook_revision", { workbookId, name });
    await get().loadWorkbooks();
  },

  createWorkbookRevisionFromTemplate: async (workbookId, name, templateId) => {
    const revision = await invoke<WorkbookRevisionDto>("create_workbook_revision_from_template", { workbookId, name, templateId });
    await get().loadWorkbooks();
    set({ activeRevisionId: revision.id });
  },

  deleteWorkbookRevision: async (revisionId) => {
    await invoke("delete_workbook_revision", { revisionId });
    set((state) => ({
      activeRevisionId: state.activeRevisionId === revisionId ? null : state.activeRevisionId,
    }));
    await get().loadWorkbooks();
  },

  renameWorkbookRevision: async (revisionId, name) => {
    await invoke("rename_workbook_revision", { revisionId, name });
    await get().loadWorkbooks();
  },

  loadTemplates: async () => {
    const templates = await invoke<TemplateDto[]>("list_templates");
    set({ templates });
  },

  openTemplateManager: () => {
    set({ templateManagerOpen: true });
    void get().loadTemplates();
  },

  closeTemplateManager: () => set({ templateManagerOpen: false }),

  createTemplate: async (name, description) => {
    const template = await invoke<TemplateDto>("create_template", { name, description });
    set({ templates: [...get().templates, template].sort((a, b) => a.name.localeCompare(b.name)) });
    get().enterTemplateEdit(template);
  },

  renameTemplate: async (templateId, name) => {
    await invoke("rename_template", { templateId, name });
    await get().loadTemplates();
    set((state) =>
      state.templateEditMode && state.templateEditMode.templateId === templateId
        ? { templateEditMode: { ...state.templateEditMode, name } }
        : {}
    );
  },

  updateTemplateDescription: async (templateId, description) => {
    await invoke("update_template_description", { templateId, description });
    await get().loadTemplates();
  },

  deleteTemplate: async (templateId) => {
    await invoke("delete_template", { templateId });
    await get().loadTemplates();
  },

  enterTemplateEdit: (template) => {
    const state = get();
    set({
      preTemplateRevisionId: state.templateEditMode ? state.preTemplateRevisionId : state.activeRevisionId,
      templateEditMode: { templateId: template.id, revisionId: template.revision_id, name: template.name },
      activeRevisionId: template.revision_id,
      templateManagerOpen: false,
      activeTab: "workbook",
    });
  },

  exitTemplateEdit: () => {
    const state = get();
    set({
      templateEditMode: null,
      activeRevisionId: state.preTemplateRevisionId,
      preTemplateRevisionId: null,
      templateManagerOpen: true,
    });
    void get().loadTemplates();
  },
}));
