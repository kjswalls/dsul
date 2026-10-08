import { toast } from 'sonner';

import { useAIConnectionStore } from './ai-connection-store';
import { restoreKept, takeKept, type KeptQuestion } from './ask-pending';
import { usePlannerStore } from './planner-store';
import { revealDock } from './look-store';
import { RAIL_HANDBACK_WAIT_MS, useRailStore } from './rail-store';
import { useUndoStripStore } from './undo-strip-store';

/**
 * "No AI, thanks", said from a surface that offered AI (the setup column's
 * foot, the phone's setup page and the tour's AI card), and its Undo.
 *
 * It writes the account's answer (`setAIHidden(true)`, applied at once, so
 * the key, the setup column and every invitation go in the same frame) and
 * says so in the undo strip, in prose: "AI is off. dsul won't bring it up
 * again." · Undo. Not a toast: the strip is where the app says what it just
 * did on your say-so, and offers it back. Once the strip has gone, Settings →
 * AI is the way back: its "Use AI in dsul" switch (`setUseAI`, below).
 *
 * The column goes first (`park`, so `summoned` is gone and Undo cannot spring
 * it back open), and the dock is shown, since the strip lives in it and a
 * collapsed braindump would hide it (the desktop's braindump: the phone's
 * setup page passes `phone`, and its strip already sits in the dock). Focus
 * lands on Undo: the button pressed went away with the column it sat in.
 *
 * A question kept from `?` (lib/ask-pending.ts) goes with the invitation it
 * was kept for: taken now and held by the row, so Undo puts it back with
 * YOUR QUESTION, and once the row has gone nothing brings it back.
 *
 * A write that fails is settled by what the server says, not by the failure:
 * a dropped connection can lose the answer to a write that landed. So the
 * store's own re-read decides. Still off, the strip stays and Undo with it.
 * Not off, the strip goes (it never says AI is off while the key is back),
 * focus follows the key, and a toast says the choice didn't take.
 */
export const AI_OFF_STRIP_MS = 5000;

export const AI_OFF_LABEL = 'AI is off. dsul won’t bring it up again.';
/** Undo's write failed and the server still has AI off: the strip comes back, Undo now a retry. */
export const AI_STILL_OFF_LABEL = 'Couldn’t turn AI back on just now. AI is still off.';
export const AI_OFF_FAILED = 'Couldn’t turn AI off just now. Try again in a moment.';
/** Settings → AI's switch, turned on, and the server still has AI off. */
export const AI_BACK_ON_FAILED = 'Couldn’t turn AI back on just now. Try again in a moment.';

let seq = 0;
/** The user's latest word on AI here: a write's failure speaks only while it is still theirs. */
let intent = 0;

/**
 * Show the AI-off row. It lives for its own clock (dismiss is by id, so a
 * newer row is never taken down), and only while it is the newest thing the
 * user did: a planner edit after it takes the strip and Ctrl+Z, so the row
 * goes then, and Ctrl+Z undoes the edit rather than turning AI back on.
 *
 * A load is not an edit. The setup column is up through the look-only preview
 * and a cold load, and the landing restarts the history at its 'Session
 * start' (historyIndex -1 to 0), as a Retry's opening set() does the other
 * way: while a load is in flight on either side of a change, the mark just
 * follows it (memory/plans/instant-planner.md, "Main's features during the
 * preview"). A change of account is not a load: identifyUser's switch (or a
 * sign-out) takes the row down before the load rule can re-mark across it, or
 * the last account's Undo would turn AI back on for the next.
 */
function showOffRow(label: string, focusUndo: boolean, kept: KeptQuestion | null): string {
  const id = `ai-off-${++seq}`;
  useUndoStripStore.getState().show({
    id,
    label,
    durationMs: AI_OFF_STRIP_MS,
    face: 'ui',
    focusUndo,
    onUndo: () => void undoNoAI(kept),
  });
  let mark = usePlannerStore.getState().historyIndex;
  const leave = () => useUndoStripStore.getState().dismiss(id);
  const timer = setTimeout(leave, AI_OFF_STRIP_MS);
  const stopWatching = usePlannerStore.subscribe((s, prev) => {
    // Another account (or none): the row was the last one's, and its Undo would write to this one.
    if (s.userId !== prev.userId) leave();
    else if (s.isLoading || prev.isLoading) mark = s.historyIndex;
    else if (s.historyIndex !== mark) leave();
  });
  // However the row goes (its clock, ✕, Undo, a newer row), the watch goes with it.
  const stopOnLeave = useUndoStripStore.subscribe((s) => {
    if (s.entry?.id === id) return;
    stopOnLeave();
    stopWatching();
    clearTimeout(timer);
  });
  return id;
}

