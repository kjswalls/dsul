import type { Goal, Item, Season, Routine } from '@dsul/types'
import { getCache } from './cache.js'
import type { DsulCache } from './plugin-types.js'

function getLocalDate(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date())
}

/** ~200–400 tokens — returned by dsul_get_context tool */
export function buildFullContext(): string {
  const cache = getCache()
  if (!cache) return ''
  const timezone = cache.userTimezone ?? "UTC"
  const today = getLocalDate(timezone)
  const lines: string[] = []

  const pending = cache.tasks.filter((t) => t.status === 'pending')
  const todayTasks = pending.filter((t) => !t.startDate || t.startDate === today)
  const overdue = pending.filter((t) => t.startDate && t.startDate < today)
  const upcoming = pending.filter((t) => t.startDate && t.startDate > today)

  if (todayTasks.length) {
    lines.push("## Today's Tasks")
    for (const t of todayTasks) {
      const pri = t.priority ? ` [${t.priority}]` : ''
      const proj = t.project ? ` (${t.project})` : ''
      const time = t.startTime ? ` @ ${t.startTime}` : ''
      lines.push(`- ${t.title} [id: ${t.id}]${pri}${proj}${time}`)
    }
  }
  if (overdue.length) {
    lines.push('\n## Overdue Tasks')
    for (const t of overdue) lines.push(`- ${t.title} [id: ${t.id}] [overdue: ${t.startDate}]`)
  }
  if (upcoming.length) {
    lines.push('\n## Upcoming Tasks')
    for (const t of upcoming.slice(0, 5)) lines.push(`- ${t.title} [id: ${t.id}] (${t.startDate})`)
    if (upcoming.length > 5) lines.push(`  …and ${upcoming.length - 5} more`)
  }

  const pendingHabits = cache.habits.filter((h) => h.status === 'pending')
  const doneHabits = cache.habits.filter((h) => h.status === 'done')
  if (pendingHabits.length || doneHabits.length) {
    lines.push('\n## Habits')
    for (const h of doneHabits) lines.push(`- ✅ ${h.title} [id: ${h.id}] (${h.streak} day streak)`)
    for (const h of pendingHabits) lines.push(`- ⬜ ${h.title} [id: ${h.id}] (${h.streak} day streak)`)
  }

  if (cache.projects.length) {
    lines.push('\n## Projects')
    for (const p of cache.projects) lines.push(`- ${p.emoji} ${p.name}`)
  }

  lines.push(...renderCollections(cache.routines, cache.seasons, today))
  const suppressedIds = suppressedItemIds(cache)
  lines.push(...renderGoals(cache.goals, cache.items, today, suppressedIds))
  lines.push(...renderPaused(cache, today, suppressedIds))

  return lines.join('\n')
}

/**
 * Is a pause interval still open on `today`?
 *
 * `pausedUntil` is EXCLUSIVE, and an expired pause leaves BOTH columns in place
 * on purpose (the app's resume normalizes rather than clearing, so the interval
 * survives for the auto-age sweep). So the presence of `pausedAt` alone does
 * not mean paused, and reading it that way would report a comeback date already
 * in the past.
 *
 * This is a date comparison, not a second resolver: it never looks at
 * containers, and nothing here decides what is VISIBLE — the server already did
 * that, and renderPaused reads its answer.
 */
function pauseIsOpen(x: { pausedAt?: string; pausedUntil?: string }, today: string): boolean {
  if (!x.pausedAt) return false
  return !x.pausedUntil || x.pausedUntil > today
}

/**
 * Routines and seasons, so the ids above are actionable rather than mysterious.
 *
 * Season state is reported as stored, not resolved: 'auto' plus a range is a
 * different thing from 'active', and flattening them to on/off would invite the
 * repair that destroys the distinction — writing 'active' onto an `auto`
 * season short-circuits the range permanently.
 */
function renderCollections(routines: Routine[], seasons: Season[], today: string): string[] {
  if (!routines.length && !seasons.length) return []
  const lines = ['\n## Collections']
  for (const r of routines) {
    const state = pauseIsOpen(r, today)
      ? r.pausedUntil
        ? ` (paused until ${r.pausedUntil})`
        : ' (paused)'
      : ''
    lines.push(`- Routine: ${r.name} [id: ${r.id}]${state}`)
  }
  for (const p of seasons) {
    const range = p.startsOn || p.endsOn ? ` ${p.startsOn ?? '…'} → ${p.endsOn ?? '…'}` : ''
    lines.push(`- Season: ${p.name} [id: ${p.id}] (${p.state}${range})`)
  }
  return lines
}

/**
 * Long-horizon goals, with their milestones spelled out.
 *
 * ACTIVE goals only: an achieved or abandoned goal is a record of finished
 * work, and listing it here would put its milestones back in front of a model
 * that is being asked what to do next.
 *
 * Milestones are listed rather than SUMMARIZED into a fraction on purpose. The
 * app derives progress in one place (lib/goals.ts) under rules this side cannot
 * see — cancelled checkpoints leave both sides of the ratio, trashed ones too,
 * and a custom type's "done" status is whatever its registry entry says. A
 * percentage computed out here would be a second resolver that disagrees with
 * the app's own number the first time either rule moves. The rows below are
 * facts: a title, a target date, and an id to act on.
 */
