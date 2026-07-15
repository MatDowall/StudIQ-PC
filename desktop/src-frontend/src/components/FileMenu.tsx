import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { ProjectInfoDialog } from "./ProjectInfoDialog";
import { ErrorDialog } from "./ErrorDialog";
import { ExportExcelDialog } from "./ExportExcelDialog";
import { MenuItem, TopMenu } from "./MenuBar";
import type { FlattenExportLevels } from "../store/appStore";

export function FileMenu() {
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [showExportExcel, setShowExportExcel] = useState(false);
  const [status, setStatus] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeProject = useAppStore((state) => state.activeProject);
  const closeProject = useAppStore((state) => state.closeProject);
  const exportProject = useAppStore((state) => state.exportProject);
  const exportPackage = useAppStore((state) => state.exportPackage);
  const gridApi = useAppStore((state) => state.workbookGridApi);

  async function handleExportProject() {
    if (!activeProject) return;
    const dest = await save({
      defaultPath: activeProject.name + ".tcop",
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
    });
    if (!dest || typeof dest !== "string") return;
    try {
      await exportProject(dest);
      setStatus("Exported.");
      setTimeout(() => setStatus(""), 2500);
    } catch (err) {
      setErrorMessage(`Export failed: ${err}`);
    }
  }

  async function handleExportExcel(levels: FlattenExportLevels) {
    setShowExportExcel(false);
    try {
      await gridApi?.exportExcel(levels);
    } catch (err) {
      setErrorMessage(`Export failed: ${err}`);
    }
  }

  async function handleExportPackage() {
    if (!activeProject) return;
    const dest = await save({
      defaultPath: activeProject.name + ".tcopkg",
      filters: [{ name: "Take-it-Off Package", extensions: ["tcopkg"] }],
    });
    if (!dest || typeof dest !== "string") return;
    try {
      setStatus("Packaging…");
      await exportPackage(dest);
      setStatus("Package exported.");
      setTimeout(() => setStatus(""), 3000);
    } catch (err) {
      setStatus("");
      setErrorMessage(`Export package failed: ${err}`);
    }
  }

  const hasGrid = gridApi != null;

  const items: MenuItem[] = [
    { label: "Project Info", icon: "edit", enabled: !!activeProject, onClick: () => setShowProjectInfo(true) },
    { divider: true, label: "", enabled: false },
    { label: "Export Project...", icon: "save_as", enabled: !!activeProject, onClick: () => { void handleExportProject(); } },
    { label: "Export Package...", icon: "inventory_2", enabled: !!activeProject, onClick: () => { void handleExportPackage(); } },
    { label: "Export to Excel...", icon: "save_as", enabled: hasGrid, onClick: () => setShowExportExcel(true) },
    { label: "Print", icon: "print", enabled: hasGrid, onClick: () => gridApi?.print() },
    { divider: true, label: "", enabled: false },
    { label: "Close Project", enabled: !!activeProject, onClick: () => { void closeProject(); } },
  ];

  return (
    <>
      <TopMenu label="File" items={items} statusText={status || undefined} />
      {showProjectInfo && activeProject ? (
        <ProjectInfoDialog
          initial={{ name: activeProject.name, client: activeProject.client, contractNumber: activeProject.contract_number, status: activeProject.status }}
          onCancel={() => setShowProjectInfo(false)}
          onConfirm={() => setShowProjectInfo(false)}
        />
      ) : null}
      {errorMessage ? (
        <ErrorDialog title="Error" body={errorMessage} onDismiss={() => setErrorMessage(null)} />
      ) : null}
      {showExportExcel ? (
        <ExportExcelDialog onCancel={() => setShowExportExcel(false)} onConfirm={(levels) => { void handleExportExcel(levels); }} />
      ) : null}
    </>
  );
}
