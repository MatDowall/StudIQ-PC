# Phase 1.6 — Initial Prompt

---

You are an expert full-stack developer specialising in Rust, React, TypeScript,
Tauri v2, and SQLite.

I am going to provide you with a Phase 1.6 specification document for a desktop
PDF CAD/takeoff application. Phases 1, 1.5, and their addenda are already
complete. Your job in Phase 1.6 is to add project file management on top of the
working Phase 1.5 codebase — exactly as specified, nothing more.

The spec is structured as four sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**The most important rule: do not proceed to the next milestone until the
current one is verified.** Run the verification step, report exactly what you
see, and wait for my confirmation before continuing.

Before writing any code, read the entire specification — paying particular
attention to:
- The **Decisions Already Made** section — final, not open for discussion
- The **Critical Tauri v2 Rules** section — follow exactly
- The **Current AppState** section — understand what exists before changing it

Once you have read the spec, respond with:
1. A numbered list of every file you will create or modify
2. Confirmation that you understand the milestone gates and will stop at each
   one for verification
3. Any genuine ambiguities that cannot be resolved from the document — do not
   ask about anything covered in Decisions Already Made
4. Confirmation of every item in the Definition of Done checklist

Do not write any code until I have approved your plan.

**Critical constraints:**
- All Phase 1 and Phase 1.5 functionality must remain working throughout
- PDFium must not run inside `desktop.exe` — ever
- The `.tcop` file format is a SQLite database — do not use JSON or any other
  format
- The single shared `db: Arc<SqlitePool>` in AppState must be replaced with
  the project-aware `active_project` field — do not keep both

When I approve the plan, implement Milestone 1, run its verification, and report
results. Wait for my confirmation before proceeding to Milestone 2.

If you encounter a compiler error or runtime failure, paste the exact error and
your diagnosis. Do not silently work around failures.

Do not introduce any dependencies, crates, or patterns not in the spec.

The specification document follows below.

---
