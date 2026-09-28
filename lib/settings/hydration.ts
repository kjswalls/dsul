/**
 * "Are the values on screen this account's yet?" — the settings route's gate,
 * as a function, so the guarantee it makes is testable rather than a boolean
 * expression buried in a component.
 *
 * WHY THIS EXISTS AT ALL. Every store the settings surface reads is
 * localStorage-persisted under a browser-GLOBAL key (`dsul-planner`,
 * `dsul-morning`, `dsul-view`, …). On a shared browser those keys hold
 * whoever signed in last. So between mount and the moment Supabase answers,
 * the surface would render the PREVIOUS account's values as live controls, and
 * a click inside that window writes someone else's preference into this user's
 * row. The gate is what makes that window unreachable.
 *
 * WHY `settingsHydratedUserId` IS THE WHOLE ANSWER. morning-store stamps it
 * inside the same `set()` that applies the server values (see its
 * `applyServerSettings`, and the note on the field: "Compare it against
 * usePlannerStore.getState().userId — equal is the only value that means
 * 'these settings are this user's'"). One set() means the stamp can never
 * disagree with the values, and supabase-provider's `hydrateSettings` applies
 * the planner / sidebar / eod / reminder / theme / palette values in the same
 * synchronous block — so the stamp speaks for all of them, not just morning's.
 *
 * WHAT IS DELIBERATELY NOT AN INPUT: planner-store's `isLoading`. That flag
 * covers `initializeStore`'s seven-table fetch — items, projects, habit
 * groups, item types, routines, seasons, goals — none of which this route
 * reads (every `planner()` read in lib/settings/manifest.ts is a settings
 * FIELD). Waiting on it put the entire item load on the critical path of a
 * page that shows no items, and it is not even a conservative choice: as
 * morning-store puts it, "the planner store's load flags say nothing about
 * settings — they race the settings request and frequently win", so a gate
 * built on it can be satisfied while the settings themselves are still the
 * previous account's. The stamp is both faster and stricter.
 *
 * `userId` stays in the condition because it is what the stamp is compared
 * AGAINST: with no signed-in user there is no account for these values to
 * belong to, and `null === null` must not read as agreement.
 */
export function settingsBelongToUser(
  /** planner-store's `userId` — stamped synchronously by `initializeStore`. */
  userId: string | null | undefined,
  /** morning-store's `settingsHydratedUserId` — never persisted, starts null. */
  settingsHydratedUserId: string | null | undefined
): boolean {
  return !!userId && settingsHydratedUserId === userId;
}
