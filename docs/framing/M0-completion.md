# M0 — Docs scaffold & process setup — Completion Report

**Date:** 2026-06-04
**Status:** delivered, awaiting gate sign-off.

## What was built

Created the dedicated feature-documentation folder `docs/framing/` so the work can be handed
off between chat sessions across M0–M9:

- **`00-plan.md`** — repo-resident master plan: architecture fit, data model (backend JSON-column
  migrations + DTO wiring), NZS 3604 geometry/calc rules with worked examples, the milestone
  table with gates, key files, reuse points, and verification strategy.
- **`HANDOFF.md`** — the living "start here" doc: status table (M0 done, M1 next), what's done,
  the immediate next actionable step (full M1 breakdown), run/verify commands, decisions so far,
  open questions, and a deviations log. Updated at the end of every milestone.
- **`decisions.md`** — running log seeded with confirmed defaults and the three **provisional**
  calc assumptions (plate thickness = first framing dimension; dwang rows = `floor(h/centres)`;
  lintel length = daylight + 2×45) plus the NZS 3604 nomenclature list.
- **`M0-completion.md`** — this report.

No application code was touched (docs-only milestone).

## Gate

> docs folder + `00-plan.md` + `HANDOFF.md` reviewed/approved.

Verification is review-only: read `00-plan.md` and `HANDOFF.md` and confirm the plan,
milestone gates, and handoff process are right before M1 begins.

## Next

**M1 — Type plumbing & framing properties.** See the "What's next" section of
[`HANDOFF.md`](./HANDOFF.md) for the step-by-step.
