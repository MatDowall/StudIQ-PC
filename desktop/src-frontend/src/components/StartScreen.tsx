import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import studiqLogo from "../assets/studiq-logo.png";

export function StartScreen() {
  const recentProjects = useAppStore((state) => state.recentProjects);
  const loadRecentProjects = useAppStore((state) => state.loadRecentProjects);
  const createProject = useAppStore((state) => state.createProject);
  const openProject = useAppStore((state) => state.openProject);
  const importPackage = useAppStore((state) => state.importPackage);
  const pendingImportPath = useAppStore((state) => state.pendingImportPath);
  const setPendingImportPath = useAppStore((state) => state.setPendingImportPath);
  const removeRecentProject = useAppStore((state) => state.removeRecentProject);
  const [showNewProject, setShowNewProject] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingOverwriteImport, setPendingOverwriteImport] = useState<{ pkgPath: string; destPath: string; message: string } | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadRecentProjects()
      .then(() => { if (!cancelled) setStatus(""); })
      .catch((error) => { if (!cancelled) setStatus(`ERROR: ${error}`); });
    return () => { cancelled = true; };
  }, [loadRecentProjects]);

  async function chooseProjectToOpen() {
    const selected = await open({
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    setStatus("");
    try {
      await openProject(selected);
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function openRecentProject(filePath: string) {
    setStatus("");
    try {
      await openProject(filePath);
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function runImportFlow(preselectedPkgPath?: string) {
    let pkgPath = preselectedPkgPath ?? null;
    if (!pkgPath) {
      const selected = await open({
        filters: [{ name: "Take-it-Off Package", extensions: ["tcopkg"] }],
        multiple: false,
      });
      if (!selected || typeof selected !== "string") return;
      pkgPath = selected;
    }
    const destTcopPath = await save({
      defaultPath: pkgPath.replace(/\.tcopkg$/i, ".tcop"),
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
    });
    if (!destTcopPath || typeof destTcopPath !== "string") return;
    const path = destTcopPath.toLowerCase().endsWith(".tcop") ? destTcopPath : destTcopPath + ".tcop";
    await runImport(pkgPath, path);
  }

  async function runImport(pkgPath: string, destPath: string, force = false) {
    setStatus("Importing package…");
    try {
      await importPackage(pkgPath, destPath, force);
      setPendingOverwriteImport(null);
    } catch (error) {
      const message = String(error);
      const sentinel = "NEWER_FILE_EXISTS::";
      if (message.includes(sentinel)) {
        setStatus("");
        setPendingOverwriteImport({ pkgPath, destPath, message: message.slice(message.indexOf(sentinel) + sentinel.length) });
        return;
      }
      setStatus(`ERROR: ${error}`);
    }
  }

  useEffect(() => {
    if (!pendingImportPath) return;
    setPendingImportPath(null);
    void runImportFlow(pendingImportPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImportPath]);

  async function confirmRemove() {
    if (!pendingRemove) return;
    try {
      await removeRecentProject(pendingRemove);
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    } finally {
      setPendingRemove(null);
    }
  }

  return (
    <main
      style={{
        minHeight: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        boxSizing: "border-box",
        paddingTop: 96,
        overflow: "auto",
        background: theme.bg.shell,
        color: theme.text.primary,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <section
        style={{
          width: "min(760px, calc(100vw - 48px))",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <img
            src={studiqLogo}
            alt="StudIQ"
            style={{
              width: 220,
              height: 72,
              objectFit: "contain",
              objectPosition: "left center",
            }}
          />
        </header>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setShowNewProject(true)}
            style={{
              height: 48,
              minWidth: 180,
              padding: "0 18px",
              background: theme.bg.active,
              color: theme.text.primary,
              border: `1px solid ${theme.accent}`,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            + New Project
          </button>
          <button
            type="button"
            onClick={() => { void chooseProjectToOpen(); }}
            style={{
              height: 48,
              minWidth: 180,
              padding: "0 18px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Open Project
          </button>
          <button
            type="button"
            onClick={() => { void runImportFlow(); }}
            style={{
              height: 48,
              minWidth: 180,
              padding: "0 18px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Open Package…
          </button>
        </div>

        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, color: theme.text.primary, fontSize: 16, fontWeight: 500 }}>Recent Projects</h2>
          <div
            style={{
              border: `1px solid ${theme.border.divider}`,
              background: theme.bg.pane,
              minHeight: 154,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1.2fr 1fr 120px 32px",
                gap: 12,
                padding: "10px 12px",
                borderBottom: `1px solid ${theme.border.subtle}`,
                color: theme.text.secondary,
                fontSize: 12,
              }}
            >
              <span>Project Name</span>
              <span>Client</span>
              <span>Contract</span>
              <span>Status</span>
              <span />
            </div>
            {recentProjects.length === 0 ? (
              <div style={{ padding: 12, color: theme.text.disabled, fontSize: 13 }}>No recent projects</div>
            ) : (
              recentProjects.map((project) => (
                <div
                  key={project.file_path}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1.2fr 1fr 120px 32px",
                    gap: 12,
                    padding: "9px 12px",
                    borderBottom: `1px solid ${theme.border.subtle}`,
                    color: project.file_exists ? theme.text.primary : theme.text.disabled,
                    fontSize: 13,
                    alignItems: "center",
                  }}
                >
                  <span
                    onClick={() => { if (project.file_exists) void openRecentProject(project.file_path); }}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: project.file_exists ? "pointer" : "default",
                    }}
                  >
                    {project.name}
                  </span>
                  <span
                    onClick={() => { if (project.file_exists) void openRecentProject(project.file_path); }}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: project.file_exists ? "pointer" : "default",
                    }}
                  >
                    {project.client}
                  </span>
                  <span
                    onClick={() => { if (project.file_exists) void openRecentProject(project.file_path); }}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: project.file_exists ? "pointer" : "default",
                    }}
                  >
                    {project.contract_number}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span>{project.status}</span>
                    {!project.file_exists ? <span style={{ fontSize: 11, color: theme.danger }}>File not found</span> : null}
                  </span>
                  <button
                    type="button"
                    title="Remove from recent projects"
                    onClick={() => setPendingRemove(project.file_path)}
                    style={{
                      width: 24,
                      height: 24,
                      padding: 0,
                      background: "transparent",
                      color: theme.text.disabled,
                      border: `1px solid transparent`,
                      cursor: "pointer",
                      fontSize: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = theme.danger; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = theme.text.disabled; }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          {status ? <div style={{ color: theme.danger, fontSize: 12 }}>{status}</div> : null}
        </section>
      </section>

      {showNewProject ? (
        <NewProjectDialog
          onCancel={() => setShowNewProject(false)}
          onCreate={async (name, client, contractNumber, filePath) => {
            await createProject(name, client, contractNumber, filePath);
            setShowNewProject(false);
          }}
        />
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title="Remove from recent projects"
          body={`Remove "${recentProjects.find((p) => p.file_path === pendingRemove)?.name ?? pendingRemove}" from the recent projects list?\n\nThe project file itself will not be deleted.`}
          confirmLabel="Remove"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => { void confirmRemove(); }}
        />
      ) : null}

      {pendingOverwriteImport ? (
        <ConfirmDialog
          title="Overwrite newer project file?"
          body={`${pendingOverwriteImport.message}\n\nThis cannot be undone. Choose a different destination if you don't want to lose the newer version.`}
          confirmLabel="Overwrite anyway"
          onCancel={() => setPendingOverwriteImport(null)}
          onConfirm={() => { void runImport(pendingOverwriteImport.pkgPath, pendingOverwriteImport.destPath, true); }}
        />
      ) : null}
    </main>
  );
}
