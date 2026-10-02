import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { saveSettings } from './settings-service';
import { usePlannerStore } from './planner-store';
// Type-only, so it is erased at compile time and lib/local-state.ts importing
// this store back does not make a runtime cycle.
import type { ClearScope } from './local-state';

/**
 * Sidebar column width, in px.
 *
 * DEFAULT is the Figma dock width — the braindump header pill, the dock capsule
 * and the omnibar are all specced against 406, so it stays the resting value and
 * the double-click reset target.
 *
 * MIN is where the braindump header stops fitting: icon + title + four controls
 * leave the "Braindump" label ~78px at 280, and it truncates below that.
 * MAX is a taste cap — past ~720 the rows stop reading as a list.
 *
 * MIN_CANVAS is what the shell refuses to surrender to a drag, so a wide stored
 * width can never squeeze <main> out of existence on a narrow window, nor to a
 * docked right rail, beside which the column yields (renderedSidebarWidth).
 * app/globals.css declares the same DEFAULT on --sidebar-w for the frame before
 * this store hydrates.
 */
export const SIDEBAR_MIN_WIDTH = 280
export const SIDEBAR_MAX_WIDTH = 720
export const SIDEBAR_DEFAULT_WIDTH = 406
export const SIDEBAR_MIN_CANVAS = 520

/**
 * Clamp a candidate width to the bounds, optionally also against the viewport.
 * Pass `viewportWidth` for anything the user can see; omit it to bound a value
 * on its own terms (the persist rehydrate, tests, non-DOM callers). The
 * viewport ceiling never goes below MIN — on a window too small for both, the
 * sidebar wins and <main> takes the squeeze, because the alternative is a
 * handle that refuses to move.
 *
 * Non-finite input resolves to DEFAULT rather than propagating: this function
 * is the gate a hand-edited localStorage record comes back through, and a NaN
 * width silently collapses the column to zero.
 *
 * `reservePx` is what the right rail holds back while it is docked (rail-store's
 * `reservePx`: 432 with an item or Ask showing, else 0). Nothing passes it
 * directly: renderedSidebarWidth below applies it to what the column renders,
 * and clampSidebarGrowth to a sash gesture's growth.
 */
export function clampSidebarWidth(px: number, viewportWidth?: number, reservePx = 0): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH
  const reserve = Number.isFinite(reservePx) && reservePx > 0 ? reservePx : 0
  const ceiling =
    viewportWidth == null || !Number.isFinite(viewportWidth)
      ? SIDEBAR_MAX_WIDTH
      : Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_MIN_CANVAS - reserve)
        )
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN_WIDTH), ceiling))
}

/**
 * The width the braindump column RENDERS at, for the stored width (what the
 * user dragged to): while the right rail is docked it yields, so the day keeps
 * SIDEBAR_MIN_CANVAS beside both columns,
 *   max(MIN, min(stored, viewport - MIN_CANVAS - reservePx)).
 *
 * The yield is never written back. The stored width is the user's and the rail
 * is not, so when the column closes (or the window grows) the braindump goes
 * back to exactly what it was. `reservePx` is rail-store's: 0 while the rail is
 * hidden or overlays the canvas, when nothing yields. components/sidebar/
 * sidebar.tsx publishes this as --sidebar-w, on every change of the stored
 * width, the reserve or the window.
 *
 * What SIDEBAR_MIN_CANVAS buys the day, i.e. <main>'s width with the column at
 * this ceiling, net of the shell's chrome around it (desktop-shell.tsx;
 * measured at 1280, where the ceiling is 328):
 *   Classic   plate: p-3 and two 12px gaps                 520 - 36 = 484
 *   Notebook  spread: p-5, the 12px sash gutter, and the
 *             sheet's ml-12 where the page tabs' pr-14 was  520 - 88 = 432
 *   Notepad, Writer  flat: the 12px sash gutter, less the
 *             11px the reserve over-counts (the column has
 *             no gap, and a 1px seam: 421, not 432)        520 - 1  = 519
 * MIN floors it below that: at a 1181px window, the narrowest that docks, the
 * column is 280 and the day 433 (Classic), 381 (Notebook) and 468 (Notepad).
 * Console's braindump is the fixed 300px pane (braindump-pane.tsx), which does
 * not read this width; its day is 559 at 1280 and 460 at 1181. So the day has
 * to fit down to ~380: the canvas container queries (desktop-shell.tsx's
 * <main>) see to it.
 */
export function renderedSidebarWidth(stored: number, viewportWidth?: number, reservePx = 0): number {
  return clampSidebarWidth(stored, viewportWidth, reservePx)
}

/**
 * A sash gesture's target width, `candidate`, for a column that was `from`
 * wide when it began: the drag (from the width it is laid out at) and the
 * arrow, Home and End nudges (from the rendered width). Both start from what
 * the user SEES, which beside a docked rail is the yielded width
 * (renderedSidebarWidth), not the stored one.
 *
 * The rail's reserve caps GROWTH only, and only past `from`: a gesture can
 * never widen the braindump into the canvas the docked rail leaves, and never
 * shrinks it for the reserve's sake. While the column is yielded, `from` IS
 * the reserve ceiling, so it cannot grow at all and a shrink is free: at 1280
 * with Ask docked the column renders 328 (stored 406), ArrowLeft makes it 320,
 * ArrowRight and End leave it at 328, Home goes to MIN, and from MIN a drag or
 * End stops at 328 again. A gesture that cannot move the column writes nothing
 * (the sash's own rule), and nor does a drag that ends where it began, a
 * shrink dragged back out into the cap among them, so the stored 406 survives
 * both.
 */
