import { NextRequest, NextResponse } from 'next/server'
import type { ZodType } from 'zod'
import {
  TaskCreateSchema,
  HabitCreateSchema,
  TaskUpdateSchema,
  HabitUpdateSchema,
  RoutineCreateSchema,
  RoutineUpdateSchema,
  SeasonCreateSchema,
  SeasonUpdateSchema,
  GoalCreateSchema,
  GoalUpdateSchema,
} from '@dsul/types'
import { createServiceClient, resolveUserIdFromApiKey } from './supabase-service'
import {
  createTask,
  createHabit,
  updateTask,
  updateHabit,
  deleteTask,
  deleteHabit,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  createSeason,
  updateSeason,
  deleteSeason,
  createGoal,
  updateGoal,
  deleteGoal,
  verifyItemOwnership,
  validateParentItemId,
} from './db'
import { resolvePauseWrite, type Pausable } from './active'
import { capabilityShape, isPausableRow, resolveItemPause } from './item-pause'
import {
  isCheckinEligible,
  isCollectible,
  isMilestoneEligible,
} from './item-registry'
import { toDateStr } from './recurrence'
import { resolveGoalStateWrite } from './goals'
import { demoteInvalidGoalRoles, roleShape, type RoleRow } from './goal-roles'
import type {
  Goal,
  GoalRole,
  Habit,
  KnownItemType,
  Season,
  Routine,
  Task,
} from './planner-types'

/**
 * Shared machinery for the /api/agent/tasks|habits routes. The route files are
 * thin facades over one handler set parameterized by ItemType; write bodies
 * are Zod-validated at the boundary so bad payloads get a 400 instead of
 * surfacing as Postgres CHECK-constraint 500s.
 *
 * Server-only: keep the Zod schemas out of lib/item-registry.ts so the client
 * bundle doesn't pay for them — this map is the registry's server-side API
 * extension.
 */

type DbClient = ReturnType<typeof createServiceClient>

interface AgentApiConfig {
  /** JSON key the POST response nests the created entity under. */
  payloadKey: 'task' | 'habit'
  createSchema: ZodType
  updateSchema: ZodType
  /**
   * Seeded under the body on create, matching the legacy routes' entity
   * construction and 201 echo. Load-bearing for habits: items.streak has no
   * column default, and the set_item_completion RPC only moves streak when it
   * is non-NULL (the guard that skips tasks) — a habit created without
   * streak: 0 would never accrue one.
   */
  createDefaults: Record<string, unknown>
  create: (userId: string, entity: never, client: DbClient) => Promise<void>
  update: (id: string, updates: never, userId: string, client: DbClient) => Promise<void>
  remove: (id: string, userId: string, client: DbClient) => Promise<void>
}

// Built-ins only: custom types are not exposed through the agent write API in
// v1 (items[] on the context endpoint serves reads).
const AGENT_API: Record<KnownItemType, AgentApiConfig> = {
  task: {
    payloadKey: 'task',
    createSchema: TaskCreateSchema,
    updateSchema: TaskUpdateSchema,
    createDefaults: {},
    create: (userId, entity, client) => createTask(userId, entity as Task, client),
    update: (id, updates, userId, client) =>
      updateTask(id, updates as Partial<Task>, userId, client),
    remove: (id, userId, client) => deleteTask(id, userId, client),
  },
  habit: {
    payloadKey: 'habit',
    createSchema: HabitCreateSchema,
    updateSchema: HabitUpdateSchema,
    createDefaults: { streak: 0, completedDates: [], skippedDates: [], dailyCounts: {} },
    create: (userId, entity, client) => createHabit(userId, entity as Habit, client),
    update: (id, updates, userId, client) =>
      updateHabit(id, updates as Partial<Habit>, userId, client),
    remove: (id, userId, client) => deleteHabit(id, userId, client),
  },
}

interface AgentAuth {
  userId: string
  serviceClient: DbClient
}

/** Bearer openclaw_api_key auth. Returns a 401 response when it fails. */
async function authenticateAgent(req: NextRequest): Promise<AgentAuth | NextResponse> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const serviceClient = createServiceClient()
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7), serviceClient)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return { userId, serviceClient }
}

/** Parse + validate a JSON body. Returns a 400 response on failure. */
async function parseBody(
  req: NextRequest,
  schema: ZodType
): Promise<{ data: Record<string, unknown> } | NextResponse> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  return { data: parsed.data as Record<string, unknown> }
}

const errorResponse = (err: unknown) => {
  const msg = err instanceof Error ? err.message : 'Internal server error'
  return NextResponse.json({ error: msg }, { status: 500 })
}

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })

// ── Pause, membership, and the guards Postgres cannot state ───────────────────

/**
 * The user's zone, which is the frame the pause interval is resolved in.
 *
 * UTC fallback matches the context route: it is the same read, and a pause
 * resolved a few hours off is far better than a 500 on a write the agent has
 * no way to retry into success.
 */
