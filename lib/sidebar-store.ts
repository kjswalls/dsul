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
 * width can never squeeze <main> out of existence on a narrow window.
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
 */
export function clampSidebarWidth(px: number, viewportWidth?: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH
  const ceiling =
    viewportWidth == null || !Number.isFinite(viewportWidth)
      ? SIDEBAR_MAX_WIDTH
      : Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_MIN_CANVAS))
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN_WIDTH), ceiling))
}

interface SidebarState {
  // Open/closed state
  leftSidebarOpen: boolean
  /** Chat panel inside the sidebar (replaced the old right sidebar in P4). */
  chatExpanded: boolean
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
  setChatExpanded: (expanded: boolean) => void
  toggleChat: () => void
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
 * that set it. `leftSidebarOpen` and `chatExpanded` are the same shape: window
 * chrome for this browser, never synced, and disclosing nothing.
 */
const USER_SCOPED_DEFAULTS = {
  leftSidebarHoverEnabled: false,
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      leftSidebarOpen: true,
      chatExpanded: false,
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
      setChatExpanded: (expanded) => set({ chatExpanded: expanded }),
      toggleChat: () => set((state) => ({ chatExpanded: !state.chatExpanded })),
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
      // state, so a v2 record without the key keeps the default and needs no
      // migration step.
      version: 2,
      migrate: (persisted) => {
        // v1 → v2: right sidebar became the in-sidebar chat panel
        const state = (persisted ?? {}) as Record<string, unknown>;
        return {
          leftSidebarOpen: (state.leftSidebarOpen as boolean) ?? true,
          chatExpanded: (state.rightSidebarOpen as boolean) ?? false,
          leftSidebarHoverEnabled: (state.leftSidebarHoverEnabled as boolean) ?? false,
        };
      },
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        chatExpanded: state.chatExpanded,
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
