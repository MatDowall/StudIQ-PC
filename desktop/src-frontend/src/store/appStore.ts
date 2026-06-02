import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

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
  file_path: string;
  created_at: string;
  last_opened_at: string;
}

export interface RecentProject {
  name: string;
  client: string;
  contract_number: string;
  file_path: string;
  last_opened_at: string;
  file_exists: boolean;
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

export type SnapType = "endpoint" | "midpoint" | "intersection";

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

  dimensionRoots: TreeNodeDto[];
  activeDimensionGroupId: number | null;
  activeBreadcrumb: string;
  overlayMeasurements: MeasurementDto[];
  overlayColour: string;

  setActiveProject: (project: ProjectMeta | null) => void;
  createProject: (name: string, client: string, contractNumber: string, filePath: string) => Promise<void>;
  openProject: (filePath: string) => Promise<void>;
  closeProject: () => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  loadRoots: (tree: "drawings" | "dimensions") => Promise<void>;
  loadChildren: (parentId: number, force?: boolean) => Promise<void>;
  createFolder: (tree: string, parentId: number | null, name: string) => Promise<TreeNodeDto>;
  addDrawing: (parentId: number | null, name: string, filePath: string) => Promise<void>;
  addDrawingToFolderPath: (folderPath: string, name: string, filePath: string) => Promise<void>;
  createDimensionGroupInFolderPath: (folderPath: string, name: string, colour: string) => Promise<void>;
  deleteNode: (node: TreeNodeDto) => Promise<void>;
  renameNode: (node: TreeNodeDto, name: string) => Promise<void>;
  updateDimensionGroupColour: (nodeId: number, colour: string) => Promise<void>;
  selectDimensionGroup: (node: TreeNodeDto) => Promise<void>;
  openDrawing: (node: TreeNodeDto) => Promise<void>;
  openDrawingPage: (node: TreeNodeDto) => Promise<void>;
  loadVectors: (pageIndex: number) => Promise<void>;
  resolveSnap: (cursorPageX: number, cursorPageY: number, pageIndex: number, radiusPts: number) => void;
  clearSnap: () => void;
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

export const useAppStore = create<AppStore>((set, get) => ({
  activeProject: null,
  recentProjects: [],

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

  dimensionRoots: [],
  activeDimensionGroupId: null,
  activeBreadcrumb: "",
  overlayMeasurements: [],
  overlayColour: "#4A9EFF",

  setActiveProject: (project) => {
    set({ activeProject: project });
  },

  createProject: async (name, client, contractNumber, filePath) => {
    const project = await invoke<ProjectMeta>("create_project", {
      name,
      client,
      contractNumber,
      filePath,
    });
    set({ activeProject: project });
    await get().loadRecentProjects();
  },

  openProject: async (filePath) => {
    const project = await invoke<ProjectMeta>("open_project", { filePath });
    set({ activeProject: project });
    await get().loadRecentProjects();
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
      activeDimensionGroupId: null,
      activeBreadcrumb: "",
      overlayMeasurements: [],
      overlayColour: "#4A9EFF",
    }));
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

  createDimensionGroupInFolderPath: async (folderPath, name, colour) => {
    await invoke<TreeNodeDto>("create_dimension_group_in_folder_path", { folderPath, name, colour });
    await refreshTree("dimensions", set);
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
    const state = get();
    if (state.activeDimensionGroupId === nodeId) {
      set({ overlayColour: colour });
    }
  },

  selectDimensionGroup: async (node) => {
    if (node.node_type !== "dimension_group") return;
    const measurements = await invoke<MeasurementDto[]>("get_measurements_for_group", { groupId: node.id });
    const state = get();
    const breadcrumb = pathForNode(state.dimensionRoots, state.childCache, node.id)?.join(" / ") ?? node.name;
    const firstMeasurement = measurements[0] ?? null;
    set({
      activeDimensionGroupId: node.id,
      activeBreadcrumb: breadcrumb,
      overlayMeasurements: measurements,
      overlayColour: node.colour ?? "#4A9EFF",
      activePageIndex:
        firstMeasurement && state.currentDocument && state.activeDrawingId === firstMeasurement.drawing_id
          ? firstMeasurement.page_index
          : state.activePageIndex,
      activePageNodeId:
        firstMeasurement && state.currentDocument && state.activeDrawingId === firstMeasurement.drawing_id
          ? drawingPageNodeId(firstMeasurement.drawing_id, firstMeasurement.page_index)
          : state.activePageNodeId,
    });
  },

  openDrawing: async (node) => {
    if (!node.file_path) return;
    const document = await invoke<DocumentMeta>("open_document", { path: node.file_path });
    set({ activeDrawingId: node.id, activePageIndex: 0, activePageNodeId: null, currentDocument: document, vectorCache: {}, vectorIndex: {}, snapPoint: null, snapType: null });
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

  clearSnap: () => set({ snapPoint: null, snapType: null }),
}));