export function clampSidebarGrowth(
  candidate: number,
  from: number,
  viewportWidth: number,
  reservePx = 0
): number {
  const free = clampSidebarWidth(candidate, viewportWidth)
  if (free <= from) return free
  return Math.min(free, Math.max(from, clampSidebarWidth(candidate, viewportWidth, reservePx)))
}

interface SidebarState {
  // Open/closed state
  leftSidebarOpen: boolean
  /**
   * Ask rests open in the right rail (the user keeps it there). Ctrl+J and the
   * rail's ✕ close it, and it stays closed until opened again. It is chrome
   * for this browser, like the width: never synced, never cleared. Whether Ask
   * actually SHOWS is rail-store's `railMode`, which also needs something to
   * answer, and, at or below 1180px, an explicit summon this session.
   */
  askOpen: boolean
  // Hover state (transient, not persisted)
  leftSidebarHovered: boolean
  // Settings (persisted)
  leftSidebarHoverEnabled: boolean
  /**
   * Drag-resized column width. Local-only on purpose — unlike the hover
   * setting it does NOT round-trip through saveSettings, because the right
   * width is a property of the monitor you're sitting at, not of the account.
   * Syncing it would push a 27" width onto a laptop on next login.
   */
  leftSidebarWidth: number
  // Actions
  setLeftSidebarOpen: (open: boolean) => void
  toggleLeftSidebar: () => void
  setAskOpen: (open: boolean) => void
  setLeftSidebarHovered: (hovered: boolean) => void
  setLeftSidebarHoverEnabled: (enabled: boolean) => void
  setLeftSidebarWidth: (px: number) => void
  /** Drop this account's sidebar setting — see lib/local-state.ts. */
  clearUserScopedState: (scope: ClearScope) => void
}

/**
 * The account-owned slice, at its default — one field.
 *
 * `leftSidebarHoverEnabled` round-trips through saveSettings, so it is an
 * account preference and comes back on the next sign-in. It is INERT in
 * lib/local-state.ts' sense — a boolean about whether a column peeks open on
 * hover, which describes the screen and not the person — so it only clears
 * under scope 'all', a known change of user.
 *
 * The other three persisted fields are NOT cleared under any scope, and that is
 * the whole reason this list is explicit rather than "reset the store".
 * `leftSidebarWidth` is a property of the monitor you are sitting at (see its
 * own note above) — clearing it would hand a new user a reset column on their
 * own laptop for no gain, since a width tells nobody anything about the account
 * that set it. `leftSidebarOpen` and `askOpen` are the same shape: window
 * chrome for this browser, never synced, and disclosing nothing.
 */
const USER_SCOPED_DEFAULTS = {
  leftSidebarHoverEnabled: false,
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      leftSidebarOpen: true,
      askOpen: true,
      leftSidebarHovered: false,
      ...USER_SCOPED_DEFAULTS,
      leftSidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      clearUserScopedState: (scope) => {
        if (scope !== 'all') return
        set({ ...USER_SCOPED_DEFAULTS })
      },
      // Docking or collapsing ends any hover-peek in the same write. The flag
      // is otherwise only cleared by the wrapper's mouseleave, and a pointer
      // that docks the column from inside it (the peek's pin, or ⌘[ mid-peek)
      // never leaves — so a later collapse would drop straight back into a
      // peek under that same pointer instead of closing.
      setLeftSidebarOpen: (open) => set({ leftSidebarOpen: open, leftSidebarHovered: false }),
      toggleLeftSidebar: () =>
        set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen, leftSidebarHovered: false })),
      setAskOpen: (open) => set({ askOpen: open }),
      setLeftSidebarHovered: (hovered) => set({ leftSidebarHovered: hovered }),
      setLeftSidebarHoverEnabled: (enabled) => {
        set({ leftSidebarHoverEnabled: enabled });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { left_sidebar_hover: enabled });
      },
      // Bounded here as well as at the drag site: this is what a hand-edited or
      // stale localStorage value passes through on the way back in.
      setLeftSidebarWidth: (px) => set({ leftSidebarWidth: clampSidebarWidth(px) }),
    }),
    {
      name: 'dsul-sidebar-settings',
      // Not bumped for leftSidebarWidth: persist shallow-merges over the initial
      // state, so a record without the key keeps the default and needs no
      // migration step.
      version: 3,
      migrate: (persisted) => {
        // v1 → v2 turned the right sidebar into the in-sidebar chat panel.
        // v1/v2 → v3: the left-dock chat is gone. `askOpen` is a NEW surface, so
        // the old `chatExpanded` (or v1's `rightSidebarOpen`) is not mapped onto
        // it: everyone starts with Ask open, the approved resting state of the
        // rail. The width is carried over; merge() clamps it, as it always has.
        const state = (persisted ?? {}) as Record<string, unknown>;
        return {
          leftSidebarOpen: (state.leftSidebarOpen as boolean) ?? true,
          askOpen: true,
          leftSidebarHoverEnabled: (state.leftSidebarHoverEnabled as boolean) ?? false,
          leftSidebarWidth: state.leftSidebarWidth as number | undefined,
        };
      },
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        askOpen: state.askOpen,
        leftSidebarHoverEnabled: state.leftSidebarHoverEnabled,
        leftSidebarWidth: state.leftSidebarWidth,
      }),
      // The default merge would hand a persisted width straight into state
      // without passing the setter, so this is the only place a record written
      // by an older build (or edited by hand) gets bounded on the way in.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SidebarState>;
        return { ...current, ...p, leftSidebarWidth: clampSidebarWidth(p.leftSidebarWidth as number) };
      },
    }
  )
)
