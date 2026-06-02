# Phase 1.5 Dimension Summary Grid Addendum

## Reason For Addendum

The original Phase 1.5 Milestone 4 specification describes dimension group persistence, selection, colour, and measurement loading, but it does not explicitly define the visible Dimension Groups pane as a summary grid.

The target workflow now requires the Dimension Groups pane to follow the CostX-style list structure:

- Name
- Quantity
- UOM
- Colour swatch

## UI Requirement

The Dimension Groups pane must render as a tree-grid rather than a plain tree.

- Folder rows remain hierarchical and expandable.
- Dimension group rows are leaf rows under folders.
- Dimension group rows display their colour swatch.
- Dimension group rows reserve visible columns for Quantity and UOM.
- The layout must remain compatible with right-click context menus and the existing add, rename, colour-change, delete, and select workflows.

## Temporary Dummy Summary Values

Until measurement calculation and aggregation are implemented, Quantity and UOM values may be dummy presentation data.

These dummy values are strictly temporary:

- They must not be written to SQLite.
- They must not be treated as project data.
- They must not be used for exports, reports, calculations, or measurement overlays.
- They exist only to validate the pane layout and column behaviour.

## Future Backend Requirement

When measurement creation and calculation are implemented, each dimension group row must display real aggregate data.

The expected future source is either:

- an aggregate query over `measurements`, grouped by `dimension_group_id`; or
- stored summary fields maintained by measurement write operations, if later chosen for performance.

The UI should then replace dummy values with:

- total quantity for the dimension group;
- resolved unit of measure for the group;
- empty or mixed-state handling where a group has no measurements or inconsistent units.

## Scope Boundary

This addendum does not change Milestone 4 storage semantics.

- Milestone 4 still loads measurements via `get_measurements_for_group`.
- Measurement creation remains out of scope until the next relevant milestone.
- Overlay drawing remains Milestone 5.
- Phase 1 PDF rendering behaviour must not be changed by this UI adjustment.
