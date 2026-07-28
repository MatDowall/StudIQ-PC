import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, TreeNodeDto, type DimensionGroupPropsDto, type FolderOption } from "../store/appStore";
import { theme } from "../theme";
import { ColourDialog } from "./ColourDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { DimensionGroupCopyDialog } from "./DimensionGroupCopyDialog";
import { DimensionGroupDialog } from "./DimensionGroupDialog";
import { DimensionGroupPropertiesDialog } from "./DimensionGroupPropertiesDialog";
import { TextInputDialog } from "./TextInputDialog";
import { groupNetQuantity, parseArrayMeta, quantityValueText, MEASUREMENT_TYPE_ICONS, type PagePoint, type Quantity } from "../lib/quantity";
import {
  aggregateArrayGroup,
  aggregateFramingGroup,
  parseFramingSettings,
  parseJoistRafterSettings,
  parseWallFraming,
  type ArrayInput,
  type FramingGroupBreakdown,
  type FramingWallInput,
} from "../lib/framing";
import { RateLibraryPane } from "./RateLibraryPane";

const tabs = ["Dimension Groups", "Rate Library"] as const;
type PaneTab = (typeof tabs)[number];
const gridColumns = "22px minmax(150px, 1fr) 72px 48px 26px";

function findPath(nodes: TreeNodeDto[], targetId: number, childCache: Record<number, TreeNodeDto[]>, path: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextPath = node.node_type === "folder" ? [...path, node.name] : path;
    if (node.id === targetId) return nextPath;
    const found = findPath(childCache[node.id] ?? [], targetId, childCache, nextPath);
    if (found) return found;
  }
  return null;
}

function summaryForNode(node: TreeNodeDto, total: Quantity | null | undefined) {
  if (node.node_type !== "dimension_group" || !total) return { quantity: "", uom: "" };
  return { quantity: quantityValueText(total), uom: total.uom };
}

/** A read-only itemised child row shown beneath a loaded dimension group. `components` roll into
 *  the group's own quantity; `overrides` are separate sub-quantities of a different timber size
 *  (a framing group's lintels, a joist/rafter group's differently-sized blocking) and are styled
 *  distinctly because each becomes its own worksheet line item. */
interface BreakdownRow {
  key: string;
  label: string;
  total: number;
}

export interface GroupBreakdownRows {
  components: BreakdownRow[];
  overrides: BreakdownRow[];
}

const sizeLabel = (size: string) => size.replace("x", " × ");
const countSuffix = (count: number) => (Math.abs(count) > 1 ? ` (${Math.abs(Math.round(count))})` : "");

function DimensionNodeIcon({ node, measurementType }: { node: TreeNodeDto; measurementType?: string }) {
  if (node.node_type === "folder") {
    return (
      <span
        style={{
          position: "relative",
          width: 14,
          height: 11,
          marginRight: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 1,
            top: 1,
            width: 6,
            height: 3,
            border: `1px solid ${theme.text.secondary}`,
            borderBottom: "none",
          }}
        />
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 4,
            width: 13,
            height: 7,
            border: `1px solid ${theme.text.secondary}`,
          }}
        />
      </span>
    );
  }

  // measurement_type is always present on the node (sourced from the DB join), so no fallback.
  const resolvedType = measurementType ?? node.measurement_type ?? "length";
  const iconName = MEASUREMENT_TYPE_ICONS[resolvedType] ?? MEASUREMENT_TYPE_ICONS["length"];

  return (
    <span
      style={{
        width: 28,
        marginRight: 4,
        color: theme.text.secondary,
        lineHeight: 1,
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 28, lineHeight: 1 }}>
        {iconName}
      </span>
    </span>
  );
}

