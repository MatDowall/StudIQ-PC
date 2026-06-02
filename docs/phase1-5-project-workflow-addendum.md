# Phase 1.5 Project Workflow Addendum

## Drawing Register Folder Defaults

The Phase 1.5 specification seeds these drawing folders for Milestone 2 verification:

- ARCHITECTURE
- SITE
- MEP
- STRUCTURAL
- ARCHITECTURE\HOUSE PLANS
- ARCHITECTURE\PLANS

These seeded folders are verification fixtures only. They are not production defaults for a real project.

## New Project Drawing Register

A new real project must start with an empty drawing register tree.

Users create the drawing register structure project-by-project:

- The drawings tree starts blank.
- When adding a drawing, the user is prompted to choose a destination folder.
- The destination folder prompt must be an in-app dialog, not a browser-native prompt.
- The destination folder dialog must list the current drawing folder structure so users can select an existing folder without typing.
- The destination folder dialog must also allow typing a new folder path.
- The dialog must clearly hint that a folder path that does not exist will be created.
- Dynamically created folders are persisted immediately in the project database.
- The selected PDF is then inserted under that chosen folder as a drawing node.
- The drawing node exposes page child entries in the sidebar for page navigation.

## Drawing Folder Deletion

Users must be able to delete drawing folders from the drawing register.

Folder deletion is destructive:

- Deleting a folder permanently removes that folder.
- All child folders are permanently removed.
- All drawings inside the deleted folder tree are permanently removed from the project register.
- Any project data that is linked through those deleted drawing records must also be considered at risk of deletion through database cascade rules.
- The user must see an in-app confirmation dialog before deletion. Browser-native confirmation popups must not be used.
- The confirmation wording must clearly state that the action cannot be undone.
- Drawing removal must verify it is deleting a drawing node, not a folder or page row.
- Folder deletion must verify it is deleting a folder node.
- The backend must refuse delete requests where the expected node type does not match the actual database node type.

## Tree Refresh Behaviour

The drawing tree must update immediately after add/remove operations.

- Expanded folders must refresh their visible children after a drawing or folder is added or removed.
- Folder expand/collapse controls must not become stuck in a loading state.
- A visible folder with known cached children must retain a valid expand/collapse control even if the stored `has_children` hint is temporarily stale.
- Users must not need to click elsewhere in the sidebar to force the tree to redraw after add/remove operations.

## Compatibility With Milestone Verification

The existing seeded folders may remain only while they are needed for Phase 1.5 milestone verification. Before implementing real project creation/opening behaviour, drawing seed data must be removed from production project initialisation or gated behind an explicit development/demo mode.

Dimension group seed data is a separate concern and is not changed by this addendum.