/**
 * Whether the account has AI off, as the server says after a write whose
 * answer did not come back ok. The store asked again as the write failed;
 * this joins that read (or starts one) and reads what it settled on. A
 * dropped connection can lose the answer to a write that landed, so this,
 * not the failure, decides what to say. (Settings → AI's card asks it too.)
 */
export async function serverSaysHidden(): Promise<boolean> {
  await useAIConnectionStore.getState().refresh();
  return useAIConnectionStore.getState().aiHidden === true;
}

/**
 * Settings → AI's switch and "No AI, thanks": the account's answer and nothing else.
 * No rail park, no dock reveal, no undo strip, no kept question (the off state is its own undo).
 * Shares `intent` with chooseNoAI. On a failed write, asks serverSaysHidden(): if the server already says
 * what was asked, it resolves true with no toast; otherwise, while the intent is still current, it toasts
 * AI_OFF_FAILED (asked off) or AI_BACK_ON_FAILED (asked on) and resolves false.
 * First, it dismisses a live `ai-off-*` undo-strip row left by chooseNoAI (the strip's store is a module
 * singleton and its 5 s clock runs across the trip to /settings): a row that says "AI is off" must not greet
 * someone back home who just turned it on here.
 */
export async function setUseAI(on: boolean): Promise<boolean> {
  const mine = ++intent;
  const live = useUndoStripStore.getState().entry;
  if (live?.id.startsWith('ai-off-')) useUndoStripStore.getState().dismiss(live.id);
  const result = await useAIConnectionStore.getState().setAIHidden(!on);
  if (result.ok) return true;
  // Settled by what the server says, not the failure: a dropped connection
  // can lose the answer to a write that landed.
  if ((await serverSaysHidden()) === !on) return true;
  // Taken back meanwhile: the newer press is what the user said last.
  if (mine !== intent) return false;
  toast.error(on ? AI_BACK_ON_FAILED : AI_OFF_FAILED);
  return false;
}

export async function chooseNoAI(o: { phone?: boolean } = {}): Promise<void> {
  const mine = ++intent;
  const kept = takeKept();
  useRailStore.getState().park();
  if (!o.phone) revealDock();
  const id = showOffRow(AI_OFF_LABEL, true, kept);
  const result = await useAIConnectionStore.getState().setAIHidden(true);
  if (result.ok || (await serverSaysHidden())) return;
  useUndoStripStore.getState().dismiss(id);
  // Taken back meanwhile (Undo, Ctrl+Z): AI being on is what the user said last.
  if (mine !== intent) return;
  // The choice didn't take, so the invitation is back, and the question with it.
  if (kept) restoreKept(kept);
  focusKeyWhenDrawn();
  toast.error(AI_OFF_FAILED);
}

/**
 * Undo: the account's answer back to false, so the key returns (unlit, as it
 * was), and the question the row held with it. Focus, left on the strip that
 * just went, follows it to the key once it is drawn, if nothing else took it
 * meanwhile. A write that fails with the server still saying off brings the
 * row back, its Undo now a retry; it takes focus only if focus is still
 * nowhere the user put it, since it arrives a round trip after the press.
 */
async function undoNoAI(kept: KeptQuestion | null): Promise<void> {
  const mine = ++intent;
  const write = useAIConnectionStore.getState().setAIHidden(false);
  // Back with the invitation, which the write applies at once.
  if (kept) restoreKept(kept);
  focusKeyWhenDrawn();
  const result = await write;
  if (result.ok || !(await serverSaysHidden()) || mine !== intent) return;
  const inStrip = typeof document !== 'undefined' && !!document.activeElement?.closest('[data-undo-id]');
  // Still off: the question goes back to the row whose Undo is now a retry.
  showOffRow(AI_STILL_OFF_LABEL, focusUnplaced() || inStrip, takeKept());
}

/** Focus on <body>, or on the dock a strip row hands it to as it goes: nowhere the user put it. */
function focusUnplaced(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return !active || active === document.body || active.matches('[data-dock-surface]');
}

/**
 * Focus to the key once it is drawn, if focus is still nowhere the user put
 * it: on <body>, or on the dock, where a strip row hands it as it goes
 * (undo-strip-store `dismiss`). Anywhere else, it stays.
 */
function focusKeyWhenDrawn(): void {
  if (typeof document === 'undefined') return;
  const start = Date.now();
  const attempt = () => {
    if (!focusUnplaced()) return;
    const key = document.querySelector<HTMLElement>('[data-ask-opener]');
    if (key && !key.closest('[hidden]')) {
      key.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - start < RAIL_HANDBACK_WAIT_MS) setTimeout(attempt, 16);
  };
  setTimeout(attempt, 0);
}
