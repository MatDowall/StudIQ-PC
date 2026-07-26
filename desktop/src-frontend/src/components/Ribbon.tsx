import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";
import { useAppStore } from "../store/appStore";
import { WorkbookRibbon } from "./WorkbookRibbon";
import { MultiPage3DDialog } from "./MultiPage3DDialog";
import { OpeningDialog } from "./OpeningDialog";
import { DEFAULT_DOOR, DEFAULT_WINDOW, type OpeningTemplate } from "../lib/framing";

// Material Symbol icon name for each ribbon button label.
const BUTTON_ICONS: Record<string, string> = {
  Add: "add",
  Properties: "tune",
  Copy: "copy_all",
  Point: "polyline",
  Line: "show_chart",
  "Plan View": "architecture",
  "View in 3D": "view_in_ar",
  Dim: "contrast",
  Geometry: "my_location",
  "Elevation PDF": "picture_as_pdf",
  "Set Scale": "straighten",
  "Rotate Left": "rotate_90_degrees_ccw",
  "Rotate Right": "rotate_90_degrees_cw",
  "Flip Horizontal": "flip",
  "Flip Vertical": "flip",
};

// Flip Vertical reuses the "flip" glyph (which is drawn horizontal) rotated 90° — per
// the CostX icon reference, there's no separate vertical-flip glyph in Material Symbols.
const ICON_ROTATION: Record<string, number> = {
  "Flip Vertical": 90,
};

const groups = [
  { label: "Dimension Group", tools: ["Add", "Properties", "Copy", "Import", "Export"] },
  { label: "Type", tools: ["Point", "Line"] },
  { label: "Drawing", tools: ["Plan View", "View in 3D", "Dim", "Elevation PDF", "Set Scale"] },
  { label: "Snap", tools: ["Geometry"] },
  { label: "Takeoff Items", tools: ["Rotate Left", "Rotate Right", "Flip Horizontal", "Flip Vertical"] },
];

const TAKEOFF_ITEM_COMMANDS: Record<string, "rotateCcw" | "rotateCw" | "flipH" | "flipV"> = {
  "Rotate Left": "rotateCcw",
  "Rotate Right": "rotateCw",
  "Flip Horizontal": "flipH",
  "Flip Vertical": "flipV",
};

const DIMENSION_GROUP_TOOLS: Record<string, "add" | "properties" | "copy"> = {
  Add: "add",
  Properties: "properties",
  Copy: "copy",
};

function Icon({ name, size = 14, rotate = 0, disabled = false }: { name: string; size?: number; rotate?: number; disabled?: boolean }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size,
        lineHeight: 1,
        userSelect: "none",
        flexShrink: 0,
        color: disabled ? theme.text.disabled : theme.iconAccent,
        transform: rotate ? `rotate(${rotate}deg)` : undefined,
      }}
    >
      {name}
    </span>
  );
}

// A thin vertical rule separating logical sub-clusters of buttons within one ribbon group
// (native ribbons commonly break a single labelled group into a few sub-clusters this way).
function GroupDivider() {
  return <div style={{ width: 1, alignSelf: "stretch", background: theme.border.divider, flexShrink: 0 }} />;
}

function RibbonToolButton({
  icon,
  label,
  active,
  enabled,
  onClick,
  title,
  rotate = 0,
}: {
  icon: string;
  label: string;
  active: boolean;
  enabled: boolean;
  onClick?: () => void;
  title: string;
  rotate?: number;
}) {
  return (
    <button
      disabled={!enabled}
      onClick={enabled ? onClick : undefined}
      title={title}
      className={`ribbon-btn${active ? " is-active" : ""}`}
      style={{
        minWidth: 44,
        height: 50,
        padding: "4px 6px 2px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        overflow: "hidden",
        fontSize: 9,
        cursor: enabled ? "pointer" : "not-allowed",
        flexShrink: 0,
      }}
    >
      <Icon name={icon} size={30} rotate={rotate} disabled={!enabled} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "13px" }}>{label}</span>
    </button>
  );
}

