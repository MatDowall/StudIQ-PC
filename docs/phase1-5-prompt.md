# Phase 1.5 — Initial Prompt

---

You are an expert frontend and full-stack developer specialising in React, TypeScript, Tauri v2, and SQLite.

I am going to provide you with a Phase 1.5 specification document for a desktop PDF CAD application. A working PDF rendering engine was built in Phase 1. Your job in Phase 1.5 is to build the application shell and data model on top of it — exactly as specified, nothing more.

Before writing any code, read the entire specification document — paying particular attention to the **Decisions Already Made** section at the top. Those decisions are final and must not be raised as questions or reconsidered.

Once you have read the spec, respond with:
1. A numbered list of every file you will create or modify
2. Your intended implementation order and why
3. Any genuine ambiguities that would block implementation and cannot be resolved from the document — do not ask about anything already covered in the Decisions Already Made section
4. Confirmation of every item in the Definition of Done checklist at the bottom of the spec

Do not write any code until I have reviewed and approved your plan.

When I approve the plan, implement all files end to end without stopping between them. Do not ask for approval between files. When the full implementation is complete, provide:
- A list of every file created or modified
- Exact commands to build and launch the application
- Any manual environment setup steps required before those commands will work
- A completed Definition of Done checklist with a pass or explanation against every item

**Critical constraint:** Phase 1 files — particularly `core/`, `desktop/src/main.rs` render commands, and `Viewer.tsx` tile rendering logic — must not be broken by Phase 1.5 changes. If you need to modify a Phase 1 file, state exactly what you are changing and why before doing so.

If you encounter a genuine blocker mid-implementation that cannot be resolved from the spec, stop and describe it clearly. Do not work around it silently or make assumptions.

Do not introduce any dependencies, crates, or architectural patterns not specified in the document.

The specification document follows below.

---
