import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { RateConstantsDialog } from "./RateConstantsDialog";
import { MenuItem, TopMenu } from "./MenuBar";

export function WorkbookMenu() {
  const [showRateLibrary, setShowRateLibrary] = useState(false);

  const activeProject = useAppStore((state) => state.activeProject);
  const activeTab = useAppStore((state) => state.activeTab);
  const openTemplateManager = useAppStore((state) => state.openTemplateManager);
  const openNamedCellsManager = useAppStore((state) => state.openNamedCellsManager);
  const setWorkbookConfirmAction = useAppStore((state) => state.setWorkbookConfirmAction);

  const isWorkbookTabActive = activeTab === "workbook";

  const items: MenuItem[] = [
    { label: "Template Manager", icon: "dashboard_customize", enabled: isWorkbookTabActive, onClick: () => openTemplateManager() },
    { label: "Named Cells", icon: "sell", enabled: isWorkbookTabActive, onClick: () => openNamedCellsManager() },
    { label: "Rate Library", icon: "price_change", enabled: isWorkbookTabActive && !!activeProject, onClick: () => setShowRateLibrary(true) },
    { divider: true, label: "", enabled: false },
    { label: "Clean orphaned sheets", icon: "cleaning_services", enabled: isWorkbookTabActive, onClick: () => setWorkbookConfirmAction("clean") },
    { label: "Clear workbook", icon: "delete_sweep", enabled: isWorkbookTabActive, onClick: () => setWorkbookConfirmAction("clear") },
  ];

  return (
    <>
      <TopMenu label="Workbook" items={items} />
      {showRateLibrary && <RateConstantsDialog onClose={() => setShowRateLibrary(false)} />}
    </>
  );
}
