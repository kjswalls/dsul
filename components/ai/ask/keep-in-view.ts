/** How long a view Back returned to may still be settling, with its opener kept in sight. */
const SETTLE_MS = 600;

/**
 * A control Back handed focus to, kept in sight inside its own scroller
 * (History's list, Ask home's): only that box scrolls, never
 * `scrollIntoView`, which would move every ancestor, <main> included. The
 * desktop rail and the phone's Ask tab both call it after a Back's focus.
 *
 * The view beneath has just remounted, and its sections can still grow a
 * moment later (a Needs-you card's question arriving pushes every row under
 * it down), so it is held in sight while they settle: for SETTLE_MS, and only
 * while it still has focus, so anything the user moved to is left alone.
 */
export function keepInView(el: HTMLElement): void {
  const box = el.closest<HTMLElement>('[data-ask-scroller]');
  if (!box) return;
  const scroll = () => {
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  };
  scroll();
  if (typeof ResizeObserver === 'undefined') return;
  const sizes = new ResizeObserver(() => {
    if (document.activeElement === el && el.isConnected) scroll();
    else stop();
  });
  for (const section of Array.from(box.children)) sizes.observe(section);
  const timer = setTimeout(stop, SETTLE_MS);
  function stop() {
    sizes.disconnect();
    clearTimeout(timer);
  }
}
