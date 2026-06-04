import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { NewProjectDialog } from "./NewProjectDialog";

export function StartScreen() {
  const recentProjects = useAppStore((state) => state.recentProjects);
  const loadRecentProjects = useAppStore((state) => state.loadRecentProjects);
  const createProject = useAppStore((state) => state.createProject);
  const openProject = useAppStore((state) => state.openProject);
  const [showNewProject, setShowNewProject] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadRecentProjects()
      .then(() => {
        if (!cancelled) setStatus("");
      })
      .catch((error) => {
        if (!cancelled) setStatus(`ERROR: ${error}`);
      });

    return () => {
      cancelled = true;
    };
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
          {/* Placeholder for the project logo — swap for an <img> once the asset is defined. */}
          <div
            aria-label="Project logo placeholder"
            style={{
              width: 220,
              height: 72,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: `1px dashed ${theme.border.divider}`,
              borderRadius: 4,
              color: theme.text.disabled,
              fontSize: 13,
              letterSpacing: 1,
            }}
          >
            LOGO
          </div>
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
            onClick={() => {
              void chooseProjectToOpen();
            }}
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
                gridTemplateColumns: "2fr 1.2fr 1fr 120px",
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
            </div>
            {recentProjects.length === 0 ? (
              <div style={{ padding: 12, color: theme.text.disabled, fontSize: 13 }}>No recent projects</div>
            ) : (
              recentProjects.map((project) => (
                <div
                  key={project.file_path}
                  onClick={() => {
                    if (project.file_exists) void openRecentProject(project.file_path);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1.2fr 1fr 120px",
                    gap: 12,
                    padding: "9px 12px",
                    borderBottom: `1px solid ${theme.border.subtle}`,
                    color: project.file_exists ? theme.text.primary : theme.text.disabled,
                    cursor: project.file_exists ? "pointer" : "default",
                    fontSize: 13,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.client}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.contract_number}</span>
                  <span>{project.file_exists ? "" : "File not found"}</span>
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
    </main>
  );
}
