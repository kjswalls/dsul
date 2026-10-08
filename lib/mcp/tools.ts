import { AiStatusSchema } from '@dsul/types'
import { isItemActiveOn, isOpenLoopOn } from '../active'
import { AGENT_QUIET_AFTER_MS } from '../agent-status'
import { getItemTypeConfig } from '../item-registry'
import type { Item, Routine, Season } from '../planner-types'
import { toDateStr } from '../recurrence'
import type { McpToolDescriptor } from './protocol'

/**
 * tools.ts — dsul's planner, as MCP tools.
 *
 * Each tool is PURE planning: it turns arguments into "which agent-API endpoint,
 * which method, which body". Executing that plan is the transport's job. The
 * point of the split is that every semantic dsul's agent API enforces —
 * whole-set membership replacement, pause-as-a-verb, container-by-name,
 * goal-role eligibility, the demoted-roles response — keeps living in ONE place
 * (lib/agent-api.ts) instead of being re-implemented here. A tool surface that
 * re-derived those rules would drift from them, and the drift would look like
 * the model lying about what it did.
 *
 * Descriptions are written for a model, not a changelog: they say what the tool
 * is FOR and name the trap it would otherwise fall into.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface ToolPlan {
  method: HttpMethod
  /** Path under the agent API, e.g. '/api/agent/tasks/abc'. */
  path: string
  body?: Record<string, unknown>
  /**
   * Pure narrowing of a SUCCESSFUL response before the model sees it.
   *
   * The agent API has no list-with-filter endpoint — every read is the whole
   * account. A background worker that only wants "what am I supposed to be
   * doing" should not have to take the entire planner into its context to find
   * two rows, so a tool may trim what it asked for. Pure, so it stays testable
   * without a server.
   */
  transform?: (body: unknown) => unknown
}

export interface McpTool extends McpToolDescriptor {
  plan: (args: Record<string, unknown>) => ToolPlan | { error: string }
}

const str = (description: string) => ({ type: 'string' as const, description })
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

/** Ids come straight from get_context; a made-up one is a 404, not a create. */
const ID = str('The item id, exactly as it appears in get_context.')

const PRIORITY = { type: 'string', enum: ['low', 'medium', 'high'] }
const TIME_BUCKET = { type: 'string', enum: ['anytime', 'morning', 'afternoon', 'evening'] }
const DATE = str('Date as yyyy-MM-dd.')
const TIME = str('Time of day as HH:mm, 24-hour.')
const DURATION = {
  type: 'number',
  description: 'Minutes it takes. Sizes its block on the schedule; treat a time cap as this.',
}
const REMINDER_TIME = str(
  'HH:mm, 24-hour: when to send this item\'s reminder on each day it is due. ' +
    'On an update, send null to turn the reminder off.'
)
const REPEAT_FREQUENCY = {
  type: 'string',
  enum: ['none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom'],
  description: "How the task repeats. 'custom' needs repeatDays. Omit for a one-off.",
}
const REPEAT_DAYS = {
  type: 'array',
  items: { type: 'number' },
  description: 'Required when repeatFrequency is custom. 0 = Sunday … 6 = Saturday.',
}
const REPEAT_MONTH_DAY = {
  type: 'number',
  description: 'For repeatFrequency monthly: the day of the month, 1 to 31. A short month uses its last day.',
}

/** The one-day verbs' door: lib/app-api.ts postAgentItemAction. */
const actPath = (id: string) => `/api/agent/items/${id}/act`
const isDateStr = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const ONE_DAY = str("The day it applies to, yyyy-MM-dd, on the user's calendar (get_context gives userTimezone).")

const requireString = (
  args: Record<string, unknown>,
  key: string
): string | { error: string } => {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: `${key} is required and must be a non-empty string` }
  }
  return value
}

/** Copies only the keys a given endpoint accepts, dropping undefined. */
const pick = (args: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  for (const key of keys) if (args[key] !== undefined) body[key] = args[key]
  return body
}

const TASK_WRITE_KEYS = [
  'title', 'status', 'startDate', 'startTime', 'timeBucket', 'priority', 'project',
  'notes', 'duration', 'parentItemId', 'repeatFrequency', 'repeatDays', 'repeatMonthDay',
  'completedDates', 'reminderTime',
  // Delegation. These are how a background worker says what it is doing —
  // without them an agent can see its assignments and has no way to report on
  // them, which is the difference between delegation and a wish.
  'assignee', 'aiStatus', 'aiResult',
]

const HABIT_WRITE_KEYS = [
  'title', 'group', 'repeatFrequency', 'repeatDays', 'repeatMonthDay', 'timeBucket', 'startTime',
  'notes', 'timesPerDay', 'completedDates', 'skippedDates', 'duration', 'reminderTime',
]

const PROJECT_WRITE_KEYS = ['name', 'emoji', 'color', 'notes']

