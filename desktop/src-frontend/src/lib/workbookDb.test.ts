// The workbook's database writes must execute in the order they were issued (see workbookDb.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const pending: Array<{ cmd: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    new Promise((resolve, reject) => {
      calls.push(`start:${cmd}`);
      pending.push({ cmd, resolve, reject });
    }),
}));

import { wbWrite, wbRead, wbInvoke, flushWorkbookWrites, setWorkbookDbErrorHandler, setWorkbookFlushHook } from "./workbookDb";

/** Settle the oldest in-flight command, then let the queue start the next one. */
async function settleNext(fail = false) {
  const p = pending.shift()!;
  calls.push(`end:${p.cmd}`);
  if (fail) p.reject(new Error("disk full")); else p.resolve(p.cmd);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
  while (pending.length) await settleNext();
  calls.length = 0;
  setWorkbookDbErrorHandler(null);
  setWorkbookFlushHook(null);
});

describe("workbookDb queue", () => {
  it("starts each command only after the previous one has settled", async () => {
    wbWrite("delete_workbook_sheet_subtree", {});
    wbWrite("shift_workbook_subtrees", {});
    const read = wbRead<string>("load_workbook_sheet", {});
    await Promise.resolve();
    expect(calls).toEqual(["start:delete_workbook_sheet_subtree"]);

    await settleNext();
    await settleNext();
    await settleNext();
    await expect(read).resolves.toBe("load_workbook_sheet");
    expect(calls).toEqual([
      "start:delete_workbook_sheet_subtree", "end:delete_workbook_sheet_subtree",
      "start:shift_workbook_subtrees", "end:shift_workbook_subtrees",
      "start:load_workbook_sheet", "end:load_workbook_sheet",
    ]);
  });

  it("reports a failed write and keeps the queue moving", async () => {
    const errors: string[] = [];
    setWorkbookDbErrorHandler(m => errors.push(m));
    wbWrite("save_workbook_sheet_bundle", {});
    const next = wbInvoke<string>("save_workbook_named_cell", {});
    await Promise.resolve();
    await settleNext(true);
    await settleNext();
    await expect(next).resolves.toBe("save_workbook_named_cell");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("save_workbook_sheet_bundle");
    expect(errors[0]).toContain("disk full");
  });

  it("flush runs the pending-save hook, then waits for everything queued", async () => {
    setWorkbookFlushHook(() => wbWrite("save_workbook_sheet_bundle", {}));
    let flushed = false;
    const flush = flushWorkbookWrites().then(() => { flushed = true; });
    await Promise.resolve();
    expect(calls).toEqual(["start:save_workbook_sheet_bundle"]);
    expect(flushed).toBe(false);
    await settleNext();
    await flush;
    expect(flushed).toBe(true);
  });
});