function DimensionTreeRow({
  node,
  depth,
  activeNodeId,
  selectedGroupIds,
  groupTotals,
  groupBreakdownRows,
  groupProps,
  onNodeClick,
  onContextMenu,
}: {
  node: TreeNodeDto;
  depth: number;
  activeNodeId: number | null;
  selectedGroupIds: number[];
  groupTotals: Record<number, Quantity | null>;
  groupBreakdownRows: Record<number, GroupBreakdownRows>;
  groupProps: Record<number, DimensionGroupPropsDto>;
  onNodeClick: (node: TreeNodeDto, event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent, node: TreeNodeDto) => void;
}) {
  const isFolder = node.node_type === "folder";
  const [expanded, setExpanded] = useState(isFolder);
  const [loading, setLoading] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const childCache = useAppStore((state) => state.childCache);
  const loadChildren = useAppStore((state) => state.loadChildren);
  const treeRevision = useAppStore((state) => state.treeRevision);
  const children = childCache[node.id] ?? [];
  const canExpand = isFolder && (node.has_children || children.length > 0);
  const isActive = activeNodeId === node.id || selectedGroupIds.includes(node.id);
  const summary = summaryForNode(node, groupTotals[node.id]);
  // Timber-framing groups append their framing size to the displayed name, e.g.
  // "Framing - 90 × 45". Sourced from the node itself so it shows whether or not the group is
  // selected/loaded.
  const displayName = node.framing_size ? `${node.name} - ${node.framing_size.replace("x", " × ")}` : node.name;
  // Itemised component child rows beneath a loaded group (framing build-up; joist/rafter members +
  // blocking). Rows of a different timber size — framing lintels, differently-sized blocking — are
  // split out as separate sub-quantity rows below the main build-up.
  const breakdownRows = node.node_type === "dimension_group" ? groupBreakdownRows[node.id] : undefined;
  const framingComponentRows = breakdownRows?.components ?? [];
  const framingOverrideRows = breakdownRows?.overrides ?? [];

  useEffect(() => {
    if (!canExpand && expanded) {
      setExpanded(false);
    }
  }, [canExpand, expanded]);

  useEffect(() => {
    if (!expanded || !isFolder || (!node.has_children && children.length === 0) || loading) return;
    if (childCache[node.id] && loadedRevision === treeRevision) return;

    setLoading(true);
    loadChildren(node.id, true).finally(() => {
      setLoadedRevision(useAppStore.getState().treeRevision);
      setLoading(false);
    });
  }, [childCache, children.length, expanded, isFolder, loadChildren, loadedRevision, loading, node.has_children, node.id, treeRevision]);

  async function toggleExpanded(event: MouseEvent) {
    event.stopPropagation();
    if (!canExpand) return;
    if (!expanded && !childCache[node.id]) {
      setLoading(true);
      try {
        await loadChildren(node.id);
        setLoadedRevision(useAppStore.getState().treeRevision);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((current) => !current);
  }

  return (
    <>
      <div
        onClick={(event) => onNodeClick(node, event)}
        onContextMenu={(event) => onContextMenu(event, node)}
        draggable={node.node_type === "dimension_group"}
        onDragStart={(event) => {
          if (node.node_type !== "dimension_group") return;
          event.dataTransfer.setData(
            "application/x-studiq-dimension-group",
            JSON.stringify({ groupId: node.id, name: node.name }),
          );
          event.dataTransfer.effectAllowed = "copy";
        }}
        style={{
          display: "grid",
          gridTemplateColumns: gridColumns,
          alignItems: "center",
          minWidth: 360,
          height: theme.rowHeight,
          background: isActive ? theme.bg.active : "transparent",
          color: theme.text.primary,
          cursor: "default",
          fontSize: 12,
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        <button
          onClick={toggleExpanded}
          disabled={!canExpand || loading}
          style={{
            width: 22,
            height: theme.rowHeight,
            padding: 0,
            border: "none",
            background: "transparent",
            color: canExpand ? theme.text.secondary : "transparent",
            cursor: canExpand ? "pointer" : "default",
            fontSize: 10,
          }}
        >
          {loading ? "..." : expanded ? "v" : ">"}
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            paddingLeft: depth * theme.treeIndent,
            overflow: "hidden",
          }}
        >
          <DimensionNodeIcon node={node} measurementType={groupProps[node.id]?.measurement_type} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: theme.text.primary }}>{displayName}</span>
        </div>
        <div style={{ paddingRight: 8, textAlign: "right", color: theme.text.primary }}>{summary.quantity}</div>
        <div style={{ paddingLeft: 6, color: theme.text.primary }}>{summary.uom}</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {node.node_type === "dimension_group" ? (
            <span style={{ width: 16, height: 16, background: node.colour ?? theme.accent, border: `1px solid ${theme.border.divider}` }} />
          ) : null}
        </div>
      </div>
      {framingComponentRows.map((row) => (
        <div
          key={`${node.id}-${row.key}`}
          style={{
            display: "grid",
            gridTemplateColumns: gridColumns,
            alignItems: "center",
            minWidth: 360,
            height: theme.rowHeight,
            color: theme.text.secondary,
            fontSize: 11,
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          <div />
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, paddingLeft: (depth + 1) * theme.treeIndent + 8, overflow: "hidden" }}>
            <span style={{ marginRight: 6, color: theme.text.disabled }}>└</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>
          </div>
          <div style={{ paddingRight: 8, textAlign: "right" }}>{row.total.toFixed(3)}</div>
          <div style={{ paddingLeft: 6 }}>m</div>
          <div />
        </div>
      ))}
      {framingOverrideRows.map((row) => (
        <div
          key={`${node.id}-override-${row.key}`}
          title="Separate timber size — will be a distinct worksheet line item"
          style={{
            display: "grid",
            gridTemplateColumns: gridColumns,
            alignItems: "center",
            minWidth: 360,
            height: theme.rowHeight,
            color: theme.accent,
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          <div />
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, paddingLeft: (depth + 1) * theme.treeIndent + 8, overflow: "hidden" }}>
            <span style={{ marginRight: 6 }}>◆</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>
          </div>
          <div style={{ paddingRight: 8, textAlign: "right" }}>{row.total.toFixed(3)}</div>
          <div style={{ paddingLeft: 6 }}>m</div>
          <div />
        </div>
      ))}
      {expanded
        ? children.map((child) => (
            <DimensionTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeNodeId={activeNodeId}
              selectedGroupIds={selectedGroupIds}
              groupTotals={groupTotals}
              groupBreakdownRows={groupBreakdownRows}
              groupProps={groupProps}
              onNodeClick={onNodeClick}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  );
}

export function DimensionGroupPane() {
  const dimensionRoots = useAppStore((state) => state.dimensionRoots);
  const childCache = useAppStore((state) => state.childCache);
  const loadRoots = useAppStore((state) => state.loadRoots);
  const createFolder = useAppStore((state) => state.createFolder);
  const createDimensionGroupInFolderPath = useAppStore((state) => state.createDimensionGroupInFolderPath);
  const deleteNode = useAppStore((state) => state.deleteNode);
  const renameNode = useAppStore((state) => state.renameNode);
  const updateDimensionGroupColour = useAppStore((state) => state.updateDimensionGroupColour);
  const selectDimensionGroup = useAppStore((state) => state.selectDimensionGroup);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const selectedGroupIds = useAppStore((state) => state.selectedGroupIds);
  const activeBreadcrumb = useAppStore((state) => state.activeBreadcrumb);
  const overlayMeasurements = useAppStore((state) => state.overlayMeasurements);
  const overlayColour = useAppStore((state) => state.overlayColour);
  const deleteMeasurement = useAppStore((state) => state.deleteMeasurement);
  const groupProps = useAppStore((state) => state.groupProps);
  const scaleCache = useAppStore((state) => state.scaleCache);
  const saveGroupProps = useAppStore((state) => state.saveGroupProps);
  const listDimensionFolders = useAppStore((state) => state.listDimensionFolders);
  const copyDimensionGroup = useAppStore((state) => state.copyDimensionGroup);
  const dgPaneCommand = useAppStore((state) => state.dgPaneCommand);
  const setView3d = useAppStore((state) => state.setView3d);
  const setView3dMulti = useAppStore((state) => state.setView3dMulti);
  const setPitchDirectionMode = useAppStore((state) => state.setPitchDirectionMode);
  const pitchDirectionResult = useAppStore((state) => state.pitchDirectionResult);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNodeDto } | null>(null);
  const [pendingAddGroupPath, setPendingAddGroupPath] = useState<string | null>(null);
  const [pendingFolderParent, setPendingFolderParent] = useState<TreeNodeDto | null>(null);
  const [pendingRename, setPendingRename] = useState<TreeNodeDto | null>(null);
  const [pendingColour, setPendingColour] = useState<TreeNodeDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNodeDto | null>(null);
  const [pendingClearMeasures, setPendingClearMeasures] = useState(false);
  const [pendingProps, setPendingProps] = useState<{ node: TreeNodeDto; props: DimensionGroupPropsDto; framingWalls: FramingWallInput[] } | null>(null);
  const [pendingCopy, setPendingCopy] = useState<{ node: TreeNodeDto; folders: FolderOption[]; defaultFolderId: number | null } | null>(null);
  const [status, setStatus] = useState("");
  const [paneTab, setPaneTab] = useState<PaneTab>("Dimension Groups");
  const lastCommandSeq = useRef(0);
  // While true, the Properties dialog is hidden and the canvas is showing the pitch-direction
  // drag-to-pick gesture; `pendingProps` (node/framingWalls) is kept around so the dialog can
  // reopen once the pick resolves.
  const [pickingDirection, setPickingDirection] = useState(false);
  const lastPitchSeq = useRef(0);

  const scaleFor = useCallback(
    (drawingId: number, pageIndex: number) => scaleCache[`${drawingId}:${pageIndex}`]?.mm_per_point ?? null,
    [scaleCache],
  );

  // Gathers a framing group's walls (parsed geometry + per-page scale) for the calc.
  const framingWallsForGroup = useCallback(
    (groupId: number): FramingWallInput[] => {
      const walls: FramingWallInput[] = [];
      for (const measurement of overlayMeasurements) {
        if (measurement.dimension_group_id !== groupId) continue;
        let points: PagePoint[];
        try {
          points = JSON.parse(measurement.geometry_json);
        } catch {
          continue;
        }
        if (!Array.isArray(points)) continue;
        walls.push({
          id: measurement.id,
          points,
          mmPerPoint: scaleFor(measurement.drawing_id, measurement.page_index),
          framing: parseWallFraming(measurement.framing_json),
        });
      }
      return walls;
    },
    [overlayMeasurements, scaleFor],
  );

  // NZS 3604 lineal-metre breakdowns for the loaded timber-framing groups (drives the sidebar
  // total, the itemised component child rows, and the breakdown inspector).
  const groupFramingBreakdowns = useMemo(() => {
    const out: Record<number, FramingGroupBreakdown> = {};
    for (const idText of Object.keys(groupProps)) {
      const id = Number(idText);
      const props = groupProps[id];
      if (props?.measurement_type !== "timber_framing") continue;
      out[id] = aggregateFramingGroup(framingWallsForGroup(id), parseFramingSettings(props.framing_props_json));
    }
    return out;
  }, [groupProps, framingWallsForGroup]);

  const arraysForGroup = useCallback(
    (groupId: number): ArrayInput[] => {
      const arrays: ArrayInput[] = [];
      for (const measurement of overlayMeasurements) {
        if (measurement.dimension_group_id !== groupId) continue;
        let points: PagePoint[];
        try {
          points = JSON.parse(measurement.geometry_json);
        } catch {
          continue;
        }
        if (!Array.isArray(points)) continue;
        arrays.push({
          id: measurement.id,
          points,
          mmPerPoint: scaleFor(measurement.drawing_id, measurement.page_index),
          meta: parseArrayMeta(measurement.framing_json ?? null),
          polarity: measurement.polarity ?? 1,
        });
      }
      return arrays;
    },
    [overlayMeasurements, scaleFor],
  );

  // Member + blocking makeup for the loaded Joist/Rafter groups. Only built when the group
  // actually has blocking switched on — without it an array group's quantity is exactly what
  // `groupNetQuantity`/`deriveQuantity` already derive, and there's nothing to itemise.
  const groupArrayBreakdowns = useMemo(() => {
    const out: Record<number, ReturnType<typeof aggregateArrayGroup>> = {};
    for (const idText of Object.keys(groupProps)) {
      const id = Number(idText);
      const props = groupProps[id];
      if (props?.measurement_type !== "array") continue;
      const settings = parseJoistRafterSettings(props.framing_props_json);
      if (!settings.blockingOn) continue;
      out[id] = aggregateArrayGroup(arraysForGroup(id), settings, {
        pitchAngleDeg: props.pitch_angle_deg ?? 0,
        multiplier: props.default_multiplier ?? 1,
      });
    }
    return out;
  }, [groupProps, arraysForGroup]);

  // Live per-group totals. Framing groups roll up total lineal metres of timber, as do Joist/Rafter
  // groups with blocking (members + same-size blocking); the others use the standard CostX net
  // quantity. A Joist/Rafter group displaying as Count keeps its member count — blocking is lineal
  // timber and never changes how many joists were drawn.
  const groupTotals = useMemo(() => {
    const totals: Record<number, Quantity | null> = {};
    for (const idText of Object.keys(groupProps)) {
      const id = Number(idText);
      if (groupProps[id]?.measurement_type === "timber_framing") {
        const breakdown = groupFramingBreakdowns[id];
        totals[id] = breakdown && breakdown.matchingTotalM > 0 ? { value: breakdown.matchingTotalM, uom: "m" } : null;
        continue;
      }
      const arrayBreakdown = groupProps[id]?.default_display === "length" ? groupArrayBreakdowns[id] : undefined;
      if (arrayBreakdown) {
        totals[id] = Math.abs(arrayBreakdown.matchingTotalM) > 1e-9 ? { value: arrayBreakdown.matchingTotalM, uom: "m" } : null;
        continue;
      }
      const measurements = overlayMeasurements.filter((measurement) => measurement.dimension_group_id === id);
      totals[id] = groupNetQuantity(measurements, groupProps[id], scaleFor);
    }
    return totals;
  }, [groupProps, groupFramingBreakdowns, groupArrayBreakdowns, overlayMeasurements, scaleFor]);

  // Itemised child rows for the tree: the framing build-up, or a Joist/Rafter group's members +
  // blocking. Blocking of a different timber size lands in `overrides` (the accent-styled rows),
  // exactly like a framing lintel whose size differs from its group.
  const groupBreakdownRows = useMemo(() => {
    const out: Record<number, GroupBreakdownRows> = {};
    for (const idText of Object.keys(groupProps)) {
      const id = Number(idText);
      const framing = groupFramingBreakdowns[id];
      if (framing) {
        out[id] = {
          components: framing.components
            .filter((c) => !c.sizeOverride)
            .map((c) => ({ key: c.kind, label: c.count > 1 ? `${c.label} (${c.count})` : c.label, total: c.totalM })),
          overrides: framing.components
            .filter((c) => !!c.sizeOverride)
            .map((c) => ({ key: c.kind + c.sizeOverride, label: c.count > 1 ? `${c.label} (${c.count})` : c.label, total: c.totalM })),
        };
        continue;
      }
      const array = groupArrayBreakdowns[id];
      if (!array?.blockingSize) continue;
      // Same label shape as the framing build-up: "<kind>[ - <size>][ (<count>)]".
      const blockingLabel = array.blockingMatchesSize
        ? `Blocking${countSuffix(array.blockingCount)}`
        : `Blocking - ${sizeLabel(array.blockingSize)}${countSuffix(array.blockingCount)}`;
      out[id] = {
        components: [
          { key: "members", label: "Joists / Rafters", total: array.memberTotalM },
          ...(array.blockingMatchesSize ? [{ key: "blocking", label: blockingLabel, total: array.blockingTotalM }] : []),
        ],
        overrides: array.blockingMatchesSize
          ? []
          : [{ key: `blocking-${array.blockingSize}`, label: blockingLabel, total: array.blockingTotalM }],
      };
    }
    return out;
  }, [groupProps, groupFramingBreakdowns, groupArrayBreakdowns]);

  useEffect(() => {
    let cancelled = false;
    loadRoots("dimensions")
      .then(() => {
        if (!cancelled) setStatus("");
      })
      .catch((error) => {
        if (!cancelled) setStatus(`ERROR: ${error}`);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRoots]);

  async function handleNodeClick(node: TreeNodeDto, event?: MouseEvent) {
    if (node.node_type === "dimension_group") {
      const additive = Boolean(event && (event.ctrlKey || event.metaKey));
      setStatus("Loading measurements...");
      try {
        await selectDimensionGroup(node, additive);
        setSelectedFolderId(null);
        setStatus("");
      } catch (error) {
        setStatus(`ERROR: ${error}`);
      }
      return;
    }

    if (node.node_type === "folder") {
      setSelectedFolderId(node.id);
    }
  }

  function handleContextMenu(event: MouseEvent, node: TreeNodeDto) {
    event.preventDefault();
    if (node.node_type !== "folder" && node.node_type !== "dimension_group") return;
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  async function handleViewIn3D(node: TreeNodeDto) {
    await handleNodeClick(node);
    setView3dMulti(false);
    setView3d(true);
  }

  async function confirmAddGroup(
    folderPath: string,
    name: string,
    colour: string,
    measurementType: string,
    joistRafter?: { spacingM: number; framingSize: string },
  ) {
    setStatus("Adding dimension group...");
    try {
      await createDimensionGroupInFolderPath(folderPath, name, colour, measurementType, joistRafter);
      setPendingAddGroupPath(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmAddFolder(name: string) {
    if (!pendingFolderParent) return;
    setStatus("Adding folder...");
    try {
      await createFolder("dimensions", pendingFolderParent.id, name);
      setPendingFolderParent(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmRename(name: string) {
    if (!pendingRename) return;
    setStatus("Renaming...");
    try {
      await renameNode(pendingRename, name);
      setPendingRename(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmColour(colour: string) {
    if (!pendingColour) return;
    setStatus("Updating colour...");
    try {
      await updateDimensionGroupColour(pendingColour.id, colour);
      setPendingColour(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmDeleteNode() {
    if (!pendingDelete) return;
    setStatus(`Deleting ${pendingDelete.name}...`);
    try {
      await deleteNode(pendingDelete);
      setPendingDelete(null);
      setSelectedFolderId(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function openProperties(node: TreeNodeDto) {
    setStatus("Loading properties...");
    try {
      const props = await invoke<DimensionGroupPropsDto>("get_dimension_group_props", { nodeId: node.id });
      setPendingProps({ node, props, framingWalls: framingWallsForGroup(node.id) });
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmProperties(props: DimensionGroupPropsDto) {
    setStatus("Saving properties...");
    try {
      await saveGroupProps(props);
      setPendingProps(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function openCopyDialog(node: TreeNodeDto) {
    setStatus("Loading folders...");
    try {
      const folders = await listDimensionFolders();
      // Preselect the source group's own folder when its path can be resolved.
      const parentPath = activeBreadcrumb.split(" / ").filter(Boolean).slice(0, -1).join("/");
      const defaultFolderId = folders.find((folder) => folder.path === parentPath)?.id ?? folders[0]?.id ?? null;
      setPendingCopy({ node, folders, defaultFolderId });
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmCopy(targetFolderId: number, name: string, copyDimensions: boolean) {
    if (!pendingCopy) return;
    setStatus("Copying dimension group...");
    try {
      await copyDimensionGroup(pendingCopy.node.id, targetFolderId, name, copyDimensions);
      setPendingCopy(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  // Ribbon → pane bridge: the ribbon's Dimension Group buttons bump `dgPaneCommand.seq`;
  // open the matching dialog for the active group. Properties/Copy build a lightweight node
  // from the active id + breadcrumb name (the tree's childCache may be cleared after refreshes).
  useEffect(() => {
    if (!dgPaneCommand || dgPaneCommand.seq === lastCommandSeq.current) return;
    lastCommandSeq.current = dgPaneCommand.seq;

    if (dgPaneCommand.action === "add") {
      setPendingAddGroupPath("");
      return;
    }

    if (activeDimensionGroupId === null) return;
    const name = activeBreadcrumb.split(" / ").filter(Boolean).pop() ?? "Dimension Group";
    const node: TreeNodeDto = {
      id: activeDimensionGroupId,
      tree: "dimensions",
      node_type: "dimension_group",
      parent_id: null,
      name,
      sort_order: 0,
      has_children: false,
      file_path: null,
      page_count: null,
      uom: null,
      colour: null,
      framing_size: null,
      measurement_type: null,
    };

    if (dgPaneCommand.action === "properties") {
      void openProperties(node);
    } else if (dgPaneCommand.action === "copy") {
      void openCopyDialog(node);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dgPaneCommand]);

  // Pitch-direction "Pick on Drawing": hides the Properties dialog and hands the canvas a
  // drag-to-pick, axis-locked gesture. Called with a full snapshot of the dialog's in-progress
  // edits so nothing typed is lost while the dialog is hidden.
  function startPitchDirectionPick(snapshot: DimensionGroupPropsDto) {
    setPendingProps((prev) => (prev ? { ...prev, props: snapshot } : prev));
    setPickingDirection(true);
    setPitchDirectionMode(true);
  }

  // Canvas → pane bridge for the pitch-direction pick: the canvas bumps `pitchDirectionResult.seq`
  // with the picked axis (or `null` if cancelled via Esc) when the drag resolves. Merge the axis
  // into the stashed snapshot and reopen the dialog.
  useEffect(() => {
    if (!pickingDirection || !pitchDirectionResult || pitchDirectionResult.seq === lastPitchSeq.current) return;
    lastPitchSeq.current = pitchDirectionResult.seq;
    const axis = pitchDirectionResult.axis;
    if (axis !== null) {
      setPendingProps((prev) => (prev ? { ...prev, props: { ...prev.props, pitch_direction_deg: axis === "y" ? 90 : 0 } } : prev));
    }
    setPickingDirection(false);
  }, [pickingDirection, pitchDirectionResult]);

  // Clears the active group's measurements — the only way to remove drawn dimensions
  // until per-measurement delete lands in M5. Scoped to the active group so it never
  // touches other concurrently-rendered groups.
  const activeGroupMeasurements = overlayMeasurements.filter(
    (measurement) => measurement.dimension_group_id === activeDimensionGroupId,
  );

  async function handleClearMeasures() {
    setPendingClearMeasures(false);
    setStatus("Clearing measurements...");
    try {
      for (const measurement of [...activeGroupMeasurements]) {
        await deleteMeasurement(measurement.id);
      }
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }
  // -----------------------------------------------------------------------------

  const activeNodeId = activeDimensionGroupId ?? selectedFolderId;

  return (
    <section style={{ display: "flex", minHeight: 0, flexDirection: "column", background: theme.bg.pane }}>
      <div style={{ display: "flex", height: theme.tabHeight, background: theme.bg.tabBar, borderBottom: `1px solid ${theme.border.subtle}` }}>
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setPaneTab(tab)}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 10px",
              borderRight: `1px solid ${theme.border.subtle}`,
              background: paneTab === tab ? theme.bg.pane : theme.bg.tabBar,
              color: paneTab === tab ? theme.text.primary : theme.text.disabled,
              cursor: "pointer",
              userSelect: "none",
              fontSize: 12,
            }}
          >
            {tab}
          </div>
        ))}
      </div>
      {paneTab === "Rate Library" ? (
        <RateLibraryPane />
      ) : (
        <>
      <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: `1px solid ${theme.border.subtle}` }}>
        <button
          onClick={() => setPendingFolderParent({ id: 0, tree: "dimensions", node_type: "folder", parent_id: null, name: "root", sort_order: 0, has_children: false, file_path: null, page_count: null, uom: null, colour: null, framing_size: null, measurement_type: null })}
          style={{
            height: 24,
            padding: "0 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Add Folder
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: gridColumns, minWidth: 360, height: 24, borderBottom: `1px solid ${theme.border.subtle}`, background: theme.bg.shell, color: theme.text.primary, fontSize: 12 }}>
        <div style={{ borderRight: `1px solid ${theme.border.subtle}` }} />
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>
          <span>Name</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>Quantity</div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>UOM</div>
        <div />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingTop: 2 }}>
        {dimensionRoots.length === 0 ? <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No dimension folders yet</div> : null}
        {dimensionRoots.map((node) => (
          <DimensionTreeRow
            key={node.id}
            node={node}
            depth={0}
            activeNodeId={activeNodeId}
            selectedGroupIds={selectedGroupIds}
            groupTotals={groupTotals}
            groupBreakdownRows={groupBreakdownRows}
            groupProps={groupProps}
            onNodeClick={handleNodeClick}
            onContextMenu={handleContextMenu}
          />
        ))}
        {status ? <div style={{ padding: 8, color: theme.danger, fontSize: 12 }}>{status}</div> : null}
      </div>
      <div
        style={{
          minHeight: 44,
          padding: "6px 8px",
          borderTop: `1px solid ${theme.border.subtle}`,
          color: theme.text.secondary,
          fontSize: 12,
        }}
      >
        {activeDimensionGroupId ? (
          <>
            <div style={{ color: theme.text.primary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeBreadcrumb}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <span style={{ width: 10, height: 10, background: overlayColour, border: `1px solid ${theme.border.divider}` }} />
              <span>{activeGroupMeasurements.length} dimensions</span>
              {activeDimensionGroupId !== null && groupTotals[activeDimensionGroupId] ? (
                <span style={{ marginLeft: "auto", color: theme.text.primary }}>
                  {quantityValueText(groupTotals[activeDimensionGroupId]!)} {groupTotals[activeDimensionGroupId]!.uom}
                </span>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button
                onClick={() => setPendingClearMeasures(true)}
                disabled={activeGroupMeasurements.length === 0}
                title="Delete the active group's measurements"
                style={{
                  height: 22,
                  padding: "0 8px",
                  background: theme.bg.input,
                  color: activeGroupMeasurements.length === 0 ? theme.text.disabled : theme.text.primary,
                  border: `1px solid ${theme.border.divider}`,
                  cursor: activeGroupMeasurements.length === 0 ? "default" : "pointer",
                  fontSize: 11,
                }}
              >
                Clear measures
              </button>
            </div>
          </>
        ) : (
          "No dimension group selected"
        )}
      </div>
        </>
      )}
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={
            contextMenu.node.node_type === "folder"
              ? [
                  {
                    label: "Add Sub-folder",
                    action: () => setPendingFolderParent(contextMenu.node),
                  },
                  {
                    label: "Add Dimension Group",
                    action: () => setPendingAddGroupPath(findPath(dimensionRoots, contextMenu.node.id, childCache)?.join("/") ?? ""),
                  },
                  {
                    label: "Rename Folder",
                    action: () => setPendingRename(contextMenu.node),
                  },
                  {
                    label: "Delete Folder",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
              : [
                  {
                    label: "Select Group",
                    action: () => {
                      void handleNodeClick(contextMenu.node);
                    },
                  },
                  {
                    label: "View in 3D",
                    action: () => {
                      void handleViewIn3D(contextMenu.node);
                    },
                  },
                  {
                    label: "Properties",
                    action: () => {
                      void openProperties(contextMenu.node);
                    },
                  },
                  {
                    label: "Rename Group",
                    action: () => setPendingRename(contextMenu.node),
                  },
                  {
                    label: "Change Colour",
                    action: () => setPendingColour(contextMenu.node),
                  },
                  {
                    label: "Delete Dimension Group",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
          }
        />
      ) : null}
      {pendingAddGroupPath !== null ? (
        <DimensionGroupDialog
          defaultPath={pendingAddGroupPath}
          roots={dimensionRoots}
          childCache={childCache}
          onCancel={() => setPendingAddGroupPath(null)}
          onConfirm={(folderPath, name, colour, measurementType, joistRafter) => {
            void confirmAddGroup(folderPath, name, colour, measurementType, joistRafter);
          }}
        />
      ) : null}
      {pendingFolderParent ? (
        <TextInputDialog
          title={pendingFolderParent.id === 0 ? "Add folder" : "Add sub-folder"}
          label="Folder name"
          initialValue=""
          confirmLabel="Add Folder"
          onCancel={() => setPendingFolderParent(null)}
          onConfirm={(name) => {
            if (pendingFolderParent.id === 0) {
              setStatus("Adding folder...");
              createFolder("dimensions", null, name)
                .then(() => setStatus(""))
                .catch((error) => setStatus(`ERROR: ${error}`))
                .finally(() => setPendingFolderParent(null));
            } else {
              void confirmAddFolder(name);
            }
          }}
        />
      ) : null}
      {pendingRename ? (
        <TextInputDialog
          title={pendingRename.node_type === "folder" ? "Rename folder" : "Rename dimension group"}
          label="Name"
          initialValue={pendingRename.name}
          confirmLabel="Rename"
          onCancel={() => setPendingRename(null)}
          onConfirm={(name) => {
            void confirmRename(name);
          }}
        />
      ) : null}
      {pendingColour ? (
        <ColourDialog
          title="Change dimension group colour"
          initialColour={pendingColour.colour ?? "#4A9EFF"}
          onCancel={() => setPendingColour(null)}
          onConfirm={(colour) => {
            void confirmColour(colour);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.node_type === "folder" ? "Delete dimension folder" : "Delete dimension group"}
          body={
            pendingDelete.node_type === "folder"
              ? `This will permanently delete "${pendingDelete.name}".\n\nAll child folders, dimension groups, and measurements inside this folder will be removed from the project.\n\nThis cannot be undone.`
              : `This will permanently delete "${pendingDelete.name}".\n\nAll measurements stored in this dimension group will be removed from the project.\n\nThis cannot be undone.`
          }
          confirmLabel={pendingDelete.node_type === "folder" ? "Delete Folder" : "Delete Dimension Group"}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void confirmDeleteNode();
          }}
        />
      ) : null}
      {pendingClearMeasures ? (
        <ConfirmDialog
          title="Clear measures"
          body={`This will permanently delete all ${activeGroupMeasurements.length} measurement(s) in this dimension group.\n\nThis cannot be undone.`}
          confirmLabel="Clear Measures"
          onCancel={() => setPendingClearMeasures(false)}
          onConfirm={() => {
            void handleClearMeasures();
          }}
        />
      ) : null}
      {pendingProps && !pickingDirection ? (
        <DimensionGroupPropertiesDialog
          groupName={pendingProps.node.name}
          initial={pendingProps.props}
          framingWalls={pendingProps.framingWalls}
          onCancel={() => setPendingProps(null)}
          onConfirm={(props) => {
            void confirmProperties(props);
          }}
          onPickDirection={startPitchDirectionPick}
        />
      ) : null}
      {pendingCopy ? (
        <DimensionGroupCopyDialog
          sourceName={pendingCopy.node.name}
          folders={pendingCopy.folders}
          defaultFolderId={pendingCopy.defaultFolderId}
          onCancel={() => setPendingCopy(null)}
          onConfirm={(targetFolderId, name, copyDimensions) => {
            void confirmCopy(targetFolderId, name, copyDimensions);
          }}
        />
      ) : null}
    </section>
  );
}
