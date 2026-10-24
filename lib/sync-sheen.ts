import { prefersReducedMotion } from '@/lib/zen-transition';

/**
 * sync-sheen.ts — one pass of light over words that just changed because
 * something outside this page changed them (Kirby's ask on 2026-10-24): the
 * page load's landing pass (lib/planner-shimmer.ts), on one piece of text at
 * a time. The paint is all CSS ("Sync sheen" in app/globals.css), keyed off a
 * `data-sync-sheen` attribute this module puts on the text and takes off when
 * the pass ends.
 *
 * Only the server's news calls it, never the person's own typing:
 *
 *  - a catch-up from another device (planner-store `runCatchUp`): a row title
 *    that changed or arrived, and an agent's state that moved;
 *  - Ask home's agent read (planner-store `mergeAgentStates`);
 *  - a plan the AI wrote and the person accepted (`applyProposal`): the rows
 *    it renamed or added;
 *  - an item's notes read again (item-notes-store `load`): a note another
 *    device added or edited;
 *  - the History list read again (conversations-store): a conversation that
 *    moved on elsewhere.
 *
 * Two ways to find the text. A planner row's title is found by its row
 * (`[data-item-id]` around `[data-row-title]`), so every view's rows take it
 * with no change to the row. Anything else carries `data-sync-key`, and is
 * found by that key: `item:<id>`, `agent:<id>`, `note:<id>`, `conv:<id>`.
 *
 * The call comes right after the store's set(), before React has drawn the
 * new words, so the lookup waits two frames; a key with nothing on screen
 * yet (a row mounting a beat later) is looked for once more after a moment,
 * and then let go. Text off screen takes the pass anyway: it is 700ms of CSS.
 *
 * Off entirely under both motion vetoes, and while the load's own shimmer is
 * on the titles (its phases own them). Nothing marked holds the accent: the
 * dim is the text's own colour toward transparent, and lime never takes alpha.
 */

export const SYNC_SHEEN_ATTR = 'data-sync-sheen';
export const SYNC_KEY_ATTR = 'data-sync-key';

/** The pass, as app/globals.css runs it (--sync-sheen-ms). */
export const SYNC_SHEEN_MS = 700;
/** A key with nothing on screen two frames on is looked for once more, this much later. */
export const SYNC_SHEEN_RETRY_MS = 400;

export type SyncKey = `${'item' | 'agent' | 'note' | 'conv'}:${string}`;

export const itemKey = (id: string): SyncKey => `item:${id}`;
export const agentKey = (id: string): SyncKey => `agent:${id}`;
export const noteKey = (id: string): SyncKey => `note:${id}`;
export const convKey = (id: string): SyncKey => `conv:${id}`;

const ends = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function off(): boolean {
  if (typeof document === 'undefined') return true;
  if (prefersReducedMotion()) return true;
  if (window.matchMedia?.('(forced-colors: active)').matches) return true;
  return document.documentElement.hasAttribute('data-planner-shimmer');
}

/** Start (or restart) the pass on one element. */
function play(el: Element): void {
  // A search hit's <mark> draws its own ground, and its words would vanish
  // through the clip for the pass.
  if (el.querySelector('mark')) return;
  const was = ends.get(el);
  if (was) clearTimeout(was);
  el.removeAttribute(SYNC_SHEEN_ATTR);
  // A restart: the attribute coming back in the same frame would not.
  void (el as HTMLElement).offsetWidth;
  el.setAttribute(SYNC_SHEEN_ATTR, '');
  const done = () => {
    ends.delete(el);
    el.removeAttribute(SYNC_SHEEN_ATTR);
  };
  // The backstop: an element whose animation never runs (unstyled, detached)
  // must not keep the attribute, or a later pass would start from it.
  ends.set(el, setTimeout(done, SYNC_SHEEN_MS + 200));
  el.addEventListener(
    'animationend',
    (e) => {
      if ((e as AnimationEvent).animationName !== 'sync-sheen') return;
      const t = ends.get(el);
      if (t) clearTimeout(t);
      done();
    },
    { once: true }
  );
}

const quote = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

/** Every element on screen now for a key. */
export function targetsFor(key: SyncKey, root: ParentNode = document): Element[] {
  const out: Element[] = Array.from(root.querySelectorAll(`[${SYNC_KEY_ATTR}="${quote(key)}"]`));
  if (key.startsWith('item:')) {
    const id = key.slice('item:'.length);
    for (const row of Array.from(root.querySelectorAll(`[data-item-id="${quote(id)}"]`))) {
      for (const title of Array.from(row.querySelectorAll('[data-row-title]'))) {
        // The title's own row, not a row nested inside this one (a project's tasks).
        if (title.closest('[data-item-id]') === row) out.push(title);
      }
    }
  }
  return out;
}

const frame = (fn: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => requestAnimationFrame(fn)) : setTimeout(fn, 32);

/**
 * Run the pass on every element each key names, once React has drawn the
 * change. Safe anywhere: a server, a test without a DOM, a veto, all do nothing.
 */
export function syncSheen(keys: Iterable<SyncKey>): void {
  if (off()) return;
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return;
  frame(() => {
    if (off()) return;
    const missing: SyncKey[] = [];
    for (const key of wanted) {
      const found = targetsFor(key);
      if (found.length === 0) missing.push(key);
      found.forEach(play);
    }
    if (missing.length === 0) return;
    setTimeout(() => {
      if (off()) return;
      for (const key of missing) targetsFor(key).forEach(play);
    }, SYNC_SHEEN_RETRY_MS);
  });
}
