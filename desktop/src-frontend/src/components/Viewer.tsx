import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { DocumentMeta, ViewerCanvas } from "./ViewerCanvas";

export function Viewer() {
  const [doc, setDoc] = useState<DocumentMeta | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState("No document open");
  const currentDocument = useAppStore((state) => state.currentDocument);
  const currentPageIndex = useAppStore((state) => state.activePageIndex);
  const overlayMeasurements = useAppStore((state) => state.overlayMeasurements);
  const overlayColour = useAppStore((state) => state.overlayColour);

  const handleStatusChange = useCallback((nextStatus: string) => {
    setStatus(nextStatus);
  }, []);

  async function handleOpen() {
    const selected = await open({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;

    setStatus("Opening document...");
    try {
      const meta = await invoke<DocumentMeta>("open_document", { path: selected });
      setDoc(meta);
      setPageIndex(0);
      setStatus(`Opened: ${meta.page_count} pages`);
    } catch (e) {
      setStatus(`ERROR: ${e}`);
      console.error(e);
    }
  }

  useEffect(() => {
    if (!currentDocument) {
      setDoc(null);
      setPageIndex(0);
      setStatus("No document open");
      return;
    }
    setDoc(currentDocument);
    setPageIndex(currentPageIndex);
    setStatus(`Opened: ${currentDocument.page_count} pages`);
  }, [currentDocument, currentPageIndex]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: theme.bg.shell,
        color: theme.text.primary,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <div
        style={{
          height: 42,
          padding: "0 10px",
          background: "#2b2d31",
          display: "flex",
          gap: 12,
          alignItems: "center",
          borderBottom: "1px solid #3c4048",
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleOpen}
          style={{
            height: 28,
            padding: "0 12px",
            cursor: "pointer",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
          }}
        >
          Open PDF
        </button>
        <span style={{ fontSize: 12 }}>{status}</span>
        {doc ? (
          <span style={{ fontSize: 12 }}>
            Page {pageIndex + 1} of {doc.page_count}
          </span>
        ) : null}
      </div>
      <ViewerCanvas
        doc={doc}
        pageIndex={pageIndex}
        onStatusChange={handleStatusChange}
        overlayMeasurements={overlayMeasurements}
        overlayColour={overlayColour}
      />
    </div>
  );
}