async function userTimezone(client: DbClient, userId: string): Promise<string> {
  const { data } = await client
    .from('user_settings')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.timezone as string | undefined) ?? 'UTC'
}

// capabilityShape — a raw row wearing an Item's shape for the registry's
// predicates — lives in lib/item-pause.ts, beside the pause gate the iPhone
// app's route shares with pausePatchForItem below.

interface MemberRow {
  id: string
  type: string
  parent_item_id: string | null
}

/**
 * Every id in a membership array must be one of this user's items, and one the
 * registry says may join a collection.
 *
 * Checked here rather than left to the database because the two failure modes
 * are both silent otherwise. The composite (id, user_id) foreign keys reject a
 * cross-user id — but reconcileMembership deliberately SWALLOWS 23503 per row
 * (an undo replaying a snapshot whose member left the trash meanwhile must not
 * fail wholesale), so an agent's typo would return 200 having stored nothing.
 * And the subtask rule (plan decision 7) is not expressible as a constraint at
 * all: a subtask surfaces only inside its parent, so collecting one produces
 * membership the user can neither see nor undo.
 *
 * "Exists" deliberately INCLUDES trashed items. Join rows outlive an item's
 * soft delete by design so a restore inside the 30-day window brings membership
 * back intact, and fetchRoutines/fetchSeasons read the join tables unfiltered
 * — so /api/agent/context publishes those ids. Filtering them here made the API
 * refuse an array it had just handed out: the documented read-modify-write
 * ("read the current members, send the full list") 400'd, and so did an
 * identity write. Ownership is enforced by the user_id filter, not by
 * deleted_at, and a purged or foreign id is still absent and still rejected.
 */
async function validateItemMembers(
  client: DbClient,
  userId: string,
  ids: string[],
): Promise<string | null> {
  if (ids.length === 0) return null
  const unique = [...new Set(ids)]
  const { data, error } = await client
    .from('items')
    .select('id, type, parent_item_id')
    .eq('user_id', userId)
    .in('id', unique)
  if (error) throw error

  const rows = (data ?? []) as MemberRow[]
  const found = new Set(rows.map((r) => r.id))
  const missing = unique.filter((id) => !found.has(id))
  if (missing.length > 0) {
    return `itemIds reference items that do not exist: ${missing.join(', ')}`
  }
  const uncollectible = rows.filter((r) => !isCollectible(capabilityShape(r)))
  if (uncollectible.length > 0) {
    return (
      `itemIds reference items that cannot join a collection: ` +
      `${uncollectible.map((r) => r.id).join(', ')} ` +
      `(subtasks belong to their parent and follow its state)`
    )
  }
  return null
}

/**
 * Same contract for a season's routineIds — trashed included, for the same
 * reason. Routines have no subtask analog, so existence is the whole check.
 */
async function validateRoutineMembers(
  client: DbClient,
  userId: string,
  ids: string[],
): Promise<string | null> {
  if (ids.length === 0) return null
  const unique = [...new Set(ids)]
  const { data, error } = await client
    .from('routines')
    .select('id')
    .eq('user_id', userId)
    .in('id', unique)
  if (error) throw error
  const found = new Set(((data ?? []) as { id: string }[]).map((r) => r.id))
  const missing = unique.filter((id) => !found.has(id))
  return missing.length > 0
    ? `routineIds reference routines that do not exist: ${missing.join(', ')}`
    : null
}

/**
 * Membership arrays are whole-set replacements, so anything absent is removed.
 * Add back the members that are absent only because the caller could not SEE
 * them.
 *
 * The plan's dangling-id rule is explicit: "member arrays may reference trashed
 * items … arrays are pruned only by the purge CASCADE, never eagerly." The UI
 * honours it for free — ItemMemberList edits the raw stored array, so a trashed
 * member's id rides along untouched. An agent cannot: `items[]` on the wire is
 * `deleted_at`-filtered, so a model rebuilding the list from what it can see
 * omits the trashed id, reconcileMembership computes it as removed, and DELETEs
 * the join row. Restoring the item then returns it as a NON-member, silently,
 * and the restore-brings-membership-back guarantee is gone.
 *
 * Applied only at the agent boundary, not inside reconcileMembership: the agent
 * is the one caller that cannot see these ids, and the db layer's other callers
 * would pay two queries per membership write for a case they cannot hit.
 *
 * The cost is that an agent cannot REMOVE a trashed member. Neither can the UI
 * (the picker does not render them), and the purge clears them at 30 days.
 */
export function withTrashedMembersKept(
  desired: string[],
  current: string[],
  liveIds: ReadonlySet<string>,
): string[] {
  const asked = new Set(desired)
  const trashed = current.filter((id) => !asked.has(id) && !liveIds.has(id))
  return trashed.length === 0 ? desired : [...desired, ...trashed]
}

