/**
 * stakes/goal-map.ts: the Beeminder title -> goal map, pure.
 *
 * Lives apart from beeminder.ts because that module imports server delivery
 * code (reminders/channels/http), and the browser needs this map too: while a
 * stake adapter is on, a recipe may not create an item titled after a mapped
 * goal (memory/plans/mods.md, "Stakes"). beeminder.ts re-exports both.
 */

/**
 * Parse "Vitamins: vitamins, Reading: read" into a title → goal map.
 *
 * Keyed on the item TITLE rather than its id, which is a real trade-off made
 * knowingly: an id is stable across renames but no user can find one, and a
 * mapping nobody can fill in correctly is worse than one that needs re-editing
 * after a rename. Comparison is case- and whitespace-insensitive to take the
 * edge off.
 */
export function parseGoalMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof raw !== 'string') return map
  for (const pair of raw.split(',')) {
    // Split on the LAST colon, not the first: a Beeminder goal slug cannot
    // contain one, but a habit called "Reading: 30 minutes" very much can, and
    // splitting at the first would map "Reading" to " 30 minutes" — a goal that
    // does not exist, failing silently on every settlement.
    const at = pair.lastIndexOf(':')
    if (at === -1) continue
    const key = pair.slice(0, at).trim().toLowerCase()
    const slug = pair.slice(at + 1).trim()
    if (key && slug) map.set(key, slug)
  }
  return map
}

/** Which goal, if any, this habit's title is mapped to. */
export function goalForTitle(config: Record<string, unknown>, title: string): string | null {
  return parseGoalMap(config.goals).get(title.trim().toLowerCase()) ?? null
}
