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

Save the report as `docs/phase[X-X]-completion-report.md` in the project.