interface JoinTable {
  table: string
  ownerCol: string
  memberCol: string
  /** Where the member itself lives, so liveness can be resolved. */
  memberTable: 'items' | 'routines'
}

/**
 * Gather what {@link withTrashedMembersKept} needs, then apply it.
 *
 * `role` narrows the "current" set for a goal: each of the three arrays is
 * replaced independently, so the ids a `milestoneIds` patch may be silently
 * dropping are the goal's currently-trashed MILESTONES, not its members. Read
 * unscoped, a trashed member would be re-added as a milestone by a patch that
 * never mentioned it.
 */
async function keepTrashedMembers(
  client: DbClient,
  userId: string,
  join: JoinTable,
  ownerId: string,
  desired: string[],
  role?: GoalRole,
  claimedElsewhere?: ReadonlySet<string>,
): Promise<string[]> {
  let query = client
    .from(join.table)
    .select(join.memberCol)
    .eq(join.ownerCol, ownerId)
    .eq('user_id', userId)
  if (role) query = query.eq('role', role)
  const { data, error } = await query
  if (error) throw error
  // `unknown` first: the column name is dynamic, so the client cannot infer a
  // row shape and types the select as its error branch.
  const current = ((data ?? []) as unknown as Record<string, string>[]).map(
    (r) => r[join.memberCol],
  )

  const asked = new Set(desired)
  const candidates = current.filter(
    // An id the SAME body hands to another role array is being MOVED, not
    // dropped — re-adding it here would put it in two arrays at once, which
    // goalMemberRows refuses outright. See keepTrashedGoalMembers.
    (id) => !asked.has(id) && !claimedElsewhere?.has(id),
  )
  // Nothing is being dropped, so nothing can be dropped WRONGLY — skip the
  // liveness read entirely on the common path (an add, or an unchanged set).
  if (candidates.length === 0) return desired

  const { data: live, error: liveError } = await client
    .from(join.memberTable)
    .select('id')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .in('id', candidates)
  if (liveError) throw liveError
  const liveIds = new Set(((live ?? []) as { id: string }[]).map((r) => r.id))
  // `candidates`, not `current`: the exclusion above has already removed the
  // ids this body is moving to another role, and withTrashedMembersKept would
  // otherwise re-derive them straight back in.
  return withTrashedMembersKept(desired, candidates, liveIds)
}

/**
 * Translate `paused` / `pausedUntil` into the columns, for an item.
 *
 * The verb is resolved against the row's CURRENT state (resolvePauseWrite needs
 * it to leave `pausedAt` alone when a pause is already running), so this costs
 * one read — taken only when the body actually carries the verb.
 */
async function pausePatchForItem(
  client: DbClient,
  userId: string,
  id: string,
  req: { paused?: boolean; pausedUntil?: string | null },
): Promise<{ patch: Pausable } | { error: string }> {
  const { data, error } = await client
    .from('items')
    .select('type, parent_item_id, paused_at, paused_until')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  if (!data) return { error: 'Not found' }

  const row = data as MemberRow & { paused_at: string | null; paused_until: string | null }
  if (!isPausableRow(row)) {
    return {
      error:
        'this item cannot be paused. Subtasks surface only inside their parent ' +
        'and follow its state',
    }
  }

  // The resolution is shared with the iPhone app's `pause` intent
  // (lib/item-pause.ts); only the reads around it are this door's own.
  const tz = await userTimezone(client, userId)
  const resolved = resolveItemPause(row, req, tz, new Date())
  return 'reason' in resolved ? { error: resolved.reason } : { patch: resolved.patch }
}

/** POST /api/agent/<plural> — create an item of the given type. */
export function makeAgentCreateHandler(type: KnownItemType) {
  const api = AGENT_API[type]
  return async function POST(req: NextRequest) {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth
    const body = await parseBody(req, api.createSchema)
    if (body instanceof NextResponse) return body

    // parentItemId is a reference, and Zod can only shape-check it — the
    // ownership/type/nesting rules live in one guard shared with PATCH.
    if (type === 'task') {
      const parentId = (body.data as { parentItemId?: string | null }).parentItemId
      if (typeof parentId === 'string') {
        const problem = await validateParentItemId(
          auth.serviceClient,
          auth.userId,
          (body.data.id as string | undefined) ?? null,
          parentId
        )
        if (problem) return NextResponse.json({ error: problem }, { status: 400 })
      }
    }

    try {
      // createDefaults under the body, id resolved last (body id wins; the
      // schema turns id: null into undefined so it regenerates). Remaining
      // gaps fall through to the db mapper / column defaults, as before.
      const entity = {
        ...api.createDefaults,
        ...body.data,
        id: (body.data.id as string | undefined) ?? crypto.randomUUID(),
      }
      await api.create(auth.userId, entity as never, auth.serviceClient)
      return NextResponse.json({ [api.payloadKey]: entity }, { status: 201 })
    } catch (err) {
      return errorResponse(err)
    }
  }
}

