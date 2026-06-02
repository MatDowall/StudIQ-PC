# Phase 1.5 Dimension Workflow Addendum

## Dimension Group Defaults

The Phase 1.5 specification seeds a dimension group structure for Milestone 4 verification, including:

- 00 GENERAL
- 01 SITE PREPARATION
- 02 SUBSTRUCTURE
- 03 FRAME
- 05 UPPER FLOORS
- 06 ROOF
- 07 EXTERIOR WALLS
- 08 WINDOWS & EXTERIOR DOORS
- 09 STAIRS & BALUSTRADES
- 10 INTERIOR WALLS
- 11 INTERIOR DOORS
- 14 CEILING FINISHES
- 11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors

These seeded dimension folders and groups are verification fixtures only. They are not production defaults for a real project.

## New Project Dimension Tree

A new real project must start with an empty dimension group tree unless the user explicitly imports or applies a future template.

Users create dimension folders and dimension groups project-by-project:

- The dimension group tree starts blank.
- Dimension folders can be created at the root or under another folder.
- Dimension groups can be created only as leaf nodes under a folder.
- A `dimension_group` node must not contain child folders or child groups.
- Measurements attach only to `dimension_group` leaf nodes.

## Add Dimension Group Workflow

Adding a dimension group must use an in-app dialog, not a browser-native prompt.

The dialog must:

- List the current dimension folder structure so users can select an existing folder without typing.
- Allow typing a new folder path.
- Clearly state that a folder path that does not exist will be created.
- Capture the dimension group name.
- Capture the dimension group colour.
- Persist any dynamically created folders immediately.
- Insert the new `dimension_group` leaf under the selected or created folder.

## Context Menu Behaviour

Right-click actions in the dimension group tree must be node-type specific.

Folder rows:

- Add Sub-folder
- Add Dimension Group
- Rename
- Delete Folder

Dimension group rows:

- Rename
- Change Colour
- Delete Dimension Group

No other virtual or non-database row may expose destructive database actions.

## Deletion Rules

Deletion must be explicit and guarded by in-app confirmation dialogs. Browser-native confirmation popups must not be used.

Folder deletion is destructive:

- Deleting a folder permanently removes that folder.
- All child folders are permanently removed.
- All child dimension groups are permanently removed.
- All measurements attached to those deleted dimension groups are permanently removed by database cascade rules.
- The confirmation wording must clearly state that the action cannot be undone.

Dimension group deletion is destructive:

- Deleting a dimension group permanently removes that group.
- All measurements attached to that group are permanently removed by database cascade rules.
- The confirmation wording must clearly state that the action cannot be undone.

The backend must verify the expected node type before deleting:

- Folder deletion must verify the target node is `folder`.
- Dimension group deletion must verify the target node is `dimension_group`.
- The backend must refuse delete requests where the expected node type does not match the actual database node type.

## Rename And Colour Rules

Rename operations must be in-app dialogs or inline editors, not browser-native prompts.

- Folder rename changes only the folder name.
- Dimension group rename changes only the group name.
- Dimension group colour changes only the `colour` field.
- Renames and colour changes must persist immediately.
- Tree rows and breadcrumbs must update immediately after rename or colour change.

## Breadcrumb And Selection

Selecting a dimension group must:

- Highlight the selected dimension group row.
- Update the breadcrumb to the full folder path plus group name.
- Call `get_measurements_for_group`.
- Store the returned measurements for overlay use.
- Store the selected group's colour for overlay use.

If the selected dimension group is deleted:

- Active dimension group selection must clear.
- Breadcrumb must clear.
- Overlay measurements must clear.
- Overlay colour must reset to the default accent colour.

## Tree Refresh Behaviour

The dimension tree must update immediately after add, delete, rename, and colour-change operations.

- Expanded folders must refresh their visible children after a mutation.
- Folder expand/collapse controls must not become stuck in a loading state.
- A visible folder with known cached children must retain a valid expand/collapse control even if the stored `has_children` hint is temporarily stale.
- Users must not need to click elsewhere in the sidebar to force the tree to redraw after mutations.

## Measurements And Overlay Boundary

Milestone 4 wires selection and measurement loading only.

- `get_measurements_for_group` should return an empty array until measurements exist.
- Measurement creation tools remain out of scope for Phase 1.5.
- Overlay canvas drawing remains part of Milestone 5.
- Milestone 4 must not change Phase 1 PDF rendering behaviour.

## Compatibility With Milestone Verification

The seeded dimension structure from the original Phase 1.5 spec may remain only while it is needed for Milestone 4 verification. Before implementing real project creation/opening behaviour, dimension seed data must be removed from production project initialisation or gated behind an explicit development/demo/template mode.

Drawing register workflow is covered separately in `phase1-5-project-workflow-addendum.md`.
