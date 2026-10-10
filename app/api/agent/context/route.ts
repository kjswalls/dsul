import { NextRequest, NextResponse } from 'next/server'
import type { HabitItem, TaskItem } from '@dsul/types'
import { createClient } from '@/lib/supabase-server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { fetchItems, fetchProjects, fetchRoutines, fetchSeasons, toLegacyTask, toLegacyHabit, fetchGoals } from '@/lib/db'
import { isOpenLoopSuppressedOn } from '@/lib/active'
import { toDateStr } from '@/lib/recurrence'

/**
 * GET /api/agent/context
 *
 * Returns the authenticated user's current tasks, habits, projects, and habit
 * groups. Used by the OpenClaw dsul plugin to seed its local context cache.
 *
 * `habitGroups[]` is a PROJECTION of `projects[]` since migration 039 collapsed
 * the two CLASSIFY kinds — see the response below.
 *
 * Auth (either):
 *   A) Bearer <openclaw_api_key>  — server-to-server (plugin uses this)
 *      userId is resolved from the key — no query param needed
 *   B) Supabase session cookie    — in-browser / logged-in user
 */
export async function GET(req: NextRequest) {
  const { userId, isBearer } = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Bearer token (plugin/server-to-server) → use service client to bypass RLS
  // Session cookie (in-browser) → RLS handles it naturally, no service client needed
  const dbClient = isBearer ? createServiceClient() : undefined

  const serviceClient = createServiceClient()
  const [
    items,
    projects,
    routinesResult,
    seasonsResult,
    goalsResult,
    settingsResult,
  ] =
    await Promise.all([
      fetchItems(userId, undefined, dbClient),
      fetchProjects(userId, dbClient),
      // Both are needed for the filter below to see container-caused
      // suppression. Without them the server answers "pending" for work the app
      // itself hides, and the plugin nags about it.
      fetchRoutines(userId, dbClient),
      fetchSeasons(userId, dbClient),
      fetchGoals(userId, dbClient),
      serviceClient
        .from('user_settings')
        .select('timezone')
        .eq('user_id', userId)
        .single(),
    ])
  // null means the tables are unreachable — degrade to item-level pause rather
  // than 500ing a read the plugin depends on.
  //
  // The nullable results stay in scope: the FILTER wants `[]` (resolve what we
  // can), but the RESPONSE must not, because emitting an empty array asserts
  // "you have no seasons" to a consumer that could act on it. Those are
  // different answers to different questions off one fetch.
  const routines = routinesResult ?? []
  const seasons = seasonsResult ?? []

  // Timezone priority: stored user setting → X-Timezone header fallback → UTC
  // The client syncs the browser timezone to user_settings on every app load,
  // so the stored value stays current even when users travel.
  //
  // Resolved BEFORE the projections below, which read it: this is a dateless
  // surface, so "today" is the user's day per plan decision 3.
  const userTimezone =
    settingsResult.data?.timezone ??
    req.headers.get('x-timezone') ??
    'UTC'
  const todayStr = toDateStr(new Date(), userTimezone)

  // The pinned tasks[]/habits[] arrays are projections of the same items
  // fetch — filtering preserves the per-type relative order the old
  // fetchTasks/fetchHabits queries produced. Future custom types appear in
  // items[] only.
  //
  // Suppressed OPEN LOOPS are dropped: a deployed plugin would otherwise
  // narrate paused work as pending and nag about it, since the plugin has no
  // concept of pausing and cannot get one without an npm republish. Arrays may
  // shrink freely — that is schema-safe for every build ever published, whereas
  // a new field or status value is not.
  //
  // Dropping whole rows takes their history with them, which is the ONE
  // recorded waiver of the history rule (plan decision 6). It is acceptable
  // only because items[] below stays unfiltered and carries the same rows
  // complete, pause metadata included, for future plugin builds. A paused item
  // that was already marked today is NOT an open loop, so it stays in these
  // arrays and the plugin's narration keeps matching the EOD review.
  const visible = items.filter(
    (i) => !isOpenLoopSuppressedOn(i, todayStr, { userTimezone, routines, seasons })
  )
  const tasks = visible.filter((i): i is TaskItem => i.type === 'task').map(toLegacyTask)
  const habits = visible.filter((i): i is HabitItem => i.type === 'habit').map(toLegacyHabit)

  return NextResponse.json({
    userId,
    fetchedAt: new Date().toISOString(),
    userTimezone,
    tasks,
    habits,
    projects,
    /**
     * THE SAME CONTAINERS, UNDER THE OTHER NAME (migration 039).
     *
     * `DsulContextResponseSchema.habitGroups` is a REQUIRED array and the
     * plugin `safeParse`s the whole response, throwing on drift — so omitting
     * this key would brick every deployed build's cached context on its next
     * fetch, not degrade it. There is one container kind now, so the honest
     * projection is the whole list: a container IS a project and IS a habit
     * group, and an agent asking either question gets the same true answer.
     *
     * Narrowed to `HabitGroupSchema`'s four fields rather than passed whole.
     * `ProjectSchema` carries a time block (repeatFrequency, timeBucket,
     * startTime, duration) that a habit group never had; an older build strips
     * unknown keys rather than throwing, so shipping them would parse — and
     * would quietly tell a model that habit groups have schedules.
     */
    habitGroups: projects.map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
    // Additive — old plugin builds strip unknown keys. Version 2 = tasks/habits
    // are projections of the unified items table (migration 019); version 3 =
    // unified items[] included alongside the legacy projections.
    items,
    // The suppression CAUSES, so a consumer can explain an absence instead of
    // guessing at it. Without these, an item that leaves tasks[] because its
    // season was switched off is indistinguishable from one that was
    // deleted — and the sensible-looking repair (recreate it) is the wrong
    // move on every count.
    //
    // Spread, not `routines: routinesResult ?? []`: see the note above the
    // coalesce. An unreachable table omits the key rather than claiming zero.
    ...(routinesResult ? { routines: routinesResult } : {}),
    ...(seasonsResult ? { seasons: seasonsResult } : {}),
    // Same spread-or-omit rule, and the same reason: `[]` asserts "you have no
    // goals" to a consumer whose natural repair is to offer to make one.
    ...(goalsResult ? { goals: goalsResult } : {}),
    schemaVersion: 6,
  })
}

async function resolveUserId(req: NextRequest): Promise<{ userId: string | null; isBearer: boolean }> {
  // 1. Bearer token → look up by openclaw_api_key (plugin / server-to-server),
  // or an OAuth app's access token of either scope: reading is all this does.
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const userId = await resolveUserIdFromApiKey(token, undefined, 'read')
    return { userId, isBearer: true }
  }

  // 2. Supabase session cookie (in-browser)
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return { userId: data.user?.id ?? null, isBearer: false }
}