/** PATCH + DELETE /api/agent/<plural>/:id handlers for the given type. */
export function makeAgentItemHandlers(type: KnownItemType) {
  const api = AGENT_API[type]

  const PATCH = async (
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    if (!(await verifyItemOwnership(auth.serviceClient, id, type, auth.userId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = await parseBody(req, api.updateSchema)
    if (body instanceof NextResponse) return body

    // Same referential guard as create: without it, a hallucinated id can
    // self-parent (item vanishes from every view), point at another user's
    // row, or nest subtasks.
    if (type === 'task') {
      const parentId = (body.data as { parentItemId?: string | null }).parentItemId
      if (typeof parentId === 'string') {
        const problem = await validateParentItemId(
          auth.serviceClient,
          auth.userId,
          id,
          parentId
        )
        if (problem) return NextResponse.json({ error: problem }, { status: 400 })
      }
    }

    // The pause VERB is not a column. Both keys are peeled off before the
    // update reaches the db layer — `pausedUntil` especially, because it IS in
    // updatesToRow's allowlist and would otherwise be written straight through,
    // skipping the interval rules resolvePauseWrite exists to enforce.
    const { paused, pausedUntil, ...fields } = body.data as {
      paused?: boolean
      pausedUntil?: string | null
    }
    const updates: Record<string, unknown> = fields
    if (paused !== undefined || pausedUntil !== undefined) {
      let resolved
      try {
        resolved = await pausePatchForItem(auth.serviceClient, auth.userId, id, {
          paused,
          pausedUntil,
        })
      } catch (err) {
        return errorResponse(err)
      }
      if ('error' in resolved) {
        // 'Not found' here means the row vanished between the ownership check
        // and this read — a 404 is the truthful answer, not a 400.
        return resolved.error === 'Not found'
          ? NextResponse.json({ error: 'Not found' }, { status: 404 })
          : badRequest(resolved.error)
      }
      Object.assign(updates, resolved.patch)
    }

    try {
      // Nulls survive validation only on clearable fields; the db-layer
      // allowlists translate them into NULL writes.
      await api.update(id, updates as never, auth.userId, auth.serviceClient)
    } catch (err) {
      return errorResponse(err)
    }

    // Only two fields can invalidate a role, so only a patch touching one pays
    // for the scan — `in`, not truthiness, because CLEARING either is exactly
    // the edit that does it: dropping repeatFrequency turns a check-in back
    // into a one-shot task, and setting parentItemId turns a milestone into a
    // subtask that no longer appears in the past-due machinery at all.
    if ('repeatFrequency' in fields || 'parentItemId' in fields) {
      try {
        const demoted = await demoteInvalidGoalRoles(auth.serviceClient, auth.userId, id)
        if (demoted.length > 0) return NextResponse.json({ success: true, demoted })
      } catch (err) {
        // Deliberately swallowed: the caller's edit landed, and reporting a
        // bookkeeping failure as a failed PATCH would invite a retry of a write
        // that already succeeded.
        console.error('goal role demotion failed', err)
      }
    }

    return NextResponse.json({ success: true })
  }

  const DELETE = async (
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    if (!(await verifyItemOwnership(auth.serviceClient, id, type, auth.userId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    try {
      await api.remove(id, auth.userId, auth.serviceClient)
      return NextResponse.json({ success: true })
    } catch (err) {
      return errorResponse(err)
    }
  }

  return { PATCH, DELETE }
}

// ── Routines & seasons ───────────────────────────────────────────────────────
// Agent-writable from schemaVersion 4. Reads stay on /api/agent/context, which
// serves routines[] and seasons[] alongside the items they gate — the same
// split tasks and habits have always had.

/**
 * The GATE-role containers, which is all this file's generic container
 * machinery covers. Deliberately NOT named `ContainerKind`: the registry in
 * lib/container-registry.ts exports a type by that name spanning every role
 * (classify, gate, aspire), and two same-named types with different memberships
 * would mislead every later reader. Goals are `aspire` — they have three role
 * arrays and no pause verb — so they get their own handlers below rather than a
 * row in CONTAINER_API.
 */
export type GatedContainerKind = 'routine' | 'season'

interface ContainerApiConfig {
  payloadKey: GatedContainerKind
  table: 'routines' | 'seasons'
  createSchema: ZodType
  updateSchema: ZodType
  /** Merged UNDER the body on create — the columns the db layer requires. */
  createDefaults: Record<string, unknown>
  create: (userId: string, entity: never, client: DbClient) => Promise<void>
  update: (userId: string, id: string, updates: never, client: DbClient) => Promise<void>
  remove: (userId: string, id: string, client: DbClient) => Promise<void>
  /** True when this container may hold routines as well as items. */
  holdsRoutines: boolean
  /** True when this container's suppression is expressed as pause columns. */
  usesPauseVerb: boolean
  /** Where this container's item membership lives, for the trashed-member rule. */
  itemJoin: JoinTable
  /** Only seasons hold routines. */
  routineJoin?: JoinTable
}

const CONTAINER_API: Record<GatedContainerKind, ContainerApiConfig> = {
  routine: {
    payloadKey: 'routine',
    table: 'routines',
    createSchema: RoutineCreateSchema,
    updateSchema: RoutineUpdateSchema,
    // itemIds is NOT NULL-able app-side (Routine.itemIds is required), and
    // createRoutine reads .length on it before deciding to reconcile.
    createDefaults: { itemIds: [] },
    create: (userId, entity, client) => createRoutine(userId, entity as Routine, client),
    update: (userId, id, updates, client) =>
      updateRoutine(userId, id, updates as Partial<Routine>, client),
    remove: (userId, id, client) => deleteRoutine(userId, id, client),
    holdsRoutines: false,
    usesPauseVerb: true,
    itemJoin: {
      table: 'routine_items',
      ownerCol: 'routine_id',
      memberCol: 'item_id',
      memberTable: 'items',
    },
  },
  season: {
    payloadKey: 'season',
    table: 'seasons',
    createSchema: SeasonCreateSchema,
    updateSchema: SeasonUpdateSchema,
    // 'auto' with no range means "always on", which is the least surprising
    // thing a season created without a state can be — and unlike a pause it
    // needs no timestamp, so there is nothing to derive.
    createDefaults: { state: 'auto', itemIds: [], routineIds: [] },
    create: (userId, entity, client) => createSeason(userId, entity as Season, client),
    update: (userId, id, updates, client) =>
      updateSeason(userId, id, updates as Partial<Season>, client),
    remove: (userId, id, client) => deleteSeason(userId, id, client),
    holdsRoutines: true,
    // Seasons express the same idea as a tri-state enum, which carries no
    // derived timestamp and therefore needs no verb translation: `state` IS the
    // verb. See isSeasonActiveOn for why the two containers differ.
    usesPauseVerb: false,
    itemJoin: {
      table: 'season_items',
      ownerCol: 'season_id',
      memberCol: 'item_id',
      memberTable: 'items',
    },
    routineJoin: {
      table: 'season_routines',
      ownerCol: 'season_id',
      memberCol: 'routine_id',
      memberTable: 'routines',
    },
  },
}

async function verifyContainerOwnership(
  client: DbClient,
  table: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from(table)
    .select('user_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  // A dropped error is how a missing table (PGRST205, the whole pre-migration
  // deploy window) or a transient PostgREST failure becomes an indistinguishable
  // 404 — the one status that tells a caller to stop retrying and forget the id.
  // Thrown, it is turned into a server fault by ownershipGate below — which is
  // the ONLY way this should be called. Every direct caller sat above its
  // handler's try block, so the throw escaped to Next.js and became a bare 500
  // with no { error } body: the exact message this throw exists to surface was
  // the thing being lost.
  if (error) throw error
  return !!data && data.user_id === userId
}

/**
 * Ownership check that cannot escape its handler.
 *
 * Returns the response to send — 404 when the row is absent or another user's,
 * an errorResponse when the read itself faulted — or null when the caller owns
 * the row and the handler should continue.
 */
async function ownershipGate(
  client: DbClient,
  table: string,
  id: string,
  userId: string,
): Promise<NextResponse | null> {
  try {
    if (!(await verifyContainerOwnership(client, table, id, userId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return null
  } catch (err) {
    return errorResponse(err)
  }
}

/** Membership arrays in a create/update body, validated together. */
async function validateContainerMembers(
  client: DbClient,
  userId: string,
  body: { itemIds?: string[]; routineIds?: string[] },
  config: ContainerApiConfig,
): Promise<string | null> {
  if (body.itemIds) {
    const problem = await validateItemMembers(client, userId, body.itemIds)
    if (problem) return problem
  }
  if (body.routineIds) {
    // Unreachable for routines — RoutineUpdateSchema has no routineIds key and
    // Zod strips unknown ones — but stated rather than assumed, so nesting a
    // routine inside a routine can never arrive silently through a schema edit.
    if (!config.holdsRoutines) return 'routines cannot hold other routines'
    const problem = await validateRoutineMembers(client, userId, body.routineIds)
    if (problem) return problem
  }
  return null
}

/**
 * Translate a container's pause verb. Routines only — see `usesPauseVerb`.
 *
 * `current` is the row's stored pause columns; on create it is empty, which is
 * what makes `paused: true` at creation mean "born paused, from now".
 */
async function pausePatchForContainer(
  client: DbClient,
  userId: string,
  current: Pausable,
  req: { paused?: boolean; pausedUntil?: string | null },
): Promise<{ patch: Pausable } | { error: string }> {
  const tz = await userTimezone(client, userId)
  const now = new Date()
  const resolved = resolvePauseWrite(current, req, toDateStr(now, tz), now.toISOString(), tz)
  return 'reason' in resolved ? { error: resolved.reason } : { patch: resolved.patch }
}

/** POST /api/agent/<routines|seasons> */
export function makeContainerCreateHandler(kind: GatedContainerKind) {
  const config = CONTAINER_API[kind]
  return async function POST(req: NextRequest) {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth
    const body = await parseBody(req, config.createSchema)
    if (body instanceof NextResponse) return body

    const { paused, pausedUntil, ...fields } = body.data as {
      paused?: boolean
      pausedUntil?: string | null
      itemIds?: string[]
      routineIds?: string[]
    }

    try {
      const problem = await validateContainerMembers(
        auth.serviceClient,
        auth.userId,
        fields,
        config,
      )
      if (problem) return badRequest(problem)

      const entity: Record<string, unknown> = {
        ...config.createDefaults,
        ...fields,
        id: (fields as { id?: string }).id ?? crypto.randomUUID(),
      }

      if (config.usesPauseVerb && (paused !== undefined || pausedUntil !== undefined)) {
        // Empty `current`: a container being created is not paused yet, so
        // `paused: true` takes the fresh-pause branch and stamps pausedAt now.
        const resolved = await pausePatchForContainer(auth.serviceClient, auth.userId, {}, {
          paused,
          pausedUntil,
        })
        if ('error' in resolved) return badRequest(resolved.error)
        Object.assign(entity, resolved.patch)
      }

      await config.create(auth.userId, entity as never, auth.serviceClient)
      return NextResponse.json({ [config.payloadKey]: entity }, { status: 201 })
    } catch (err) {
      return errorResponse(err)
    }
  }
}

/** PATCH + DELETE /api/agent/<routines|seasons>/:id */
export function makeContainerItemHandlers(kind: GatedContainerKind) {
  const config = CONTAINER_API[kind]

  const PATCH = async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    const denied = await ownershipGate(auth.serviceClient, config.table, id, auth.userId)
    if (denied) return denied

    const body = await parseBody(req, config.updateSchema)
    if (body instanceof NextResponse) return body

    const { paused, pausedUntil, ...fields } = body.data as {
      paused?: boolean
      pausedUntil?: string | null
      itemIds?: string[]
      routineIds?: string[]
    }
    const updates: Record<string, unknown> = fields

    try {
      const problem = await validateContainerMembers(
        auth.serviceClient,
        auth.userId,
        fields,
        config,
      )
      if (problem) return badRequest(problem)

      // Whole-set replacement, minus the members the caller could not see —
      // see withTrashedMembersKept.
      if (fields.itemIds) {
        updates.itemIds = await keepTrashedMembers(
          auth.serviceClient,
          auth.userId,
          config.itemJoin,
          id,
          fields.itemIds,
        )
      }
      if (fields.routineIds && config.routineJoin) {
        updates.routineIds = await keepTrashedMembers(
          auth.serviceClient,
          auth.userId,
          config.routineJoin,
          id,
          fields.routineIds,
        )
      }

      if (config.usesPauseVerb && (paused !== undefined || pausedUntil !== undefined)) {
        const { data } = await auth.serviceClient
          .from(config.table)
          .select('paused_at, paused_until')
          .eq('id', id)
          .eq('user_id', auth.userId)
          .maybeSingle()
        const row = (data ?? {}) as { paused_at?: string | null; paused_until?: string | null }
        const resolved = await pausePatchForContainer(
          auth.serviceClient,
          auth.userId,
          { pausedAt: row.paused_at ?? undefined, pausedUntil: row.paused_until ?? undefined },
          { paused, pausedUntil },
        )
        if ('error' in resolved) return badRequest(resolved.error)
        Object.assign(updates, resolved.patch)
      }

      await config.update(auth.userId, id, updates as never, auth.serviceClient)
      return NextResponse.json({ success: true })
    } catch (err) {
      return errorResponse(err)
    }
  }

  const DELETE = async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authenticateAgent(_req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    const denied = await ownershipGate(auth.serviceClient, config.table, id, auth.userId)
    if (denied) return denied

    try {
      // Soft delete, like every other agent DELETE — membership rows survive so
      // a restore inside the 30-day window brings the collection back intact,
      // and the resolver ignores trashed containers meanwhile, so whatever this
      // was hiding becomes visible again immediately.
      await config.remove(auth.userId, id, auth.serviceClient)
      return NextResponse.json({ success: true })
    } catch (err) {
      return errorResponse(err)
    }
  }

  return { PATCH, DELETE }
}

// ── Goals ─────────────────────────────────────────────────────────────────────
// Agent-writable from schemaVersion 5. Reads stay on /api/agent/context, which
// serves goals[] with all three role arrays.
//
// Not a row in CONTAINER_API above: a goal holds THREE role arrays rather than
// one itemIds set, has no pause verb to translate, and derives `achievedAt`
// from its state. Sharing the generic handler would have meant three optional
// branches in every one of its steps.

const GOAL_ITEM_JOIN: JoinTable = {
  table: 'goal_items',
  ownerCol: 'goal_id',
  memberCol: 'item_id',
  memberTable: 'items',
}

/** The three membership arrays, paired with the role each one grants. */
const GOAL_ROLE_KEYS = [
  { key: 'memberIds', role: 'member' },
  { key: 'milestoneIds', role: 'milestone' },
  { key: 'checkinIds', role: 'checkin' },
] as const satisfies readonly { key: string; role: GoalRole }[]

type GoalMemberArrays = {
  memberIds?: string[]
  milestoneIds?: string[]
  checkinIds?: string[]
}

// roleShape, and the demotion the item PATCH runs (demoteInvalidGoalRoles),
// live in lib/goal-roles.ts, which the iPhone app's repeat edit runs too.

/**
 * Every id across the three arrays, checked for existence and collectibility,
 * then each ROLE id checked against its registry predicate.
 *
 * The role half is the agent's copy of the grant-time guard the pickers enforce
 * by only rendering eligible items (locked decision 3). Without it an agent can
 * make a recurring item a milestone — a row whose scalar status is frozen by
 * migration 016 semantics, so the goal reads permanently behind with nothing to
 * click, and no later item edit demotes it because none is coming.
 *
 * One read for all three arrays: the arrays overlap in practice (a whole-set
 * replacement usually resends most of the goal), and three reads would ask the
 * same rows the same question.
 */
async function validateGoalMembers(
  client: DbClient,
  userId: string,
  body: GoalMemberArrays,
): Promise<string | null> {
  const all = [
    ...(body.memberIds ?? []),
    ...(body.milestoneIds ?? []),
    ...(body.checkinIds ?? []),
  ]
  if (all.length === 0) return null

  const unique = [...new Set(all)]
  const { data, error } = await client
    .from('items')
    .select('id, type, parent_item_id, repeat_frequency')
    .eq('user_id', userId)
    .in('id', unique)
  if (error) throw error

  const rows = (data ?? []) as RoleRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = unique.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return `membership references items that do not exist: ${missing.join(', ')}`
  }
  const uncollectible = rows.filter((r) => !isCollectible(roleShape(r)))
  if (uncollectible.length > 0) {
    return (
      `membership references items that cannot join a collection: ` +
      `${uncollectible.map((r) => r.id).join(', ')} ` +
      `(subtasks belong to their parent and follow its state)`
    )
  }

  for (const id of body.milestoneIds ?? []) {
    if (!isMilestoneEligible(roleShape(byId.get(id)!))) {
      return (
        `item ${id} cannot be a milestone: a milestone is a one-shot target that ` +
        `finishes once, and this item repeats (or is a type that never finishes). ` +
        `Send it in checkinIds if it is the goal's recurring review, or memberIds ` +
        `if it is ordinary work the goal contains.`
      )
    }
  }
  for (const id of body.checkinIds ?? []) {
    if (!isCheckinEligible(roleShape(byId.get(id)!))) {
      return (
        `item ${id} cannot be a check-in: a check-in is a recurring review, and ` +
        `this item does not repeat (or is a type that cannot). If it is a task ` +
        `or a habit, set a repeatFrequency on it first; otherwise send it in ` +
        `milestoneIds if it is a one-shot target, or memberIds if it is ordinary ` +
        `work the goal contains.`
      )
    }
  }
  return null
}

/**
 * Per-role trash keeping across whichever arrays the body carries.
 *
 * The three arrays are replaced independently, but they write ONE join table,
 * so the keeping cannot be decided one array at a time. Moving a TRASHED
 * milestone to plain membership sends `{milestoneIds: [], memberIds: [X]}`: the
 * milestone pass sees X dropped and, finding it trashed, dutifully puts it
 * back — and goalMemberRows then refuses the body for naming X twice, with a
 * 500 the caller has no way to avoid. Every id the body names anywhere is
 * therefore off-limits to the keeping in every OTHER array.
 */
async function keepTrashedGoalMembers(
  client: DbClient,
  userId: string,
  goalId: string,
  body: GoalMemberArrays,
): Promise<GoalMemberArrays> {
  const kept: GoalMemberArrays = {}
  for (const { key, role } of GOAL_ROLE_KEYS) {
    const desired = body[key]
    if (!desired) continue
    const claimedElsewhere = new Set(
      GOAL_ROLE_KEYS.filter((k) => k.key !== key).flatMap((k) => body[k.key] ?? []),
    )
    kept[key] = await keepTrashedMembers(
      client,
      userId,
      GOAL_ITEM_JOIN,
      goalId,
      desired,
      role,
      claimedElsewhere,
    )
  }
  return kept
}

/**
 * Translate the `state` verb into the columns it actually writes.
 *
 * `achievedAt` is derived, never sent (GoalCreateSchema/GoalUpdateSchema refuse
 * it outright): resolveGoalStateWrite returns an EMPTY patch for a same-state
 * write, so a retried "mark achieved" cannot drag the achievement date forward,
 * and returning to 'active' clears the stamp.
 */
async function goalStatePatch(
  client: DbClient,
  userId: string,
  id: string,
  state: Goal['state'],
): Promise<Partial<Goal> | { error: string }> {
  const { data, error } = await client
    .from('goals')
    .select('state, achieved_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  // Same reason as verifyContainerOwnership: a failed READ is not a missing row.
  if (error) throw error
  if (!data) return { error: 'Not found' }
  const row = data as { state: Goal['state']; achieved_at: string | null }
  const current = { state: row.state, achievedAt: row.achieved_at ?? undefined } as Goal
  return resolveGoalStateWrite(current, state, new Date().toISOString())
}

/**
 * Drop the keys the goal schemas carry only in order to REFUSE them. They never
 * survive validation, so this is belt-and-braces: a later schema edit that
 * relaxed one would otherwise write it straight into a column, skipping the
 * derivation rules the refusal exists to protect.
 */
function withoutDerivedGoalKeys(
  data: unknown,
): GoalMemberArrays & { state?: Goal['state'] } & Record<string, unknown> {
  const rest = { ...(data as Record<string, unknown>) }
  delete rest.paused
  delete rest.pausedUntil
  delete rest.achievedAt
  return rest as GoalMemberArrays & { state?: Goal['state'] } & Record<string, unknown>
}

/** POST /api/agent/goals */
export function makeGoalCreateHandler() {
  return async function POST(req: NextRequest) {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth
    const body = await parseBody(req, GoalCreateSchema)
    if (body instanceof NextResponse) return body

    // The three derived/refused keys never survive validation, but they are
    // peeled anyway so a schema edit cannot leak them into a column write.
    const fields = withoutDerivedGoalKeys(body.data)

    try {
      const problem = await validateGoalMembers(auth.serviceClient, auth.userId, fields)
      if (problem) return badRequest(problem)

      const entity: Record<string, unknown> = {
        // Goal's three arrays are required app-side, and the 201 echoes this
        // entity back — a create that omitted them would hand the caller a goal
        // object missing the fields every reader indexes. (goalMemberRows skips
        // an absent array outright, so this is about the echo and the type, not
        // about making the reconcile fire.)
        memberIds: [],
        milestoneIds: [],
        checkinIds: [],
        state: 'active',
        ...fields,
        id: (fields as { id?: string }).id ?? crypto.randomUUID(),
      }
      // A goal born 'achieved' is a record of finished work, and it deserves
      // the same stamp the achieve verb writes.
      if (entity.state === 'achieved') entity.achievedAt = new Date().toISOString()

      await createGoal(auth.userId, entity as unknown as Goal, auth.serviceClient)
      return NextResponse.json({ goal: entity }, { status: 201 })
    } catch (err) {
      return errorResponse(err)
    }
  }
}

/** PATCH + DELETE /api/agent/goals/:id */
export function makeGoalItemHandlers() {
  const PATCH = async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    // Service role bypasses RLS, so ownership is checked here or nowhere.
    const denied = await ownershipGate(auth.serviceClient, 'goals', id, auth.userId)
    if (denied) return denied

    const body = await parseBody(req, GoalUpdateSchema)
    if (body instanceof NextResponse) return body

    const { state, ...fields } = withoutDerivedGoalKeys(body.data)
    const updates: Record<string, unknown> = fields

    try {
      const problem = await validateGoalMembers(auth.serviceClient, auth.userId, fields)
      if (problem) return badRequest(problem)

      Object.assign(
        updates,
        await keepTrashedGoalMembers(auth.serviceClient, auth.userId, id, fields),
      )

      if (state !== undefined) {
        const patch = await goalStatePatch(auth.serviceClient, auth.userId, id, state)
        // The row vanished between the ownership check and this read.
        if ('error' in patch) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        Object.assign(updates, patch)
      }

      await updateGoal(auth.userId, id, updates as Partial<Goal>, auth.serviceClient)
      return NextResponse.json({ success: true })
    } catch (err) {
      return errorResponse(err)
    }
  }

  const DELETE = async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authenticateAgent(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await params
    const denied = await ownershipGate(auth.serviceClient, 'goals', id, auth.userId)
    if (denied) return denied

    try {
      // Soft delete. Membership rows survive with their ROLES, so a restore
      // inside the 30-day window brings the goal back with its progress
      // denominator intact rather than as a flat bag of members.
      await deleteGoal(auth.userId, id, auth.serviceClient)
      return NextResponse.json({ success: true })
    } catch (err) {
      return errorResponse(err)
    }
  }

  return { PATCH, DELETE }
}