export function Ribbon() {
  const activeProject = useAppStore((state) => state.activeProject);
  const exportFramingElevations = useAppStore((state) => state.exportFramingElevations);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const requestDgPaneCommand = useAppStore((state) => state.requestDgPaneCommand);
  const requestViewerCommand = useAppStore((state) => state.requestViewerCommand);
  const selectedMeasurementIds = useAppStore((state) => state.selectedMeasurementIds);
  const drawingType = useAppStore((state) => state.drawingType);
  const setDrawingType = useAppStore((state) => state.setDrawingType);
  const view3d = useAppStore((state) => state.view3d);
  const setView3d = useAppStore((state) => state.setView3d);
  const setView3dMulti = useAppStore((state) => state.setView3dMulti);
  const multiPage3DDialogOpen = useAppStore((state) => state.multiPage3DDialogOpen);
  const setMultiPage3DDialogOpen = useAppStore((state) => state.setMultiPage3DDialogOpen);
  const drawingDimmer = useAppStore((state) => state.drawingDimmer);
  const setDrawingDimmer = useAppStore((state) => state.setDrawingDimmer);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const setSnapEnabled = useAppStore((state) => state.setSnapEnabled);
  const activeTab = useAppStore((state) => state.activeTab);
  const currentDocument = useAppStore((state) => state.currentDocument);
  const pageScale = useAppStore((state) => state.pageScale);
  const calibrating = useAppStore((state) => state.calibrating);
  const setCalibrating = useAppStore((state) => state.setCalibrating);
  const viewerMode = useAppStore((state) => state.viewerMode);
  const setViewerMode = useAppStore((state) => state.setViewerMode);
  const drawPolarity = useAppStore((state) => state.drawPolarity);
  const setDrawPolarity = useAppStore((state) => state.setDrawPolarity);
  const groupProps = useAppStore((state) => state.groupProps);
  const openingPlacement = useAppStore((state) => state.openingPlacement);
  const setOpeningPlacement = useAppStore((state) => state.setOpeningPlacement);
  const arrayTrimMode = useAppStore((state) => state.arrayTrimMode);
  const setArrayTrimMode = useAppStore((state) => state.setArrayTrimMode);
  const setArrayTrimType = useAppStore((state) => state.setArrayTrimType);

  const [exportStatus, setExportStatus] = useState("");
  const [show3dMenu, setShow3dMenu] = useState(false);
  const view3dWrapperRef = useRef<HTMLDivElement | null>(null);
  const view3dMenuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showTrimMenu, setShowTrimMenu] = useState(false);
  const trimWrapperRef = useRef<HTMLDivElement | null>(null);
  const trimMenuRef = useRef<HTMLDivElement | null>(null);
  const [trimMenuPos, setTrimMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [openingDialog, setOpeningDialog] = useState<OpeningTemplate | null>(null);

  useEffect(() => {
    if (!show3dMenu) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (view3dWrapperRef.current?.contains(target)) return;
      if (view3dMenuRef.current?.contains(target)) return;
      setShow3dMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [show3dMenu]);

  useEffect(() => {
    if (!showTrimMenu) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (trimWrapperRef.current?.contains(target)) return;
      if (trimMenuRef.current?.contains(target)) return;
      setShowTrimMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showTrimMenu]);

  const dimActive = drawingDimmer < 1;
  const activeIsFraming =
    activeDimensionGroupId !== null && groupProps[activeDimensionGroupId]?.measurement_type === "timber_framing";
  const activeIsArray =
    activeDimensionGroupId !== null && groupProps[activeDimensionGroupId]?.measurement_type === "array";

  async function handleExportElevations() {
    try {
      const path = await exportFramingElevations();
      setExportStatus(path ? "Elevation PDF saved." : "");
      if (path) setTimeout(() => setExportStatus(""), 2500);
    } catch (err) {
      setExportStatus(`Elevation export failed: ${err}`);
    }
  }

  return (
    <>
      <div
        style={{
          gridColumn: "1 / 3",
          display: "flex",
          alignItems: "stretch",
          height: theme.ribbonHeight,
          overflowX: "auto",
          overflowY: "hidden",
          background: theme.bg.ribbon,
          borderBottom: `1px solid ${theme.border.subtle}`,
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
        }}
      >
        {activeTab === "workbook" ? (
          <WorkbookRibbon />
        ) : (
          groups.map((group, groupIndex) => {
            const isDrawingGroup = group.label === "Drawing";
            const isTakeoffItemGroup = group.label === "Takeoff Items";
            return (
              <div
                key={group.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minWidth: groupIndex === 0 ? 138 : isDrawingGroup ? 244 : isTakeoffItemGroup ? 600 : 72,
                  padding: "4px 8px 0",
                  borderRight: `1px solid ${theme.border.divider}`,
                }}
              >
                <div style={{ display: "flex", gap: 5, alignItems: "center", overflow: "hidden" }}>
                  {(groupIndex === 0 ? group.tools.slice(0, 3) : group.tools).map((tool, toolIndex) => {
                    const dgCommand = groupIndex === 0 ? DIMENSION_GROUP_TOOLS[tool] : undefined;
                    const isTypeToggle = group.label === "Type" && (tool === "Point" || tool === "Line");
                    const isViewToggle = group.label === "Drawing" && (tool === "Plan View" || tool === "View in 3D");
                    const isDimToggle = group.label === "Drawing" && tool === "Dim";
                    const isSnapToggle = group.label === "Snap" && tool === "Geometry";
                    const isElevationExport = group.label === "Drawing" && tool === "Elevation PDF";
                    const isSetScale = group.label === "Drawing" && tool === "Set Scale";
                    const takeoffCommand = isTakeoffItemGroup ? TAKEOFF_ITEM_COMMANDS[tool] : undefined;

                    let enabled: boolean;
                    let cursor: string;
                    let active: boolean;

                    if (dgCommand !== undefined) {
                      enabled = dgCommand === "add" || activeDimensionGroupId !== null;
                      active = false;
                      cursor = !enabled ? "not-allowed" : "pointer";
                    } else if (isTypeToggle) {
                      enabled = true;
                      active = (tool === "Point" && drawingType === "point") || (tool === "Line" && drawingType === "line");
                      cursor = "pointer";
                    } else if (isViewToggle) {
                      enabled = true;
                      active = (tool === "Plan View" && !view3d) || (tool === "View in 3D" && view3d);
                      cursor = "pointer";
                    } else if (isDimToggle) {
                      enabled = true;
                      active = dimActive;
                      cursor = "pointer";
                    } else if (isSnapToggle) {
                      enabled = true;
                      active = snapEnabled;
                      cursor = "pointer";
                    } else if (isElevationExport) {
                      enabled = !view3d;
                      active = false;
                      cursor = enabled ? "pointer" : "not-allowed";
                    } else if (isSetScale) {
                      enabled = currentDocument !== null;
                      active = calibrating;
                      cursor = enabled ? "pointer" : "not-allowed";
                    } else if (takeoffCommand !== undefined) {
                      enabled = selectedMeasurementIds.length > 0;
                      active = false;
                      cursor = enabled ? "pointer" : "not-allowed";
                    } else {
                      enabled = toolIndex === 0;
                      active = enabled;
                      cursor = "default";
                    }

                    const handleClick = dgCommand !== undefined && enabled
                      ? () => requestDgPaneCommand(dgCommand)
                      : takeoffCommand !== undefined && enabled
                        ? () => requestViewerCommand(takeoffCommand)
                        : isTypeToggle
                        ? () => setDrawingType(tool === "Line" ? "line" : "point")
                        : isViewToggle
                          ? () => {
                              if (tool === "View in 3D") {
                                setView3d(true);
                                setView3dMulti(false);
                              } else {
                                setView3d(false);
                              }
                            }
                          : isDimToggle
                            ? () => setDrawingDimmer(dimActive ? 1 : 0.4)
                            : isSnapToggle
                              ? () => setSnapEnabled(!snapEnabled)
                              : isElevationExport
                                ? () => { void handleExportElevations(); }
                                : isSetScale && enabled
                                  ? () => setCalibrating(!calibrating)
                                  : undefined;

                    const iconName = BUTTON_ICONS[tool];
                    const isView3d = tool === "View in 3D";
                    const label = isSetScale ? (pageScale ? "Rescale" : "Set Scale") : tool;

                    const isDisabled = !enabled && !isTypeToggle;
                    const button = (
                      <button
                        key={`${group.label}-${tool}`}
                        disabled={isDisabled}
                        onClick={handleClick}
                        title={
                          takeoffCommand !== undefined && !enabled
                            ? `${tool} (select a takeoff item first)`
                            : isSetScale
                              ? pageScale
                                ? "Rescale the page (draw a new reference line)"
                                : "Set the page scale by drawing a line over a known dimension"
                              : tool
                        }
                        className={`ribbon-btn${active ? " is-active" : ""}`}
                        style={{
                          minWidth: 44,
                          height: 50,
                          padding: "4px 6px 2px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 1,
                          overflow: "hidden",
                          fontSize: 9,
                          cursor,
                          flexShrink: 0,
                        }}
                      >
                        {iconName ? <Icon name={iconName} size={30} rotate={ICON_ROTATION[tool] ?? 0} disabled={isDisabled} /> : null}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "13px" }}>
                          {label}
                        </span>
                      </button>
                    );

                    if (!isView3d) return button;

                    return (
                      <div key={`${group.label}-${tool}`} ref={view3dWrapperRef} style={{ display: "flex", alignItems: "stretch", height: 50, flexShrink: 0 }}>
                        {button}
                        <button
                          onClick={(e) => {
                            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom, left: rect.left });
                            setShow3dMenu((v) => !v);
                          }}
                          title="3D view options"
                          className={`ribbon-btn${active ? " is-active" : ""}`}
                          style={{
                            width: 16,
                            height: 50,
                            padding: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            borderRadius: "0 4px 4px 0",
                            marginLeft: -1,
                            cursor: "pointer",
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16, lineHeight: 1, color: theme.iconAccent }}>
                            arrow_drop_down
                          </span>
                        </button>
                        {show3dMenu && menuPos
                          ? createPortal(
                          <div
                            ref={view3dMenuRef}
                            style={{
                              position: "fixed",
                              top: menuPos.top,
                              left: menuPos.left,
                              zIndex: 1200,
                              minWidth: 160,
                              background: theme.bg.pane,
                              border: `1px solid ${theme.border.divider}`,
                              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                              fontSize: 11,
                            }}
                          >
                            <button
                              onClick={() => {
                                setView3d(true);
                                setView3dMulti(false);
                                setShow3dMenu(false);
                              }}
                              className="ribbon-menu-item"
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "6px 10px",
                                color: theme.text.primary,
                                border: "none",
                                cursor: "pointer",
                              }}
                            >
                              Current Page
                            </button>
                            <button
                              onClick={() => {
                                setMultiPage3DDialogOpen(true);
                                setShow3dMenu(false);
                              }}
                              className="ribbon-menu-item"
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "6px 10px",
                                color: theme.text.primary,
                                border: "none",
                                borderTop: `1px solid ${theme.border.subtle}`,
                                cursor: "pointer",
                              }}
                            >
                              View Multiple Pages...
                            </button>
                          </div>,
                          document.body,
                        )
                          : null}
                      </div>
                    );
                  })}
                  {isTakeoffItemGroup ? (
                    <>
                      <GroupDivider />
                      <RibbonToolButton
                        icon="edit"
                        label="Add"
                        active={viewerMode === "add"}
                        enabled={activeDimensionGroupId !== null}
                        onClick={() => setViewerMode("add")}
                        title="Add dimensions (click to place)"
                      />
                      <RibbonToolButton
                        icon="select"
                        label="Select"
                        active={viewerMode === "select"}
                        enabled={activeDimensionGroupId !== null}
                        onClick={() => setViewerMode("select")}
                        title="Select / edit dimensions (Del to delete, drag vertices to move)"
                      />
                      <GroupDivider />
                      <RibbonToolButton
                        icon="rectangle_add"
                        label="Positive"
                        active={drawPolarity === 1}
                        enabled={activeDimensionGroupId !== null && viewerMode === "add" && !activeIsFraming && !activeIsArray}
                        onClick={() => setDrawPolarity(1)}
                        title="Draw positive dimensions (add)"
                      />
                      <RibbonToolButton
                        icon="low_density"
                        label="Negative"
                        active={drawPolarity === -1}
                        enabled={activeDimensionGroupId !== null && viewerMode === "add" && !activeIsFraming && !activeIsArray}
                        onClick={() => setDrawPolarity(-1)}
                        title="Draw negative dimensions (deduct/cutout)"
                      />
                      <GroupDivider />
                      <RibbonToolButton
                        icon="door_front"
                        label={openingPlacement?.kind === "door" ? "Placing…" : "Add Door"}
                        active={openingPlacement?.kind === "door"}
                        enabled={activeIsFraming}
                        onClick={() =>
                          openingPlacement?.kind === "door" ? setOpeningPlacement(null) : setOpeningDialog(DEFAULT_DOOR)
                        }
                        title={
                          openingPlacement?.kind === "door"
                            ? "Placing door — click a wall to place it (click again to cancel)"
                            : "Insert a door: set the opening, then click on a wall to place it"
                        }
                      />
                      <RibbonToolButton
                        icon="window_closed"
                        label={openingPlacement?.kind === "window" ? "Placing…" : "Add Window"}
                        active={openingPlacement?.kind === "window"}
                        enabled={activeIsFraming}
                        onClick={() =>
                          openingPlacement?.kind === "window" ? setOpeningPlacement(null) : setOpeningDialog(DEFAULT_WINDOW)
                        }
                        title={
                          openingPlacement?.kind === "window"
                            ? "Placing window — click a wall to place it (click again to cancel)"
                            : "Insert a window: set the opening, then click on a wall to place it"
                        }
                      />
                      <GroupDivider />
                      <div ref={trimWrapperRef} style={{ display: "flex", alignItems: "stretch", height: 50, flexShrink: 0 }}>
                        <RibbonToolButton
                          icon="content_cut"
                          label="Trim"
                          active={arrayTrimMode}
                          enabled={activeIsArray}
                          onClick={() => setArrayTrimMode(!arrayTrimMode)}
                          title="Trim array: draw a cut line or box to clip array members"
                        />
                        <button
                          disabled={!activeIsArray}
                          onClick={(e) => {
                            if (!activeIsArray) return;
                            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                            setTrimMenuPos({ top: rect.bottom, left: rect.left });
                            setShowTrimMenu((v) => !v);
                          }}
                          title="Trim options"
                          className={`ribbon-btn${arrayTrimMode ? " is-active" : ""}`}
                          style={{
                            width: 16,
                            height: 50,
                            padding: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            borderRadius: "0 4px 4px 0",
                            marginLeft: -1,
                            cursor: activeIsArray ? "pointer" : "not-allowed",
                          }}
                        >
                          <span
                            className="material-symbols-outlined"
                            style={{ fontSize: 16, lineHeight: 1, color: activeIsArray ? theme.iconAccent : theme.text.disabled }}
                          >
                            arrow_drop_down
                          </span>
                        </button>
                        {showTrimMenu && trimMenuPos
                          ? createPortal(
                            <div
                              ref={trimMenuRef}
                              style={{
                                position: "fixed",
                                top: trimMenuPos.top,
                                left: trimMenuPos.left,
                                zIndex: 1200,
                                minWidth: 140,
                                background: theme.bg.pane,
                                border: `1px solid ${theme.border.divider}`,
                                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                                fontSize: 11,
                              }}
                            >
                              <button
                                onClick={() => {
                                  setArrayTrimType("line");
                                  setArrayTrimMode(true);
                                  setShowTrimMenu(false);
                                }}
                                className="ribbon-menu-item"
                                style={{
                                  display: "block",
                                  width: "100%",
                                  textAlign: "left",
                                  padding: "6px 10px",
                                  color: theme.text.primary,
                                  border: "none",
                                  cursor: "pointer",
                                }}
                              >
                                Trim: Line
                              </button>
                              <button
                                onClick={() => {
                                  setArrayTrimType("box");
                                  setArrayTrimMode(true);
                                  setShowTrimMenu(false);
                                }}
                                className="ribbon-menu-item"
                                style={{
                                  display: "block",
                                  width: "100%",
                                  textAlign: "left",
                                  padding: "6px 10px",
                                  color: theme.text.primary,
                                  border: "none",
                                  borderTop: `1px solid ${theme.border.subtle}`,
                                  cursor: "pointer",
                                }}
                              >
                                Trim: Box
                              </button>
                            </div>,
                            document.body,
                          )
                          : null}
                      </div>
                    </>
                  ) : null}
                </div>
                {isDrawingGroup && dimActive ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: "auto", paddingBottom: 3 }}>
                    <input
                      type="range"
                      min={0.1}
                      max={0.95}
                      step={0.05}
                      value={drawingDimmer}
                      onChange={(e) => setDrawingDimmer(Number(e.target.value))}
                      style={{ flex: 1, height: 12, cursor: "pointer", accentColor: theme.accent }}
                    />
                    <span style={{ fontSize: 9, color: theme.text.secondary, flexShrink: 0 }}>
                      {Math.round(drawingDimmer * 100)}%
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: "auto",
                      paddingBottom: 3,
                      fontSize: 10,
                      lineHeight: "12px",
                      color: theme.text.muted,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {group.label}
                  </div>
                )}
              </div>
            );
          })
        )}
        {activeProject ? (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 280,
              maxWidth: 600,
              padding: "0 12px",
              borderLeft: `1px solid ${theme.border.divider}`,
              color: theme.text.primary,
              fontSize: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.name}</span>
            <span style={{ color: theme.text.secondary }}>|</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.client}</span>
            <span style={{ color: theme.text.secondary }}>|</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.contract_number}</span>
            {exportStatus ? (
              <span style={{ color: theme.text.secondary, fontSize: 11, flexShrink: 0 }}>{exportStatus}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      {multiPage3DDialogOpen ? <MultiPage3DDialog onCancel={() => setMultiPage3DDialogOpen(false)} /> : null}
      {openingDialog ? (
        <OpeningDialog
          title={openingDialog.kind === "window" ? "Add Window" : "Add Door"}
          initial={openingDialog}
          confirmLabel={openingDialog.kind === "window" ? "Place Window" : "Place Door"}
          onCancel={() => setOpeningDialog(null)}
          onConfirm={(template) => {
            setOpeningPlacement(template);
            setOpeningDialog(null);
          }}
        />
      ) : null}
    </>
  );
}