function renderGoals(
  goals: Goal[],
  items: Item[],
  today: string,
  suppressedIds: ReadonlySet<string>,
): string[] {
  // Item is a discriminated union and the habit arm carries no startDate. A
  // habit can never hold the milestone role (it never finishes), but the map
  // lookup below hands back the union either way.
  const startDateOf = (i: Item): string | undefined => ('startDate' in i ? i.startDate : undefined)

  const active = goals.filter((g) => g.state === 'active')
  if (!active.length) return []

  const byId = new Map(items.map((i) => [i.id, i]))
  const lines = ['\n## Goals']
  for (const goal of active) {
    const window =
      goal.startsOn || goal.targetOn ? ` (${goal.startsOn ?? '…'} → ${goal.targetOn ?? '…'})` : ''
    lines.push(`- ${goal.name} [id: ${goal.id}]${window}`)
    if (goal.why) lines.push(`  why: ${goal.why}`)

    // Date-ordered, undated last — the same order the goal surface shows, so a
    // model reading this and a user reading the app see the same sequence.
    const milestones = goal.milestoneIds
      .map((id) => byId.get(id))
      .filter((i): i is Item => !!i)
      .sort((a, b) =>
        (startDateOf(a) ?? '9999-12-31').localeCompare(startDateOf(b) ?? '9999-12-31'),
      )
    for (const m of milestones) {
      const on = startDateOf(m)
      // OVERDUE is not "dated in the past". A completed milestone of a mature
      // goal is always dated in the past, and a cancelled one is a dropped
      // checkpoint, not a late one — marking either would render a goal that is
      // going well as a wall of overdue work and invite a model to reschedule
      // things that are done. And a suppressed item is what the "Set aside"
      // section below explicitly says is NOT slipping.
      const late = on && on < today && m.status === 'pending' && !suppressedIds.has(m.id)
      const aside = suppressedIds.has(m.id) ? ', set aside' : ''
      const when = on ? ` (${on}${late ? ', overdue' : ''}${aside})` : aside ? ` (${aside.slice(2)})` : ''
      lines.push(`  - milestone: ${m.title} [id: ${m.id}] [${m.status}]${when}`)
    }
    for (const id of goal.checkinIds) {
      const c = byId.get(id)
      if (c) {
        const aside = suppressedIds.has(c.id) ? ' (set aside)' : ''
        lines.push(`  - check-in: ${c.title} [id: ${c.id}]${aside}`)
      }
    }
    const members = goal.memberIds
      .map((id) => byId.get(id))
      .filter((i): i is Item => !!i)
      .map((m) => (suppressedIds.has(m.id) ? `${m.title} (set aside)` : m.title))
    if (members.length) {
      lines.push(`  - also holds: ${members.join(', ')}`)
    }
  }
  return lines
}

/**
 * The work that is deliberately set aside.
 *
 * Derived as a SET DIFFERENCE — items[] arrives unfiltered while tasks[] and
 * habits[] have had suppressed open loops removed server-side, so the gap
 * between them is the server's own answer, read rather than recomputed. That is
 * the whole point: reimplementing lib/active.ts's path algebra out here would
 * be a second resolver, and the two would disagree the first time either
 * changed.
 *
 * Without this section a paused item simply vanishes from the lists above, and
 * a model asked about it by name will answer from the absence — that it was
 * finished, dropped, or never existed. The last two invite a recreate that
 * duplicates the row.
 */
function suppressedItemIds(cache: DsulCache): Set<string> {
  const visible = new Set([...cache.tasks.map((t) => t.id), ...cache.habits.map((h) => h.id)])
  // Only the two projected types. A custom type appears in items[] and in
  // NEITHER projection by design, so without this it would read as suppressed.
  return new Set(
    cache.items
      .filter((i) => (i.type === 'task' || i.type === 'habit') && !visible.has(i.id))
      .map((i) => i.id),
  )
}

function renderPaused(cache: DsulCache, today: string, ids: ReadonlySet<string>): string[] {
  if (!cache.items.length) return []
  const suppressed = cache.items.filter((i) => ids.has(i.id))
  if (!suppressed.length) return []

  const lines = [
    '\n## Set aside',
    'Deliberately paused — NOT overdue and not missed. Do not suggest these or ' +
      'count them as slipping, and do not recreate them: they still exist and ' +
      'come back on their own.',
  ]
  for (const item of suppressed) {
    lines.push(`- ${item.title} [id: ${item.id}] — ${causeFor(item, cache, today)}`)
  }
  return lines
}

function causeFor(item: Item, cache: DsulCache, today: string): string {
  // The item's own pause wins the explanation, matching lib/active.ts — it is
  // the one the user set on this row and the one this row's own resume undoes.
  // Naming a container instead would send them to a control that leaves the
  // item hidden.
  if (pauseIsOpen(item, today)) {
    return item.pausedUntil ? `paused until ${item.pausedUntil}` : 'paused'
  }

  const routines = cache.routines.filter((r) => r.itemIds.includes(item.id))
  const routineIds = new Set(routines.map((r) => r.id))
  const season = cache.seasons.find(
    (p) => p.itemIds.includes(item.id) || p.routineIds.some((id) => routineIds.has(id)),
  )
  // No return DATE is offered for a container, deliberately. An item can be
  // blocked by a routine inside a switched-off season at once, and naming
  // the one that clears FIRST would promise a comeback the item will not
  // honour. The app settles that with a binding-constraint rule; half of that
  // rule out here would be worse than none, so this names a cause and stops.
  if (season) return `set aside with the ${season.name} season`
  if (routines.length) return `set aside with the ${routines[0].name} routine`
  return 'set aside'
}
