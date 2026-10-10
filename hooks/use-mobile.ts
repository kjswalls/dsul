import * as React from 'react'

const MOBILE_BREAKPOINT = 768

/**
 * The phone/desktop split, read where the rows render.
 *
 * useSyncExternalStore over ONE shared listener, rather than a useState that
 * starts false and an effect that measures. That shape answered "desktop" on
 * every mount and corrected it a commit later, so on a phone each row of the
 * look-only preview mounted as a desktop row and then remounted as a
 * SwipeRow: a second full render of every row, and about 600ms of it at 4x
 * CPU. Now a client render gets the real answer at once.
 *
 * The answer is `window.innerWidth < 768`, as it always was, read once and
 * kept until the `(max-width: 767px)` query changes (the two agree at every
 * whole-pixel width). Kept, because a snapshot is asked for on every render
 * of every caller, and reading innerWidth can force a layout; the cache goes
 * when the last caller unmounts, so the next first caller measures afresh.
 * The server snapshot is false, so the desktop branch renders first and
 * hydration cannot mismatch, as in hooks/use-media-query.ts.
 */
let mobile: boolean | null = null
const callers = new Set<() => void>()
let query: MediaQueryList | null = null

const measure = () => window.innerWidth < MOBILE_BREAKPOINT

function onQueryChange() {
  mobile = measure()
  for (const notify of callers) notify()
}

function subscribe(notify: () => void) {
  callers.add(notify)
  if (!query) {
    query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    query.addEventListener('change', onQueryChange)
    // A first caller measures afresh: nothing was listening for a change
    // while there were none.
    mobile = measure()
  }
  return () => {
    callers.delete(notify)
    if (callers.size > 0 || !query) return
    query.removeEventListener('change', onQueryChange)
    query = null
    mobile = null
  }
}

function getSnapshot() {
  if (mobile === null || !query) mobile = measure()
  return mobile
}

const getServerSnapshot = () => false

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
