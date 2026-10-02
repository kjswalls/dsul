/**
 * Click-away — "a click on nothing lets go of what you were holding."
 *
 * A plain click on empty desktop space clears the item selection (single or
 * multi) and closes the docked edit panel. Two consumers, one listener pair:
 * DesktopShell subscribes to clear the selection, and the panel subscribes
 * (only while open) to flush-then-close, the same path its Escape takes — a
 * bare closeDialog() would leave a queued autosave to the 600ms unmount grace.
 *
 * Cost is the point of the shape. The document listeners exist only while
 * someone is subscribed, and each event does a Set-size check plus at most two
 * `closest()` walks (O(depth)) — no store writes unless something actually
 * clears, no React renders on the hot path.
 *
 * What counts as "nothing" is decided by {@link isClickAwayTarget}:
 *   - it must be inside a `[data-click-away-scope]` (the desktop shell root), so
 *     Radix portals — popovers, menus, the confirm dialog, all rendered at
 *     <body> — never read as empty space, and neither does anything outside the
 *     planner (Zen, the mobile shell);
 *   - and outside every KEEP zone: an item, the panel, the bulk bar, or any
 *     control. Clicking the omnibar or a date-nav button must not cost you the
 *     selection as a side effect; only genuinely empty space does.
 *
 * A click that ENDS a drag is not a click-away: dnd-kit and text-selection
 * drags both finish with a `click` on the common ancestor of the down and up
 * targets, which is usually bare grid. So the gesture must also START on empty
 * space and travel under {@link MAX_TRAVEL_PX}. Modifier clicks are ignored so
 * a mis-aimed ⌘/shift-click while building a multi-selection doesn't wipe it,
 * and a press that dismisses an open popover or menu does only that. A click's
 * follow-on, a double-click's second, is ignored too: it lands wherever the
 * first left the page, and the first either was a click-away already or was a
 * click on something that has since moved out from under the pointer (a
 * Display shelf ✕ that took its setting off, and the shelf's last line with it).
 */

export const CLICK_AWAY_SCOPE_ATTR = 'data-click-away-scope';

/** Anything matching this (or inside it) is never "empty space". */
const KEEP_SELECTOR = [
  '[data-item-id]',
  '[data-testid="item-dialog"]',
  '[data-testid="bulk-action-bar"]',
  '[data-click-away-ignore]',
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="textbox"]',
].join(',');

/** Past this much pointer travel the gesture was a drag, not a click. */
export const MAX_TRAVEL_PX = 5;

export function isClickAwayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (!target.closest(`[${CLICK_AWAY_SCOPE_ATTR}]`)) return false;
  return !target.closest(KEEP_SELECTOR);
}

type Handler = () => void;

const handlers = new Set<Handler>();
/** Where the current primary press started, if it started on empty space. */
let press: { x: number; y: number } | null = null;

function onPointerDown(e: PointerEvent) {
  press =
    e.button === 0 &&
    !hasModifier(e) &&
    isClickAwayTarget(e.target) &&
    // A popover or menu is up: this press is what dismisses it (Radix listens
    // for it too), and that is ALL it should do — the same rule the panel's
    // Escape follows. Checked here, not at click time, because by then Radix
    // has already torn the popper down.
    !document.querySelector('[data-radix-popper-content-wrapper]') &&
    !onScrollbar(e)
      ? { x: e.clientX, y: e.clientY }
      : null;
}

/**
 * A press on a scroll container's own scrollbar targets the container, which is
 * usually bare — but nudging the day's scroll is not "let go". clientWidth /
 * clientHeight exclude the scrollbar, so an offset past them is on it. Asked
 * last, once per press and only of a press already on empty space: the size
 * reads are layout reads, and a pointerdown is the one moment they are cheap
 * (nothing has dirtied layout since the last frame).
 */
function onScrollbar(e: PointerEvent): boolean {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return false;
  const scrollsY = el.scrollHeight > el.clientHeight;
  const scrollsX = el.scrollWidth > el.clientWidth;
  if (!scrollsY && !scrollsX) return false;
  return (scrollsY && e.offsetX >= el.clientWidth) || (scrollsX && e.offsetY >= el.clientHeight);
}

function onClick(e: MouseEvent) {
  const start = press;
  press = null;
  if (!start || e.button !== 0 || e.detail > 1 || hasModifier(e) || e.defaultPrevented) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MAX_TRAVEL_PX) return;
  if (!isClickAwayTarget(e.target)) return;
  // Snapshot: a handler may unsubscribe (the panel closes) mid-iteration.
  for (const h of [...handlers]) h();
}

function hasModifier(e: MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * Run `handler` on every click-away. Returns the unsubscribe. The document
 * listeners are installed with the first subscriber and removed with the last.
 */
export function subscribeClickAway(handler: Handler): () => void {
  if (typeof document === 'undefined') return () => {};
  if (handlers.size === 0) {
    // Capture, so a handler that stops propagation further down can't hide the
    // press start from us and leave a stale `press` for the next click.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick);
  }
  handlers.add(handler);
  return () => {
    if (!handlers.delete(handler) || handlers.size > 0) return;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick);
    press = null;
  };
}
