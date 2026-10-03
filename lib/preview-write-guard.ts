/**
 * preview-write-guard — the planner store's write barrier for the look-only
 * preview (lib/planner-snapshot.ts).
 *
 * While the canvas shows THIS BROWSER's copy of the last session, every action
 * that is not on the allowlist below returns without running. A verb computed
 * from cached rows (an order, a toggle direction, a diff) and executed against
 * the server would overwrite whatever changed elsewhere since, and its
 * optimistic row would vanish at landing anyway — the landing set() replaces
 * every slice wholesale.
 *
 * DENY BY DEFAULT, checked at action ENTRY: an action added to the store
 * tomorrow is refused during a preview without anyone remembering this file.
 * The allowlist is exact names, never a prefix — setItemsCompleted,
 * setItemSkipped, setItemPaused, setRoutinePaused, setSeasonState and
 * setGoalState share `set*` with the view setters.
 *
 * Not a complete barrier, and not meant to be: direct `setState` writers
 * (settings hydration in supabase-provider, the history helpers) bypass it, and
 * none of them is a user verb. Pure and import-free, so the store can wrap
 * itself with it at creation.
 */

/** DENY BY DEFAULT. Exact names, never a prefix: setItemsCompleted, setItemSkipped, setItemPaused,
 *  setRoutinePaused, setSeasonState, setGoalState share `set*` with the view setters. */
export const PREVIEW_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  // lifecycle
  'identifyUser', 'initializeStore', 'clearStore', 'clearUserScopedState', 'refreshActionLog', 'dropPreview',
  // readers
  'getProject', 'getProjectColor', 'getProjectEmoji',
  // view state (view-store's mirror calls these; nav-commands sets navDirection)
  'setSelectedDate', 'setViewMode', 'setGroupBy', 'setFilters', 'clearFilters',
  'setTimelineItemFilter', 'setNavDirection', 'setHoveredItem',
  // preferences (user_settings, never planner rows, never computed from cached rows)
  'setCompactMode', 'setChillMode', 'setShowCurrentTimeIndicator', 'setShowCompletedTasks',
  'setShowPausedOnGrid', 'setDefaultView', 'setDefaultTimeBucket', 'setAnimationsEnabled',
  'setWeekStartDay', 'setTimeFormat',
]);

/**
 * What a refused non-void action returns (everything else returns undefined).
 * Each is the value its callers already read as "nothing was made": '' for the
 * id-returning creates (addGoal's own two-roles refusal returns it today),
 * null for addProject's name clash, 'refused' for the seed, 0 applied
 * operations for a proposal.
 */
export const PREVIEW_REFUSALS: Readonly<Record<string, unknown>> = {
  addTask: '', addHabit: '', addRoutine: '', addSeason: '', addGoal: '',
  addProject: null, seedStarterContainers: 'refused', applyProposal: 0,
};

export function guardPreviewWrites<T extends object>(store: T, isPreview: () => boolean): T {
  const out = { ...store } as Record<string, unknown>;
  for (const [name, value] of Object.entries(store)) {
    if (typeof value !== 'function' || PREVIEW_ALLOWED_ACTIONS.has(name)) continue;
    const fn = value as (...a: unknown[]) => unknown;
    out[name] = (...args: unknown[]) => {
      if (isPreview()) {
        if (process.env.NODE_ENV !== 'production') console.warn(`[preview] ${name} refused while previewing`);
        return PREVIEW_REFUSALS[name];
      }
      return fn(...args);
    };
  }
  return out as T;
}
