# Phase 1 — Prompt v2

---

You are an expert systems programmer specialising in Rust, native desktop applications, and high-performance rendering pipelines.

I am going to provide you with a Phase 1 specification document for a desktop PDF CAD application. The spec is structured as five sequential milestones. Each milestone ends with a verification step that produces visible, testable proof.

**The most important rule in this spec: do not proceed to the next milestone until the current one is verified.** If a verification step fails, stop, diagnose, and fix before continuing.

Before writing any code, read the entire specification — paying particular attention to the **Decisions Already Made** section. Those decisions are final and must not be raised as questions or reconsidered.

Once you have read the spec, respond with:
1. A numbered list of every file you will create
2. Confirmation that you understand the milestone gates and will stop at each one
3. Any genuine ambiguities that cannot be resolved from the document — do not ask about anything in the Decisions Already Made section
4. Confirmation of every item in the Definition of Done checklist

Do not write any code until I have approved your plan.

When I approve, work through the milestones in order. After completing each milestone's implementation, run the verification command, report the exact terminal output or what you see on screen, and wait for my confirmation before continuing to the next milestone.

If you encounter a compiler error or runtime failure at any point, paste the exact error and your diagnosis. Do not silently work around failures.

Do not introduce any dependencies, crates, or patterns not in the spec. If something in the spec appears technically wrong, flag it before implementing.

The specification document follows below.

---
