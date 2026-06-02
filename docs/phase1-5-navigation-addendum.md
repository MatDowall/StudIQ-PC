# Phase 1.5 Navigation Addendum

## Drawing Register Navigation

The drawing register sidebar is the primary navigation surface for drawings and drawing pages.

Current Phase 1.5 spec language only requires drawing files to appear as clickable drawing nodes inside the drawing register. It does not explicitly require drawing/page navigation to be represented as a child tree under a drawing set.

This addendum makes that requirement explicit:

- Drawings must be organised under the selected drawing set/folder in the sidebar tree.
- Opening and navigating drawings must be driven from the sidebar tree.
- A drawing node must expose child navigation entries for its pages using the drawing's stored page count.
- Selecting a page child in the sidebar is the primary page navigation action.
- The viewer toolbar page selector, previous button, and next button must be removed. The toolbar may show read-only status text such as the current page number.
- Tree selection state must stay in sync with the currently opened drawing and page.
- Drawing page rows are navigation-only virtual rows. They are not database records.
- Right-click context menus must not be shown for drawing page rows.
- Drawing removal must only be available from the drawing row itself, never from a page row.

This does not change the Phase 1 rendering architecture. PDF rendering remains in `pdf_renderer.exe`, the frontend remains a single canvas compositor, and existing pan/zoom/page rendering behaviour must remain unchanged.
