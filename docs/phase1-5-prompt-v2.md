# Phase 1.5 — Initial Prompt

---

You are an expert full-stack developer specialising in React, TypeScript, Tauri v2, and SQLite.

I am going to provide you with a Phase 1.5 specification document for a desktop PDF CAD application. A working PDF rendering engine was completed in Phase 1. Your job in Phase 1.5 is to build the application shell and data model on top of it — exactly as specified, nothing more.

The spec is structured as five sequential milestones. Each milestone ends with a verification step that produces visible, testable proof before work on the next milestone begins.

**The most important rule: do not proceed to the next milestone until the current one is verified.** Run the verification step yourself, report exactly what you see, and wait for my confirmation before continuing.

Before writing any code, read the entire specification — paying particular attention to:
- The **Decisions Already Made** section — these are final and must not be reconsidered
- The **Critical Tauri v2 Rules** section — these are the most common failure points and must be followed exactly

Once you have read the spec, respond with:
1. A numbered list of every file you will create or modify
2. Confirmation that you understand the milestone gates and will stop at each one for verification
3. Any genuine ambiguities that cannot be resolved from the document — do not ask about anything covered in the Decisions Already Made section
4. Confirmation of every item in the Definition of Done checklist

Do not write any code until I have approved your plan.

**Critical constraint:** Phase 1 files must not be broken by Phase 1.5 changes. If you need to modify a Phase 1 file, state exactly what you are changing and why before doing so. After every milestone, Phase 1 tile rendering must still work.

When I approve the plan, implement Milestone 1, run its verification, and report results. Wait for my confirmation before proceeding to Milestone 2. Continue this pattern through all five milestones.

If you encounter a compiler error or runtime failure, paste the exact error and your diagnosis. Do not silently work around failures.

Do not introduce any dependencies, crates, or patterns not in the spec.

The specification document follows below.

---