const COLLECTION_PATHS: Record<string, string> = {
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
}

/**
 * Which keys each collection kind accepts. Sending a key the kind does not take
 * is REFUSED rather than dropped — silently stripping `milestoneIds` off a
 * routine write is how a model concludes it created milestones it did not.
 */
const COLLECTION_KEYS: Record<string, string[]> = {
  routine: ['name', 'icon', 'color', 'usualTime', 'itemIds', 'paused', 'pausedUntil'],
  season: ['name', 'icon', 'color', 'itemIds', 'routineIds', 'state', 'startsOn', 'endsOn'],
  goal: ['name', 'icon', 'color', 'why', 'state', 'startsOn', 'targetOn', 'memberIds', 'milestoneIds', 'checkinIds'],
}

const PAUSE_PATHS: Record<string, string> = {
  task: 'tasks',
  habit: 'habits',
  routine: 'routines',
}

function planCollection(
  args: Record<string, unknown>,
  method: 'POST' | 'PATCH'
): ToolPlan | { error: string } {
  const kind = requireString(args, 'kind')
  if (typeof kind !== 'string') return kind
  const segment = COLLECTION_PATHS[kind]
  if (!segment) return { error: `kind must be one of: ${Object.keys(COLLECTION_PATHS).join(', ')}` }

  const allowed = COLLECTION_KEYS[kind]
  const supplied = Object.keys(args).filter((k) => k !== 'kind' && k !== 'id')
  const stray = supplied.filter((k) => !allowed.includes(k))
  if (stray.length > 0) {
    return {
      error: `A ${kind} does not take: ${stray.join(', ')}. It accepts: ${allowed.join(', ')}.`,
    }
  }

  if (method === 'POST') {
    const name = requireString(args, 'name')
    if (typeof name !== 'string') return name
    return { method, path: `/api/agent/${segment}`, body: pick(args, allowed) }
  }

  const id = requireString(args, 'id')
  if (typeof id !== 'string') return id
  return { method, path: `/api/agent/${segment}/${id}`, body: pick(args, allowed) }
}


/**
 * The delegation lifecycle. Imported, never re-typed: this vocabulary is a
 * frozen contract shared by the UI, the agent API and this tool surface, and a
 * second hand-written copy is how three slightly different spellings appear.
 */
const AI_STATUSES = AiStatusSchema.options

/**
 * The staleness line, shared with the UI's `AGENT_QUIET_AFTER_MS` rather than
 * described in prose.
 *
 * An earlier version of the `dsul_my_work` text said "minutes old" versus
 * "hours old" and named no boundary, so the model picked its own and picked a
 * different one each run.
 */
const QUIET_HOURS = Math.round(AGENT_QUIET_AFTER_MS / 3_600_000)

/** Statuses that still want something to happen. */
const OPEN_AI_STATUSES = new Set(['queued', 'working', 'blocked'])

interface AssignedItem {
  id: string
  title: string
  type: string
  assignee?: string
  aiStatus?: string
  aiResult?: string
  /**
   * When `aiStatus` last changed (migration 041), against the response's
   * `fetchedAt` so elapsed is computable.
   *
   * Without it a worker finding one of its own items at 'working' cannot tell a
   * four-minute run from a four-hour one — the same blindness the item row had
   * before this column existed, and the difference between "another pass is
   * still going" and "that run died and nobody noticed".
   */
  aiStatusAt?: string
  /** The item's own status, so the worker can see it was not just un-queued. */
  status?: string
  startDate?: string
  startTime?: string
  timeBucket?: string
  priority?: string
  notes?: string
}

/**
 * Narrows a full context response to the items that have been handed to an
 * agent. Pure; exported for tests.
 */

/**
 * Which of these items a routine or season has switched off today.
 *
 * Uses the routines and seasons the context response already carries, so the
 * suppression answer here is the same one the grid gives — computed, never
 * guessed. Absent arrays mean "the server did not say", which is not the same
 * as "you have none": with nothing to gate on, nothing is suppressed.
 */
function inactiveIdsFrom(
  items: Item[],
  dateStr: string,
  root: { userTimezone?: unknown; routines?: unknown; seasons?: unknown }
): Set<string> {
  const ctx = {
    userTimezone: typeof root.userTimezone === 'string' ? root.userTimezone : 'UTC',
    routines: Array.isArray(root.routines) ? (root.routines as Routine[]) : [],
    seasons: Array.isArray(root.seasons) ? (root.seasons as Season[]) : [],
  }
  const inactive = new Set<string>()
  for (const item of items) {
    try {
      if (!isItemActiveOn(item, dateStr, ctx)) inactive.add(item.id)
    } catch {
      // A malformed row must not take the whole poll down.
    }
  }
  return inactive
}

