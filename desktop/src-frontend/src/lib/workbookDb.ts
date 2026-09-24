// Ordered access to the workbook tables in the project database.
//
// Every workbook command used to be a bare fire-and-forget `invoke`. Tauri runs each async command
// as its own task over a multi-connection pool, so two invokes issued back to back are NOT
// guaranteed to execute in that order — and the workbook depends on ordering everywhere: a deleted
// row's sub-sheets must be removed BEFORE the next row's are renamed into that slot, a clone's
// destination must be cleared BEFORE the clone is saved there, a pending autosave must land BEFORE
// the next revision is loaded. Out of order, each of those silently deleted or overwrote real data.
//
// So every workbook read and write goes through one FIFO queue here: each command starts only once
// the previous one has settled. Reads are queued too, so a read always observes every write issued
// before it. A failed write is reported (see `setWorkbookDbErrorHandler`) instead of swallowed.

import { invoke } from "@tauri-apps/api/core";

type Args = Record<string, unknown>;

let tail: Promise<unknown> = Promise.resolve();
let onError: ((message: string) => void) | null = null;
let flushHook: (() => void) | null = null;

/** Where failed workbook commands are reported (the workbook view shows them in the footer). */
export function setWorkbookDbErrorHandler(handler: ((message: string) => void) | null): void {
  onError = handler;
}

/** Registered by the workbook view: persists any edit still waiting on the autosave debounce. */
export function setWorkbookFlushHook(hook: (() => void) | null): void {
  flushHook = hook;
}

function report(cmd: string, err: unknown): void {
  const message = `Workbook save failed (${cmd}): ${err instanceof Error ? err.message : String(err)}`;
  console.error(message);
  onError?.(message);
}

/** Queued invoke that resolves with the command's result, or rejects (after reporting) on error. */
export function wbInvoke<T = unknown>(cmd: string, args: Args): Promise<T> {
  const run = tail.then(() => invoke<T>(cmd, args));
  tail = run.catch(() => undefined);
  return run.catch((err) => {
    report(cmd, err);
    throw err;
  });
}

/** Queued fire-and-forget write. Failures are reported, never thrown. */
export function wbWrite(cmd: string, args: Args): void {
  wbInvoke(cmd, args).catch(() => { /* already reported */ });
}

/** Queued read. Not reported on failure — callers treat a failed read as "nothing stored". */
export function wbRead<T = unknown>(cmd: string, args: Args): Promise<T> {
  const run = tail.then(() => invoke<T>(cmd, args));
  tail = run.catch(() => undefined);
  return run;
}

/** Persists any pending debounced edit, then waits for every queued command to finish. Call before
 *  anything that closes or replaces the project database. */
export async function flushWorkbookWrites(): Promise<void> {
  try { flushHook?.(); } catch (err) { console.error("Workbook flush failed:", err); }
  await tail;
}
