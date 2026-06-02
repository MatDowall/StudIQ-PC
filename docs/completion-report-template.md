# [Phase X.X] Completion Report

Date: YYYY-MM-DD
Phase: [Phase number and name]
Status: Complete / Incomplete

---

## Summary

One paragraph describing what this phase set out to do and whether it was
achieved. State clearly whether all Definition of Done items passed.

---

## Files Created or Modified

List every file that was created or modified. For each file, one line
describing what changed and why.

**Created:**
- `path/to/file.rs` — reason

**Modified:**
- `path/to/file.rs` — what changed and why

---

## Milestones

For each milestone, state:
- What was implemented
- The exact verification output or user confirmation received
- Pass or Fail

### Milestone 1 — [Name]
**Implemented:** ...
**Verification output:**
```
paste exact terminal output or describe what was seen on screen
```
**Result:** Pass / Fail

### Milestone 2 — [Name]
...

---

## Issues Encountered and Resolutions

For each issue, document:
1. The exact error message or symptom
2. The diagnosis
3. The resolution and any code change made

If no issues were encountered, write "None."

---

## Spec Deviations and Addenda

List every place where the implementation differed from the spec, and every
decision made that was not covered by the spec. For each:

- **What the spec said** (or what it did not address)
- **What was implemented instead**
- **Why**
- **Impact on future phases** (if any)

If the implementation matched the spec exactly, write "None."

---

## Permanent Constraints Established This Phase

List any decisions made during this phase that must be carried forward as
locked constraints in all future specs. These will be added to the
Decisions Already Made section of subsequent handover documents.

Example format:
- `CREATE_NO_WINDOW` must be applied to all child process spawns on Windows
- Renderer path resolves to `pdf_renderer.exe` on Windows, `pdf_renderer` on
  macOS/Linux

If none, write "None."

---

## Known Issues or Warnings Not Resolved This Phase

List any compiler warnings, console errors, or known issues that were
observed but intentionally deferred. For each:
- What it is
- Why it was deferred
- Which future phase should address it

---

## Definition of Done

Copy the checklist from the spec and mark each item Pass, Fail, or Deferred.

- [ ] Item one
- [ ] Item two

---

## State for Next Phase

Describe the exact state of the codebase at handover. Include:
- What is working
- What is not yet implemented
- Any environmental setup the next developer needs to know about
- The build commands confirmed working at handover

```powershell
# confirmed working build commands
cargo build --package core --bin pdf_renderer
cargo build --package desktop
npm.cmd --prefix desktop/src-frontend run build
```
