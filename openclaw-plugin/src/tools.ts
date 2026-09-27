import { Type } from '@sinclair/typebox'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import type { PluginConfig } from './plugin-types.js'
import { fetchContext, shouldRefreshCache, shouldSkipInjection, markCacheDirty, markContextInjected, getLastInjectedAt } from './cache.js'
import { buildFullContext } from './context.js'

/** AgentTool requires `details` on every result; we have no structured payload
 *  to report, so it is always an empty object. */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

function errorResult(status: number, text: string) {
  return textResult(`Error ${status}: ${text}`)
}

export function registerTools(api: OpenClawPluginApi, cfg: PluginConfig): void {
  // ── dsul_get_context ────────────────────────────────────────────────────
  api.registerTool((ctx: { sessionId?: string }) => ({
    name: 'dsul_get_context',
    label: 'dsul: Get Context',
    description: 'Retrieve current tasks, habits, and projects from dsul. Call this before responding to any task or habit management request, when the user asks about their schedule or what they need to do today, or when you need fresh context after making changes. Returns a short acknowledgement if context is already fresh in this session.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string) {
      const ttlMs = cfg.cacheTtlMs ?? 5 * 60 * 1000
      const conversationId = ctx.sessionId ?? 'default'
      if (shouldSkipInjection(ttlMs, conversationId)) {
        const ago = Math.round((Date.now() - getLastInjectedAt(conversationId)!) / 1000)
        return textResult(`Context unchanged (injected ${ago}s ago) — use what is already in your context window.`)
      }
      if (shouldRefreshCache(ttlMs)) {
        try { await fetchContext(cfg) } catch (err) {
          return errorResult(500, (err as Error).message)
        }
      }
      const context = buildFullContext()
      markContextInjected(conversationId)
      return textResult(context || 'No context available.')
    },
  }))

  // ── dsul_create_task ────────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_create_task',
    label: 'dsul: Create Task',
    description: 'Create a new task in dsul.',
    parameters: Type.Object({
      title: Type.String({ description: 'Task title' }),
      startDate: Type.Optional(Type.String({ description: 'YYYY-MM-DD' })),
      startTime: Type.Optional(Type.String({ description: 'HH:MM' })),
      timeBucket: Type.Optional(Type.String({ description: 'anytime | morning | afternoon | evening' })),
      priority: Type.Optional(Type.String({ description: 'low | medium | high' })),
      project: Type.Optional(Type.String({ description: 'Project name' })),
    }),
    async execute(_toolCallId: string, params: {
      title: string
      startDate?: string
      startTime?: string
      timeBucket?: string
      priority?: string
      project?: string
    }) {
      const body: Record<string, unknown> = {
        title: params.title,
        status: 'pending',
        isScheduled: !!params.startDate,
        order: 0,
      }
      if (params.startDate) body.startDate = params.startDate
      if (params.startTime) body.startTime = params.startTime
      if (params.timeBucket) body.timeBucket = params.timeBucket
      if (params.priority) body.priority = params.priority
      if (params.project) body.project = params.project

      const res = await fetch(`${cfg.dsulUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Task created: ${text}`)
    },
  })

  // ── dsul_update_task ────────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_update_task',
    label: 'dsul: Update Task',
    description: 'Update an existing task in dsul. For one-off tasks, set status to complete them. For recurring tasks, use completedDates instead of status to record per-date completions.',
    parameters: Type.Object({
      id: Type.String({ description: 'Task UUID' }),
      title: Type.Optional(Type.String()),
      status: Type.Optional(Type.String({ description: 'pending | completed | cancelled (one-off tasks only; not for recurring tasks)' })),
      startDate: Type.Optional(Type.String({ description: 'YYYY-MM-DD' })),
      startTime: Type.Optional(Type.String({ description: 'HH:MM' })),
      priority: Type.Optional(Type.String({ description: 'low | medium | high' })),
      project: Type.Optional(Type.String({ description: 'Project name' })),
      completedDates: Type.Optional(Type.Array(Type.String(), { description: '(recurring tasks only) full set of ISO date strings YYYY-MM-DD in user\'s timezone representing all completion dates' })),
    }),
    async execute(_toolCallId: string, params: {
      id: string
      title?: string
      status?: string
      startDate?: string
      startTime?: string
      priority?: string
      project?: string
      completedDates?: string[]
    }) {
      const { id, ...fields } = params
      const body: Record<string, unknown> = {}
      if (fields.title !== undefined) body.title = fields.title
      if (fields.status !== undefined) body.status = fields.status
      if (fields.startDate !== undefined) body.startDate = fields.startDate
      if (fields.startTime !== undefined) body.startTime = fields.startTime
      if (fields.priority !== undefined) body.priority = fields.priority
      if (fields.project !== undefined) body.project = fields.project
      if (fields.completedDates !== undefined) body.completedDates = fields.completedDates

      const res = await fetch(`${cfg.dsulUrl}/api/agent/tasks/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Task updated: ${text}`)
    },
  })

  // ── dsul_delete_task ────────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_delete_task',
    label: 'dsul: Delete Task',
    description: 'Soft-delete a task in dsul (recoverable from trash for 30 days).',
    parameters: Type.Object({
      id: Type.String({ description: 'Task UUID' }),
    }),
    async execute(_toolCallId: string, params: { id: string }) {
      const res = await fetch(`${cfg.dsulUrl}/api/agent/tasks/${params.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Task deleted.`)
    },
  })

  // ── dsul_create_habit ───────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_create_habit',
    label: 'dsul: Create Habit',
    description: 'Create a new habit in dsul.',
    parameters: Type.Object({
      title: Type.String({ description: 'Habit title' }),
      repeatFrequency: Type.Optional(Type.String({ description: 'daily | weekly | weekdays | weekends | monthly | custom' })),
      repeatDays: Type.Optional(Type.Array(Type.Number(), { description: 'Days of week (0=Sun … 6=Sat)' })),
    }),
    async execute(_toolCallId: string, params: {
      title: string
      repeatFrequency?: string
      repeatDays?: number[]
    }) {
      const body: Record<string, unknown> = { title: params.title }
      if (params.repeatFrequency) body.repeatFrequency = params.repeatFrequency
      if (params.repeatDays) body.repeatDays = params.repeatDays

      const res = await fetch(`${cfg.dsulUrl}/api/agent/habits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Habit created: ${text}`)
    },
  })

  // ── dsul_update_habit ───────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_update_habit',
    label: 'dsul: Update Habit',
    description: 'Update an existing habit in dsul.',
    parameters: Type.Object({
      id: Type.String({ description: 'Habit UUID' }),
      title: Type.Optional(Type.String()),
      repeatFrequency: Type.Optional(Type.String({ description: "none | daily | weekly | weekdays | weekends | monthly | custom" })),
      repeatDays: Type.Optional(Type.Array(Type.Number(), { description: "Day indices (0=Sun) for custom/weekly recurrence" })),
    }),
    async execute(_toolCallId: string, params: { id: string; title?: string; repeatFrequency?: string; repeatDays?: number[] }) {
      const body: Record<string, unknown> = {}
      if (params.title !== undefined) body.title = params.title
      if (params.repeatFrequency !== undefined) body.repeatFrequency = params.repeatFrequency
      if (params.repeatDays !== undefined) body.repeatDays = params.repeatDays

      const res = await fetch(`${cfg.dsulUrl}/api/agent/habits/${params.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Habit updated: ${text}`)
    },
  })

  // ── dsul_delete_habit ───────────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_delete_habit',
    label: 'dsul: Delete Habit',
    description: 'Soft-delete a habit in dsul.',
    parameters: Type.Object({
      id: Type.String({ description: 'Habit UUID' }),
    }),
    async execute(_toolCallId: string, params: { id: string }) {
      const res = await fetch(`${cfg.dsulUrl}/api/agent/habits/${params.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      return textResult(`Habit deleted.`)
    },
  })

  // ── dsul_pause ──────────────────────────────────────────────────────────
  //
  // One tool for the three entities that pause through the same two columns.
  // Seasons are deliberately NOT here: they switch through `state`, and the
  // difference matters enough to make the caller say it — see
  // dsul_update_collection.
  api.registerTool({
    name: 'dsul_pause',
    label: 'dsul: Pause or Resume',
    description:
      'Pause or resume a task, habit, or routine. Pausing HIDES it from the ' +
      'schedule and every list without deleting it, and without touching its ' +
      'streak, completion history, or dates — resuming brings it back exactly ' +
      'as it was. Use this instead of deleting when the user is stepping away ' +
      'from something (travel, illness, a season off) rather than abandoning ' +
      'it. Pausing a routine hides all of its members at once.',
    parameters: Type.Object({
      kind: Type.String({ description: 'task | habit | routine' }),
      id: Type.String({ description: 'UUID of the task, habit, or routine' }),
      paused: Type.Boolean({ description: 'true to pause, false to resume now' }),
      until: Type.Optional(
        Type.String({
          description:
            'YYYY-MM-DD to come back ON (exclusive — live again that morning). ' +
            'Only with paused: true, and it must be later than today. Omit for ' +
            'an open-ended pause.',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { kind: string; id: string; paused: boolean; until?: string },
    ) {
      const path = PAUSE_PATHS[params.kind]
      if (!path) {
        // Goals are the kind a model will actually try to pause, so the refusal
        // names what to do instead rather than only what is wrong.
        const hint =
          params.kind === 'goal'
            ? " Goals do not pause — they hide nothing. Use dsul_update_collection with state: achieved or abandoned to close one, or put the work in a season to set it aside for a season."
            : ''
        return errorResult(
          400,
          `kind must be task, habit, or routine (got "${params.kind}").${hint}`,
        )
      }

      const body: Record<string, unknown> = { paused: params.paused }
      // Sent only when pausing: the API rejects a resume date alongside
      // paused: false, because "resume ON this date" is exactly what it would
      // NOT do.
      if (params.paused && params.until) body.pausedUntil = params.until

      const res = await fetch(`${cfg.dsulUrl}/api/agent/${path}/${params.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      const when = params.until ? ` until ${params.until}` : ''
      return textResult(params.paused ? `Paused${when}.` : 'Resumed.')
    },
  })

  // ── dsul_create_collection ──────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_create_collection',
    label: 'dsul: Create Routine, Season or Goal',
    description:
      'Create a ROUTINE (things done regularly, together and in order — a ' +
      'morning, a workout week — that can be paused as one), a SEASON (a period of life, like a ' +
      'summer or a term, holding items and/or routines that appear only while ' +
      'it is on), or a GOAL (a long-horizon aspiration — learn Chinese, build ' +
      'the business — holding work in three roles). Members must already ' +
      'exist; create the items first and pass their ids. Subtasks cannot be ' +
      'members. Goals HIDE NOTHING: use a season if the intent is to set work ' +
      'aside for a season.',
    parameters: Type.Object({
      kind: Type.String({ description: 'routine | season | goal' }),
      name: Type.String({ description: 'Display name' }),
      itemIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Routines and seasons only — member task/habit UUIDs. A GOAL uses ' +
            'memberIds / milestoneIds / checkinIds instead, because its ' +
            'membership carries a role.',
        }),
      ),
      routineIds: Type.Optional(
        Type.Array(Type.String(), { description: 'Held routine UUIDs (seasons only)' }),
      ),
      state: Type.Optional(
        Type.String({
          description:
            'Seasons: auto (default) follows startsOn/endsOn; active and ' +
            'paused are manual overrides that IGNORE the dates until changed ' +
            'back. Goals: active (default) | achieved | abandoned.',
        }),
      ),
      startsOn: Type.Optional(
        Type.String({ description: 'YYYY-MM-DD, inclusive. Seasons and goals.' }),
      ),
      endsOn: Type.Optional(Type.String({ description: 'Seasons only, YYYY-MM-DD, inclusive' })),
      why: Type.Optional(Type.String({ description: "Goals only — the motivation line" })),
      targetOn: Type.Optional(
        Type.String({ description: 'Goals only, YYYY-MM-DD — when it is meant to be done' }),
      ),
      memberIds: Type.Optional(
        Type.Array(Type.String(), { description: 'Goals only — ordinary work the goal contains' }),
      ),
      milestoneIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Goals only — ONE-SHOT targets. Their startDate is the target date. ' +
            'A repeating item is refused: it never finishes, so it can never be reached.',
        }),
      ),
      checkinIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Goals only — RECURRING reviews of how the goal is going. A ' +
            'one-shot item is refused: give it a repeatFrequency first.',
        }),
      ),
    }),
    async execute(_toolCallId: string, params: CollectionParams) {
      return writeCollection(cfg, params, 'POST')
    },
  })

  // ── dsul_update_collection ──────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_update_collection',
    label: 'dsul: Update Routine, Season or Goal',
    description:
      'Update a routine, season or goal. Membership arrays REPLACE the whole ' +
      'set rather than adding to it — read the current members from context ' +
      'first and send the full intended list. To switch a season on or off, ' +
      'set state: active or paused; to hand it back to its dates, set state: ' +
      'auto. Prefer state: auto when the user describes a period ("all ' +
      'summer") so it turns itself off on time. To close a goal, set state: ' +
      'achieved or abandoned — the achievement date is stamped for you, and ' +
      'setting state back to active clears it. Goals do not pause.',
    parameters: Type.Object({
      kind: Type.String({ description: 'routine | season | goal' }),
      id: Type.String({ description: 'Routine, season or goal UUID' }),
      name: Type.Optional(Type.String()),
      itemIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Routines and seasons only — FULL replacement member list. A GOAL ' +
            'uses memberIds / milestoneIds / checkinIds instead.',
        }),
      ),
      routineIds: Type.Optional(
        Type.Array(Type.String(), { description: 'FULL replacement routine list (seasons only)' }),
      ),
      state: Type.Optional(
        Type.String({
          description:
            'Seasons: auto | active | paused. Goals: active | achieved | abandoned.',
        }),
      ),
      startsOn: Type.Optional(Type.String({ description: 'Seasons and goals, YYYY-MM-DD' })),
      endsOn: Type.Optional(Type.String({ description: 'Seasons only, YYYY-MM-DD' })),
      why: Type.Optional(Type.String({ description: 'Goals only — the motivation line' })),
      targetOn: Type.Optional(Type.String({ description: 'Goals only, YYYY-MM-DD' })),
      memberIds: Type.Optional(
        Type.Array(Type.String(), { description: 'Goals only — FULL replacement member list' }),
      ),
      milestoneIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Goals only — FULL replacement list of one-shot targets. An item ' +
            'holds exactly ONE role per goal, so naming the same id here and ' +
            'in another array is refused rather than resolved.',
        }),
      ),
      checkinIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Goals only — FULL replacement list of recurring reviews',
        }),
      ),
    }),
    async execute(_toolCallId: string, params: CollectionParams & { id: string }) {
      return writeCollection(cfg, params, 'PATCH')
    },
  })

  // ── dsul_delete_collection ──────────────────────────────────────────────
  api.registerTool({
    name: 'dsul_delete_collection',
    label: 'dsul: Delete Routine, Season or Goal',
    description:
      'Soft-delete a routine, season or goal (recoverable for 30 days). Its ' +
      'MEMBERS are not deleted — they are released and become visible again ' +
      'immediately. To hide the members instead, pause the collection. For a ' +
      'goal that is over rather than mistaken, prefer state: achieved or ' +
      'abandoned — that keeps the record and its milestones.',
    parameters: Type.Object({
      kind: Type.String({ description: 'routine | season | goal' }),
      id: Type.String({ description: 'Routine, season or goal UUID' }),
    }),
    async execute(_toolCallId: string, params: { kind: string; id: string }) {
      const path = COLLECTION_PATHS[params.kind]
      if (!path) {
        return errorResult(400, `kind must be one of ${COLLECTION_KINDS} (got "${params.kind}")`)
      }
      const res = await fetch(`${cfg.dsulUrl}/api/agent/${path}/${params.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      })
      const text = await res.text()
      if (!res.ok) return errorResult(res.status, text)
      markCacheDirty()
      // A goal hid nothing, so nothing became visible — saying otherwise
      // teaches the mental model the create tool works to prevent.
      return textResult(
        params.kind === 'goal'
          ? 'Deleted — its members are untouched, and its milestones are still ordinary items.'
          : 'Deleted — its members are visible again.',
      )
    },
  })
}

const PAUSE_PATHS: Record<string, string | undefined> = {
  task: 'tasks',
  habit: 'habits',
  routine: 'routines',
}

const COLLECTION_PATHS: Record<string, string | undefined> = {
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
}

/** Human list for the 400s, so the message tracks the map above. */
const COLLECTION_KINDS = Object.keys(COLLECTION_PATHS).join(', ')

/**
 * Keys that belong to exactly one kind. Anything not listed for the kind being
 * written is dropped before the request — the API strips unknown keys anyway,
 * but forwarding them makes the plugin's own log read as though a routine were
 * handed a date range it silently lost.
 */
const KIND_KEYS: Record<string, readonly string[]> = {
  routine: ['name', 'itemIds'],
  season: ['name', 'itemIds', 'routineIds', 'state', 'startsOn', 'endsOn'],
  goal: ['name', 'why', 'state', 'startsOn', 'targetOn', 'memberIds', 'milestoneIds', 'checkinIds'],
}

const KIND_LABELS: Record<string, string> = {
  routine: 'Routine',
  season: 'Season',
  goal: 'Goal',
}

interface CollectionParams {
  kind: string
  id?: string
  name?: string
  itemIds?: string[]
  routineIds?: string[]
  state?: string
  startsOn?: string
  endsOn?: string
  /** Goals only. */
  why?: string
  targetOn?: string
  memberIds?: string[]
  milestoneIds?: string[]
  checkinIds?: string[]
}

async function writeCollection(
  cfg: PluginConfig,
  params: CollectionParams,
  method: 'POST' | 'PATCH',
) {
  const path = COLLECTION_PATHS[params.kind]
  if (!path) return errorResult(400, `kind must be one of ${COLLECTION_KINDS} (got "${params.kind}")`)

  const { kind, id, ...fields } = params
  const allowed = KIND_KEYS[kind]
  // Paired with COLLECTION_PATHS above; a kind in one map and not the other
  // would otherwise crash the tool on `undefined is not iterable`.
  if (!allowed) return errorResult(500, `no key allowlist for kind "${kind}"`)

  // A key this kind does not have is REFUSED, not dropped. Silently stripping
  // `itemIds` off a goal write is how a model concludes it added the members it
  // did not add — the server can no longer refuse what never reaches it.
  const stray = Object.keys(fields).filter(
    (k) => (fields as Record<string, unknown>)[k] !== undefined && !allowed.includes(k),
  )
  if (stray.length) {
    const hint =
      kind === 'goal' && stray.includes('itemIds')
        ? " A goal's membership carries a role: use memberIds, milestoneIds or checkinIds."
        : ''
    return errorResult(400, `${KIND_LABELS[kind]} has no ${stray.join(', ')}.${hint}`)
  }

  const body: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = (fields as Record<string, unknown>)[key]
    if (value !== undefined) body[key] = value
  }

  const url =
    method === 'POST'
      ? `${cfg.dsulUrl}/api/agent/${path}`
      : `${cfg.dsulUrl}/api/agent/${path}/${id}`
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) return errorResult(res.status, text)
  markCacheDirty()
  return textResult(`${KIND_LABELS[kind]} saved: ${text}`)
}
