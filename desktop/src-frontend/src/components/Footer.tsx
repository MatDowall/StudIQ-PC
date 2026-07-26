import { theme } from "../theme";
import { useAppStore } from "../store/appStore";

function NavButton({ label, title, disabled, onClick }: { label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 20,
        minWidth: 24,
        padding: "0 6px",
        background: "transparent",
        border: `1px solid ${theme.border.divider}`,
        borderRadius: 3,
        color: disabled ? theme.text.disabled : theme.text.primary,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 11,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

export function Footer() {
  const currentDocument = useAppStore((state) => state.currentDocument);
  const activePageIndex = useAppStore((state) => state.activePageIndex);
  const viewerStatus = useAppStore((state) => state.viewerStatus);
  const pageScale = useAppStore((state) => state.pageScale);
  const goToPage = useAppStore((state) => state.goToPage);

  const pageCount = currentDocument?.page_count ?? 0;
  const hasDoc = currentDocument !== null;
  const atFirst = activePageIndex <= 0;
  const atLast = activePageIndex >= pageCount - 1;

  return (
    <div
      style={{
        gridColumn: "1 / 3",
        height: theme.footerHeight,
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        background: theme.bg.ribbon,
        borderTop: `1px solid ${theme.border.subtle}`,
        padding: "0 10px",
        fontSize: 11,
        color: theme.text.secondary,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <div />
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", minWidth: 0 }}>
        {hasDoc ? (
          <>
            <NavButton label="<<" title="First page" disabled={atFirst} onClick={() => void goToPage(0)} />
            <NavButton label="<" title="Previous page" disabled={atFirst} onClick={() => void goToPage(activePageIndex - 1)} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {viewerStatus ? `${viewerStatus} — ` : ""}
              Page {activePageIndex + 1} of {pageCount}
            </span>
            <NavButton label=">" title="Next page" disabled={atLast} onClick={() => void goToPage(activePageIndex + 1)} />
            <NavButton label=">>" title="Last page" disabled={atLast} onClick={() => void goToPage(pageCount - 1)} />
          </>
        ) : null}
      </div>
      <div style={{ textAlign: "right", color: hasDoc && !pageScale ? theme.danger : theme.text.secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {hasDoc ? (pageScale ? `Scale: 1 pt = ${pageScale.mm_per_point.toPrecision(4)} mm` : "Scale Not Set") : ""}
      </div>
    </div>
  );
}
