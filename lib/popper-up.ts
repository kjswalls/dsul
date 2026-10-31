/**
 * Is a Radix popover, menu, select or tooltip UP right now?
 *
 * Radix renders every popper inside a `[data-radix-popper-content-wrapper]`,
 * and several places defer to one that is up: a press on empty space only
 * dismisses it (lib/click-away.ts), and Escape is its before any panel's.
 *
 * A wrapper is not enough on its own. On close, Radix keeps the content
 * mounted with `data-state="closed"` until its exit animation reports
 * `animationend`, and when that never arrives the closed popover stays in the
 * DOM indefinitely. CI caught exactly that: the item panel's + menu, picked and
 * closed, still mounted 10s later, and every click on empty space read as
 * "this press dismisses a popover" and did nothing (tests/e2e/item-panel.spec.ts,
 * the empty-click test that failed its first attempt on every run). A popper on
 * its way out is not up, so it is skipped here.
 */
export const POPPER_WRAPPER_SELECTOR = '[data-radix-popper-content-wrapper]';

export function isPopperUp(): boolean {
  if (typeof document === 'undefined') return false;
  for (const wrapper of document.querySelectorAll(POPPER_WRAPPER_SELECTOR)) {
    // The content is the wrapper's only child; a tooltip's open states are
    // `delayed-open` / `instant-open`, so test for closed, not for open.
    if (wrapper.firstElementChild?.getAttribute('data-state') !== 'closed') return true;
  }
  return false;
}