/**
 * The user's day at the moment the context was fetched.
 *
 * `fetchedAt` is a UTC instant, and its first ten characters are the UTC date,
 * which is not the day the user is living in for the hours between UTC midnight
 * and theirs. Everything else asks this on the local day: the context route's
 * own suppression, the grid, and the item menu's "Hand off" (which is meant to
 * offer only what this queue serves). Slicing here made a season that ends
 * today, or a pause that ends tomorrow, read differently to the queue for those
 * hours, so a hand-off the menu allowed sat at "Queued" with no one to take it.
 *
 * A missing or unreadable `fetchedAt` gives no day, which gates nothing (the
 * server did not say). A zone Intl does not know, which throws, falls back to
 * the UTC date, as before, rather than taking the poll down.
 */
function queueDayFrom(root: { fetchedAt?: unknown; userTimezone?: unknown }): string {
  const at = new Date(String(root.fetchedAt ?? ''))
  if (!Number.isFinite(at.getTime())) return ''
  const tz = typeof root.userTimezone === 'string' ? root.userTimezone : 'UTC'
  try {
    return toDateStr(at, tz)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

export function selectAssignedWork(
  body: unknown,
  opts: { includeFinished?: boolean } = {}
): { fetchedAt?: unknown; userTimezone?: unknown; assigned: AssignedItem[] } {
  const root = (body ?? {}) as {
    items?: unknown
    fetchedAt?: unknown
    userTimezone?: unknown
    routines?: unknown
    seasons?: unknown
  }
  const items = Array.isArray(root.items) ? root.items : []

  // "Does this still want doing" has exactly one definition in this app
  // (lib/active.ts), and re-deriving it from aiStatus alone would hand a worker
  // things the user has since completed, cancelled, or paused for the season —
  // the app arguing with a decision the user already made, which is the failure
  // this rule exists to prevent.
  const today = queueDayFrom(root)
  const typed = items.filter((raw): raw is Item => !!raw && typeof raw === 'object')
  const inactive = today
    ? inactiveIdsFrom(typed, today, root)
    : new Set<string>()

  const assigned = items
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object')
    .filter((item) => typeof item.assignee === 'string' && item.assignee !== '')
    // The registry is the single answer to "may this be delegated" — the same
    // one the Assign button asks. Server-side, an unhydrated custom slug falls
    // back to the default template, which says no, which is the correct answer
    // while the agent write API cannot address custom types.
    .filter((item) => {
      const name = item.type === 'custom' ? String(item.customType ?? '') : String(item.type ?? '')
      return name !== '' && getItemTypeConfig(name).agentAssignable
    })
    .filter((item) => {
      if (opts.includeFinished) return true
      // Default to open work only: a worker waking on a schedule wants its
      // queue, not a history of everything it has ever finished.
      const status = typeof item.aiStatus === 'string' ? item.aiStatus : 'queued'
      if (!OPEN_AI_STATUSES.has(status)) return false
      if (!today) return true
      const asItem = item as unknown as Item
      return isOpenLoopOn(asItem, today) && !inactive.has(String(item.id))
    })
    .map((item) => {
      const picked: AssignedItem = {
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        type: String(item.customType ?? item.type ?? 'task'),
      }
      // Enough for the worker to act without a second round-trip: when it is
      // due, how urgent, and whatever the user wrote down. Deliberately NOT the
      // whole row — the point of this tool is to be small.
      for (const key of [
        'assignee', 'aiStatus', 'aiResult', 'aiStatusAt', 'status',
        'startDate', 'startTime', 'timeBucket', 'priority', 'notes',
      ] as const) {
        if (typeof item[key] === 'string') picked[key] = item[key] as string
      }
      return picked
    })

  return { fetchedAt: root.fetchedAt, userTimezone: root.userTimezone, assigned }
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'dsul_my_work',
    description:
      'The list of items the user has handed to you, and the ONLY thing you need to poll. ' +
      'Returns just the assigned items rather than the whole planner. Each one carries an ' +
      "aiStatus: 'queued' means nobody has started it, 'working' means someone has, " +
      "'blocked' means it is waiting on an answer from the user. " +
      'The loop is: take a queued item, mark it working so a second run does not double it, ' +
      'do the work, then report with dsul_report_progress. An item already sitting at ' +
      "'blocked' may have been answered, so read dsul_item_activity before assuming it is " +
      'still stuck. ' +
      "An item at 'working' belongs to a run that is probably still going: LEAVE IT ALONE. " +
      'Its aiStatusAt is when that status was last written, not a heartbeat, so an ' +
      'old stamp on a long job is normal and proves nothing. ' +
      `Only if the stamp is more than ${QUIET_HOURS} hours older than this response's fetchedAt AND the ` +
      'item is assigned to you may you treat that run as gone. Even then, take it by calling ' +
      "dsul_report_progress with 'working' FIRST and continuing only if that call succeeds. " +
      'It refuses when someone else has touched the item, which is what stops two of you ' +
      'working the same task and overwriting each other. ' +
      'Never touch an item assigned to someone else. ' +
      'If nothing comes back, there is nothing to do. Stop, and do not go looking ' +
      'for work in the rest of the planner.',
    inputSchema: obj({
      includeFinished: {
        type: 'boolean',
        description: 'Also return done and failed items. Off by default, since you usually want your queue rather than your history.',
      },
    }),
    plan: (args) => ({
      method: 'GET',
      path: '/api/agent/context',
      transform: (body) => selectAssignedWork(body, { includeFinished: args.includeFinished === true }),
    }),
  },
  {
    name: 'dsul_item_activity',
    description:
      'The history of one item: status changes, edits, and (the reason you are here) any ' +
      "answer the user has written back to you. After you mark something 'blocked' with a " +
      'question, this is where their reply appears, as an `agent_reply` entry. Check it when ' +
      'you pick up an item that is already in flight, so you continue rather than start over.',
    inputSchema: obj({ id: ID }, ['id']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'GET', path: `/api/agent/items/${id}/events` }
    },
  },
  {
    name: 'dsul_ask_user',
    description:
      'Ask the user a question you are stuck on, offering answers they can tap. ' +
      'Use this INSTEAD of dsul_report_progress when the answer is a choice: which ' +
      'person, which of two files, is that date still fine. It blocks the item and posts ' +
      'the question in one call, so there is no half-done state. ' +
      'Prefer it: most questions that stop delegated work are choices, and a tap gets you ' +
      'an answer far sooner than a box someone has to compose a sentence into. ' +
      'Offer options ONLY when they are genuinely exhaustive. A question whose real answer ' +
      'is not on the list is worse than no options at all. Omit them for anything open-ended ' +
      '(the user always keeps a free-text box either way). ' +
      'The answer comes back through dsul_item_activity as an `agent_reply` entry, and the ' +
      'item returns to your queue by itself.',
    inputSchema: obj(
      {
        id: ID,
        question: str('What you need to know, written for a human. This is all they see.'),
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Two to four short answers to offer as buttons. Each is sent back verbatim as ' +
            'the reply, so write them as the ANSWER ("Dana Reyes"), not as a label ' +
            '("the first one"). Omit for an open question.',
        },
      },
      ['id', 'question']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const question = requireString(args, 'question')
      if (typeof question !== 'string') return question

      // Filtered here as well as at the route: a tool that silently passes
      // rubbish through and lets the route drop it teaches the model nothing.
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        : []

      return {
        method: 'POST',
        path: `/api/agent/items/${id}/ask`,
        body: { question, ...(options.length > 0 ? { options } : {}) },
      }
    },
  },
  {
    name: 'dsul_report_progress',
    description:
      'Say where you have got to on an item assigned to you. Call it when you START ' +
      "(status 'working'), when you FINISH (status 'done', with the outcome in result), and " +
      "when you are STUCK (status 'blocked', with the question you need answered in result; " +
      'the user sees that text and it is the only way to ask them something). ' +
      'The result text is shown to a human on the item, so write it for them: what you did, ' +
      'what you found, what you need. Not a log line. ' +
      'ALSO call it periodically on anything long, at least every ' +
      `${QUIET_HOURS} hour(s), status 'working', with a line about where you are. ` +
      'That is the only thing that tells the user you are alive: the item shows how long it ' +
      'has been since your last report, and silence past that point is what makes them think ' +
      'the run died and start it again. ' +
      'Pass lastSeenAt with the aiStatusAt you last read for the item. The call is REFUSED ' +
      'if it no longer matches. That means the user or another run changed the item while you ' +
      'were working, and your report would have overwritten theirs. Re-read it with ' +
      'dsul_my_work and decide again rather than retrying blindly.',
    inputSchema: obj(
      {
        id: ID,
        status: {
          type: 'string',
          enum: [...AI_STATUSES],
          description: "Where the work stands now.",
        },
        result: str('What to show the user: the outcome, the finding, or the question you are stuck on.'),
        lastSeenAt: str(
          "The aiStatusAt you last read for this item, from dsul_my_work. The write is " +
            'refused if it no longer matches, which is what stops your report overwriting ' +
            'one from a run that took over while you were working. Omit only for the very ' +
            'first report on an item that had no status yet.'
        ),
      },
      ['id', 'status']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const status = requireString(args, 'status')
      if (typeof status !== 'string') return status
      if (!(AI_STATUSES as readonly string[]).includes(status)) {
        return { error: `status must be one of: ${AI_STATUSES.join(', ')}` }
      }
      return {
        // Its own route, not the generic task PATCH, for the reason the `ask`
        // route gives: the delegation verbs need a precondition and an
        // assignee check that must not be bolted onto every agent write.
        method: 'POST',
        path: `/api/agent/items/${id}/progress`,
        body: {
          aiStatus: status,
          ...(typeof args.result === 'string' ? { aiResult: args.result } : {}),
          ...(typeof args.lastSeenAt === 'string' ? { lastSeenAt: args.lastSeenAt } : {}),
        },
      }
    },
  },
  {
    name: 'dsul_get_context',
    description:
      "Read the user's whole planner: today's tasks, habits and streaks, projects, " +
      'routines, seasons and goals, plus their timezone. Call this before any write: ' +
      'ids come from here, and answering from memory is how a stale plan gets acted on. ' +
      'Note tasks[] and habits[] omit work that is paused or out of season; items[] does not.',
    inputSchema: obj({}),
    plan: () => ({ method: 'GET', path: '/api/agent/context' }),
  },
  {
    name: 'dsul_create_task',
    description:
      'Create a task. Use the project NAME, not an id, and create a new project with ' +
      'dsul_create_project first: a name with no project behind it files the task loose. ' +
      'Omit startDate to leave it in the Braindump rather than guessing a day for it. ' +
      'Give repeatFrequency only for a chore that repeats (practice with a streak is a habit), ' +
      'and give it a startDate: a repeating task with no start never comes round.',
    inputSchema: obj(
      {
        title: str('What the task is, in the user\'s own words where possible.'),
        startDate: DATE,
        startTime: TIME,
        timeBucket: TIME_BUCKET,
        priority: PRIORITY,
        project: str('Project NAME, e.g. "Work". Not an id.'),
        notes: str('Longer detail that does not belong in the title.'),
        duration: DURATION,
        parentItemId: str('Make this a subtask of that item. Subtasks cannot nest.'),
        repeatFrequency: REPEAT_FREQUENCY,
        repeatDays: REPEAT_DAYS,
        repeatMonthDay: REPEAT_MONTH_DAY,
        reminderTime: REMINDER_TIME,
      },
      ['title']
    ),
    plan: (args) => {
      const title = requireString(args, 'title')
      if (typeof title !== 'string') return title
      // Tasks are date-anchored: a series with no start has no occurrences, so
      // it would sit in the Braindump and never come round, behind a 201.
      const repeats = args.repeatFrequency !== undefined && args.repeatFrequency !== 'none'
      if (repeats && (typeof args.startDate !== 'string' || args.startDate === '')) {
        return { error: 'A repeating task needs a startDate (its first day), or it never comes round.' }
      }
      return { method: 'POST', path: '/api/agent/tasks', body: pick(args, TASK_WRITE_KEYS) }
    },
  },
  {
    name: 'dsul_update_task',
    description:
      'Change an existing task. Send only the fields you are changing. To tick a task off, ' +
      'use dsul_complete: on a RECURRING task status would end the whole series rather than ' +
      'today, and completedDates replaces every completed date at once.',
    inputSchema: obj(
      {
        id: ID,
        title: str('New title.'),
        status: { type: 'string', enum: ['pending', 'completed', 'cancelled'] },
        startDate: DATE,
        startTime: TIME,
        timeBucket: TIME_BUCKET,
        priority: PRIORITY,
        project: str('Project NAME, e.g. "Work". Not an id.'),
        notes: str('Longer detail.'),
        duration: DURATION,
        repeatFrequency: REPEAT_FREQUENCY,
        repeatDays: REPEAT_DAYS,
        repeatMonthDay: REPEAT_MONTH_DAY,
        reminderTime: REMINDER_TIME,
        completedDates: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For recurring tasks: EVERY yyyy-MM-dd date completed, as a whole-set replacement that ' +
            'un-ticks any date left out. To tick or untick one day use dsul_complete instead.',
        },
      },
      ['id']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'PATCH', path: `/api/agent/tasks/${id}`, body: pick(args, TASK_WRITE_KEYS) }
    },
  },
  {
    name: 'dsul_delete_task',
    description:
      'Delete a task. It goes to trash for 30 days. Deleting a task deletes its subtasks ' +
      'too. Prefer cancelling over deleting when the user simply changed their mind.',
    inputSchema: obj({ id: ID }, ['id']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'DELETE', path: `/api/agent/tasks/${id}` }
    },
  },
  {
    name: 'dsul_create_habit',
    description:
      'Create a recurring habit. Its group is a project NAME (the same projects tasks use; ' +
      'create a new one with dsul_create_project first). A habit repeats by ' +
      "definition, so there is no 'none' frequency. Use custom with repeatDays for " +
      'specific weekdays (0 = Sunday).',
    inputSchema: obj(
      {
        title: str('What the habit is.'),
        group: str('Project NAME, e.g. "Health". Not an id. It must already exist.'),
        repeatFrequency: {
          type: 'string',
          enum: ['daily', 'weekdays', 'weekends', 'monthly', 'custom'],
        },
        repeatDays: {
          type: 'array',
          items: { type: 'number' },
          description: 'Required when repeatFrequency is custom. 0 = Sunday … 6 = Saturday.',
        },
        repeatMonthDay: REPEAT_MONTH_DAY,
        timeBucket: TIME_BUCKET,
        startTime: TIME,
        timesPerDay: { type: 'number', description: 'For counted habits, e.g. 3 glasses of water.' },
        duration: DURATION,
        reminderTime: REMINDER_TIME,
        notes: str('Longer detail.'),
      },
      ['title']
    ),
    plan: (args) => {
      const title = requireString(args, 'title')
      if (typeof title !== 'string') return title
      return { method: 'POST', path: '/api/agent/habits', body: pick(args, HABIT_WRITE_KEYS) }
    },
  },
  {
    name: 'dsul_update_habit',
    description:
      'Change an existing habit. To mark it done or skipped for a day use dsul_complete or ' +
      'dsul_skip, never this: habits are not completed by status, and completedDates and ' +
      'skippedDates here are whole-set replacements that undo every date left out.',
    inputSchema: obj(
      {
        id: ID,
        title: str('New title.'),
        group: str('Project NAME. Not an id. It must already exist.'),
        repeatFrequency: {
          type: 'string',
          enum: ['daily', 'weekdays', 'weekends', 'monthly', 'custom'],
        },
        repeatDays: { type: 'array', items: { type: 'number' } },
        repeatMonthDay: REPEAT_MONTH_DAY,
        timeBucket: TIME_BUCKET,
        startTime: TIME,
        timesPerDay: { type: 'number' },
        completedDates: { type: 'array', items: { type: 'string' }, description: 'EVERY yyyy-MM-dd date done (whole set). Prefer dsul_complete.' },
        skippedDates: { type: 'array', items: { type: 'string' }, description: 'EVERY yyyy-MM-dd date skipped (whole set). Prefer dsul_skip.' },
        duration: DURATION,
        reminderTime: REMINDER_TIME,
        notes: str('Longer detail.'),
      },
      ['id']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'PATCH', path: `/api/agent/habits/${id}`, body: pick(args, HABIT_WRITE_KEYS) }
    },
  },
  {
    name: 'dsul_delete_habit',
    description:
      'Delete a habit and its whole streak history. Goes to trash for 30 days. Almost ' +
      'always the wrong verb: if the user is just stepping away from it, pause it instead ' +
      'so the history survives and it comes back on its own.',
    inputSchema: obj({ id: ID }, ['id']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'DELETE', path: `/api/agent/habits/${id}` }
    },
  },
  {
    name: 'dsul_pause',
    description:
      'Put something down for a while, or pick it back up. Pausing HIDES the item ' +
      'without ending it and without touching its history. It is the right verb when a user ' +
      'is away or has set something aside, and much better than deleting. `until` is the ' +
      'date it becomes live again (exclusive), so pass tomorrow for "just today".',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['task', 'habit', 'routine'] },
        id: ID,
        paused: { type: 'boolean', description: 'true to pause, false to resume.' },
        until: str('yyyy-MM-dd it becomes live again. Only valid when pausing.'),
      },
      ['kind', 'id', 'paused']
    ),
    plan: (args) => {
      const kind = requireString(args, 'kind')
      if (typeof kind !== 'string') return kind
      const segment = PAUSE_PATHS[kind]
      if (!segment) return { error: `kind must be one of: ${Object.keys(PAUSE_PATHS).join(', ')}` }
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      if (typeof args.paused !== 'boolean') return { error: 'paused must be a boolean' }
      if (args.until !== undefined && args.paused === false) {
        return { error: 'until is only valid when pausing. Resume takes no date.' }
      }
      return {
        method: 'PATCH',
        path: `/api/agent/${segment}/${id}`,
        body: {
          paused: args.paused,
          ...(args.until !== undefined ? { pausedUntil: args.until } : {}),
        },
      }
    },
  },
  {
    name: 'dsul_complete',
    description:
      'Tick an item off for ONE day, or untick it (done: false). The right verb for a task or a ' +
      'habit, one-off or recurring: it touches only that date, moves a habit\'s streak and keeps ' +
      'the rest of the history. A day the user skipped is refused (skipped); unskip it with ' +
      'dsul_skip first. For a habit with a daily target, count is how many it reached that day.',
    inputSchema: obj(
      {
        id: ID,
        date: ONE_DAY,
        done: { type: 'boolean', description: 'true ticks it (the default), false unticks it.' },
        count: { type: 'number', description: 'Habits with a daily target only: the tally for that day.' },
      },
      ['id', 'date']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      if (!isDateStr(args.date)) return { error: 'date is required as yyyy-MM-dd' }
      if (args.done !== undefined && typeof args.done !== 'boolean') return { error: 'done must be a boolean' }
      return {
        method: 'POST',
        path: actPath(id),
        body: {
          action: 'complete',
          date: args.date,
          done: args.done ?? true,
          ...(args.count !== undefined ? { count: args.count } : {}),
        },
      }
    },
  },
  {
    name: 'dsul_skip',
    description:
      'Skip ONE occurrence of a recurring task or habit (it is not done, and was meant not to be), ' +
      'or unskip it (skipped: false). Skipping a day that was ticked unticks it. One-off items ' +
      'and subtasks cannot be skipped (not_skippable): ' +
      'move, cancel or pause them instead.',
    inputSchema: obj(
      {
        id: ID,
        date: ONE_DAY,
        skipped: { type: 'boolean', description: 'true skips the day (the default), false unskips it.' },
      },
      ['id', 'date']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      if (!isDateStr(args.date)) return { error: 'date is required as yyyy-MM-dd' }
      if (args.skipped !== undefined && typeof args.skipped !== 'boolean') {
        return { error: 'skipped must be a boolean' }
      }
      return {
        method: 'POST',
        path: actPath(id),
        body: { action: 'skip', date: args.date, skipped: args.skipped ?? true },
      }
    },
  },
  {
    name: 'dsul_move',
    description:
      'Carry a task to another day, as the app\'s Tomorrow and Reschedule do. It keeps its time; ' +
      'an undated task lands in that day\'s Anytime. On a recurring task the day becomes the ' +
      'series\' first day. Refused (not_movable) for a habit, a subtask, a finished task or one ' +
      'parked inside a project block.',
    inputSchema: obj({ id: ID, date: str('The day to move it to, yyyy-MM-dd.') }, ['id', 'date']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      if (!isDateStr(args.date)) return { error: 'date is required as yyyy-MM-dd' }
      return { method: 'POST', path: actPath(id), body: { action: 'move', date: args.date } }
    },
  },
  {
    name: 'dsul_reset_streak',
    description:
      'Set a habit\'s streak back to 0. Its completion history is kept. Only when the user asks ' +
      'for it: a streak is theirs, and it is never recomputed from the history.',
    inputSchema: obj({ id: ID }, ['id']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'POST', path: actPath(id), body: { action: 'resetStreak' } }
    },
  },
  {
    name: 'dsul_set_membership',
    description:
      'Add ONE item to a routine or season, or take it out (member: false), leaving every other ' +
      'member as it is. An item added to a routine goes last in its order. Prefer this to ' +
      'dsul_update_collection\'s itemIds, which replaces the whole list. Goals take their ' +
      'members through dsul_update_collection.',
    inputSchema: obj(
      {
        id: ID,
        kind: { type: 'string', enum: ['routine', 'season'] },
        collectionId: str('The routine or season id, exactly as it appears in get_context.'),
        member: { type: 'boolean', description: 'true adds it (the default), false takes it out.' },
      },
      ['id', 'kind', 'collectionId']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      if (args.kind !== 'routine' && args.kind !== 'season') return { error: 'kind must be routine or season' }
      const collectionId = requireString(args, 'collectionId')
      if (typeof collectionId !== 'string') return collectionId
      if (args.member !== undefined && typeof args.member !== 'boolean') {
        return { error: 'member must be a boolean' }
      }
      return {
        method: 'POST',
        path: actPath(id),
        body: { action: 'collect', kind: args.kind, containerId: collectionId, member: args.member ?? true },
      }
    },
  },
  {
    name: 'dsul_create_project',
    description:
      'Create a project, the one group each task and habit files under (by NAME). ' +
      'Check get_context first: names fold case, so "work" IS an existing "Work", and ' +
      'creating it again is refused with the existing project in the response.',
    inputSchema: obj(
      {
        name: str('What to call it, e.g. "YouTube".'),
        emoji: str('An icon token like "icon:Sparkles". Omit for no icon.'),
        color: str('A colour token.'),
        notes: str('What the project is for, or standing rules that apply to all of it.'),
      },
      ['name']
    ),
    plan: (args) => {
      const name = requireString(args, 'name')
      if (typeof name !== 'string') return name
      return { method: 'POST', path: '/api/agent/projects', body: pick(args, PROJECT_WRITE_KEYS) }
    },
  },
  {
    name: 'dsul_update_project',
    description:
      'Rename a project or change its icon, colour or notes. A rename carries every task ' +
      'and habit in it along, so never re-file items by hand to rename one.',
    inputSchema: obj(
      {
        id: str('The project id, exactly as it appears in get_context.'),
        name: str('New name.'),
        emoji: str('An icon token like "icon:Sparkles".'),
        color: str('A colour token.'),
        notes: str('New notes. Whole-text replacement.'),
      },
      ['id']
    ),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const body = pick(args, PROJECT_WRITE_KEYS)
      if (Object.keys(body).length === 0) return { error: 'Send at least one of: name, emoji, color, notes.' }
      if ('name' in body && (typeof body.name !== 'string' || body.name.trim() === '')) {
        return { error: 'name must be a non-empty string' }
      }
      return { method: 'PATCH', path: `/api/agent/projects/${id}`, body }
    },
  },
  {
    name: 'dsul_delete_project',
    description:
      'Delete a project. It goes to trash for 30 days and keeps its name taken until then. Its ' +
      'tasks and habits are NOT deleted. Only when the user asks: to rename one, use ' +
      'dsul_update_project, which carries every item along.',
    inputSchema: obj({ id: str('The project id, exactly as it appears in get_context.') }, ['id']),
    plan: (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'DELETE', path: `/api/agent/projects/${id}` }
    },
  },
  {
    name: 'dsul_create_collection',
    description:
      'Create a routine (things done regularly, together and in order, such as a morning or a ' +
      'workout week, which pause as one), a season (a stretch of life, optionally dated, ' +
      'holding items and routines that show only while it is on), or a goal (something ' +
      'being worked towards, whose members can be milestones or check-ins). Membership ' +
      'arrays are whole sets, not additions; a routine\'s itemIds are in the order they are done.',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['routine', 'season', 'goal'] },
        name: str('What to call it.'),
        icon: str('An icon token like "icon:Sparkles".'),
        color: str('A colour token.'),
        itemIds: { type: 'array', items: { type: 'string' }, description: 'Routines and seasons only.' },
        usualTime: str('Routines only: when it usually happens, 24-hour HH:mm. It is only a label; members keep their own times.'),
        routineIds: { type: 'array', items: { type: 'string' }, description: 'Seasons only.' },
        state: { type: 'string', description: 'Seasons: auto|active|paused. Goals: active|achieved|abandoned.' },
        startsOn: DATE,
        endsOn: { ...DATE, description: 'Seasons only. yyyy-MM-dd the season ends.' },
        why: str('Goals only: why this matters to the user, in their words.'),
        targetOn: { ...DATE, description: 'Goals only: the date being aimed at.' },
        memberIds: { type: 'array', items: { type: 'string' }, description: 'Goals only: supporting work.' },
        milestoneIds: { type: 'array', items: { type: 'string' }, description: 'Goals only: dated one-off items that mark progress.' },
        checkinIds: { type: 'array', items: { type: 'string' }, description: 'Goals only: recurring items that keep it alive.' },
      },
      ['kind', 'name']
    ),
    plan: (args) => planCollection(args, 'POST'),
  },
  {
    name: 'dsul_update_collection',
    description:
      'Change a routine, season or goal. Membership arrays REPLACE the whole set, so ' +
      'read the current members from get_context and send the full list, or you will ' +
      'remove everything you left out.',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['routine', 'season', 'goal'] },
        id: ID,
        name: str('New name.'),
        icon: str('An icon token like "icon:Sparkles".'),
        color: str('A colour token.'),
        itemIds: { type: 'array', items: { type: 'string' } },
        usualTime: str('Routines only: when it usually happens, HH:mm. Send null to clear it.'),
        routineIds: { type: 'array', items: { type: 'string' } },
        state: { type: 'string' },
        startsOn: DATE,
        endsOn: DATE,
        why: str('Goals only.'),
        targetOn: DATE,
        memberIds: { type: 'array', items: { type: 'string' } },
        milestoneIds: { type: 'array', items: { type: 'string' } },
        checkinIds: { type: 'array', items: { type: 'string' } },
        paused: { type: 'boolean', description: 'Routines only. Seasons use state.' },
        pausedUntil: DATE,
      },
      ['kind', 'id']
    ),
    plan: (args) => planCollection(args, 'PATCH'),
  },
  {
    name: 'dsul_delete_collection',
    description:
      'Delete a routine, season or goal. Its member items are NOT deleted. They ' +
      'stop belonging to it.',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['routine', 'season', 'goal'] },
        id: ID,
      },
      ['kind', 'id']
    ),
    plan: (args) => {
      const kind = requireString(args, 'kind')
      if (typeof kind !== 'string') return kind
      const segment = COLLECTION_PATHS[kind]
      if (!segment) return { error: `kind must be one of: ${Object.keys(COLLECTION_PATHS).join(', ')}` }
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      return { method: 'DELETE', path: `/api/agent/${segment}/${id}` }
    },
  },
]

export const toolByName = (name: string): McpTool | undefined =>
  MCP_TOOLS.find((t) => t.name === name)

/** The descriptor half, which is all `tools/list` may expose. */
export const TOOL_DESCRIPTORS: McpToolDescriptor[] = MCP_TOOLS.map(
  ({ name, description, inputSchema }) => ({ name, description, inputSchema })
)
