# Phase 1.7 — Initial Prompt

---

You are an expert systems programmer specialising in Rust, inter-process
communication, and Tauri v2.

I am going to provide you with a Phase 1.7 specification document for a desktop
PDF CAD/takeoff application. Phases 1 through 1.6 are complete. Phase 1.7 is a
purely internal architecture change — it replaces a process-per-render model
with a persistent renderer service using stdin/stdout JSON lines IPC. The user-
visible behaviour does not change.

The spec is structured as four sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**The most important rule: do not proceed to the next milestone until the
current one is verified.** Run the verification step, report exactly what you
see, and wait for my confirmation before continuing.

Before writing any code, read the entire specification — paying particular
attention to:
- The **Decisions Already Made** section — final, not open for discussion
- The **IPC Protocol** section — the exact JSON format must be followed
- The **open_document Safety Rule** section — this in-process PDFium call
  must be fixed in this phase
- The **Files to Create or Modify** section — no frontend files change

Once you have read the spec, respond with:
1. A numbered list of every file you will create or modify
2. Confirmation that you understand the milestone gates and will stop at each
   one for verification
3. Any genuine ambiguities that cannot be resolved from the document — do not
   ask about anything covered in Decisions Already Made
4. Confirmation of every item in the Definition of Done checklist

Do not write any code until I have approved your plan.

**Critical constraints:**
- No frontend files change in Phase 1.7
- No Tauri command signatures visible to the frontend change
- PDFium must not run inside `desktop` — the open_document fix is mandatory
- `worker_count` stays at 1
- The renderer must work on both Windows and macOS

If you encounter a compiler error or runtime failure, paste the exact error and
your diagnosis. Do not silently work around failures.

Do not introduce any dependencies, crates, or patterns not in the spec.

The specification document follows below.

---
