# Phase 2 — Initial Prompt

---

You are an expert systems programmer specialising in Rust, TypeScript, spatial
algorithms, and Tauri v2.

I am going to provide you with a Phase 2 specification document for a desktop
PDF CAD/takeoff application. Phases 1 through 1.7 are complete. Phase 2 adds
vector extraction from PDF pages and a real-time snap engine — the foundation
for the measurement tools that come in Phase 3.

The spec is structured as five sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**The most important rule: do not proceed to the next milestone until the
current one is verified.** Run the verification step, report exactly what you
see, and wait for my confirmation before continuing.

Before writing any code, read the entire specification — paying particular
attention to:
- The **Pre-Flight Fix** section — this must be done before any other work
- The **Decisions Already Made** section — final, not open for discussion
- The **Architecture Overview** — snap runs in the frontend, not the backend
- The **Viewport Transform** section — PDF coordinates have Y-axis flipped
  relative to canvas coordinates, this is a common source of bugs

Once you have read the spec, respond with:
1. A numbered list of every file you will create or modify
2. Confirmation that you understand the milestone gates and will stop at each
   one for verification
3. Any genuine ambiguities that cannot be resolved from the document — do not
   ask about anything covered in Decisions Already Made
4. Confirmation of every item in the Definition of Done checklist

Do not write any code until I have approved your plan.

**Critical constraints:**
- PDFium must not run inside `desktop` — vector extraction goes through
  `pdf_renderer` via the existing JSON lines IPC protocol
- No new npm dependencies — implement the spatial index in TypeScript directly
- No changes to tile rendering, pan/zoom, or the IPC protocol format
- Remove performance timing logs before the final build
- The pre-flight bundle identifier fix must be the first commit

When I approve the plan, implement the pre-flight fix first, then work through
milestones in order. After completing each milestone, run the verification step,
report results, and wait for my confirmation before continuing.

If you encounter a compiler error or runtime failure, paste the exact error and
your diagnosis. Do not silently work around failures.

Do not introduce any dependencies, crates, or patterns not in the spec.

The specification document follows below.

---

[INSERT PHASE 2 SPEC HERE]

---

## Completion Report Requirement

When all milestones are complete and the Definition of Done is confirmed,
produce a completion report before closing out this phase.

The report must follow this exact structure:

1. **Summary** — one paragraph stating what the phase achieved and whether
   all Definition of Done items passed

2. **Files Created or Modified** — every file touched, with one line per
   file describing what changed and why

3. **Milestones** — for each milestone: what was implemented, the exact
   verification output or user confirmation received, and Pass or Fail

4. **Issues Encountered and Resolutions** — for every issue: the exact
   error message or symptom, the diagnosis, and the resolution including
   any code change made. Write "None" if no issues occurred.

5. **Spec Deviations and Addenda** — every place where the implementation
   differed from the spec, or where a decision was made not covered by the
   spec. For each: what the spec said, what was implemented, why, and any
   impact on future phases. Write "None" if the implementation matched
   the spec exactly.

6. **Permanent Constraints Established This Phase** — any decisions made
   during this phase that must be carried forward as locked constraints
   in all future specs. Write "None" if none.

7. **Known Issues or Warnings Not Resolved** — any compiler warnings,
   console errors, or deferred issues, with the reason for deferral and
   which future phase should address them.

8. **Definition of Done** — copy the checklist from the spec and mark
   each item Pass, Fail, or Deferred.

9. **State for Next Phase** — what is working, what is not yet
   implemented, any environmental setup the next developer needs, and
   the confirmed working build commands.

Save the report as `docs/phase2-completion-report.md` in the project.
