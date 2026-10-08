import { describe, it, expect } from 'vitest';
import { inactiveItemIdsOn, isOpenLoopOn } from '@/lib/active';
import { MCP_TOOLS, TOOL_DESCRIPTORS, selectAssignedWork, toolByName } from '@/lib/mcp/tools';
import type { Item, Routine, Season } from '@/lib/planner-types';

/**
 * Tool planning is pure: arguments in, "which agent endpoint" out. Executing
 * the plan is the route's job, and every rule about WHAT a write may do stays
 * in lib/agent-api.ts. These tests pin the mapping and the refusals — the two
 * things that would otherwise silently drift from the agent API.
 */

const plan = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.plan(args);

describe('the tool surface', () => {
  it('exposes descriptors without leaking the plan functions', () => {
    for (const d of TOOL_DESCRIPTORS) {
      expect(Object.keys(d).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('names every tool dsul_*, since they share a namespace with other servers', () => {
    for (const t of MCP_TOOLS) expect(t.name).toMatch(/^dsul_[a-z_]+$/);
  });

  it('gives every tool an object input schema that refuses unknown keys', () => {
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it('writes descriptions long enough to steer a model', () => {
    for (const t of MCP_TOOLS) expect(t.description.length, t.name).toBeGreaterThan(60);
  });

  it('has unique names', () => {
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });
});

describe('items', () => {
  it('reads context with a GET and no body', () => {
    expect(plan('dsul_get_context')).toEqual({ method: 'GET', path: '/api/agent/context' });
  });

  it('creates a task', () => {
    expect(plan('dsul_create_task', { title: 'Book dentist', startDate: '2026-08-06' })).toEqual({
      method: 'POST',
      path: '/api/agent/tasks',
      body: { title: 'Book dentist', startDate: '2026-08-06' },
    });
  });

  it('refuses a create with no title rather than posting an empty one', () => {
    expect(plan('dsul_create_task', {})).toMatchObject({ error: expect.stringContaining('title') });
    expect(plan('dsul_create_task', { title: '   ' })).toMatchObject({ error: expect.any(String) });
  });

  it('drops keys the endpoint does not accept', () => {
    // Zod strips unknown keys server-side and returns a lying 200; not sending
    // them is how the model finds out.
    const result = plan('dsul_update_task', { id: 'x', title: 'New', bogus: 1 }) as {
      body: Record<string, unknown>;
    };
    expect(result.body).toEqual({ title: 'New' });
  });

  it('puts the id in the path, never the body', () => {
    expect(plan('dsul_update_task', { id: 'abc', priority: 'high' })).toEqual({
      method: 'PATCH',
      path: '/api/agent/tasks/abc',
      body: { priority: 'high' },
    });
    expect(plan('dsul_delete_task', { id: 'abc' })).toEqual({
      method: 'DELETE',
      path: '/api/agent/tasks/abc',
    });
  });

  it('routes habits to their own endpoints', () => {
    expect(plan('dsul_create_habit', { title: 'Stretch', group: 'Health' })).toEqual({
      method: 'POST',
      path: '/api/agent/habits',
      body: { title: 'Stretch', group: 'Health' },
    });
    expect(plan('dsul_update_habit', { id: 'h1', completedDates: ['2026-08-06'] })).toEqual({
      method: 'PATCH',
      path: '/api/agent/habits/h1',
      body: { completedDates: ['2026-08-06'] },
    });
  });

  it('tells the model, in the tool text, how to complete a recurring item', () => {
    // The single most common way to corrupt a series is status-instead-of-date,
    // and the next is a short completedDates list un-ticking the rest.
    expect(toolByName('dsul_update_task')!.description).toMatch(/dsul_complete/);
    expect(toolByName('dsul_update_task')!.description).toMatch(/completedDates/);
    expect(toolByName('dsul_update_habit')!.description).toMatch(/dsul_complete/);
    expect(toolByName('dsul_update_habit')!.description).toMatch(/completedDates/);
  });

  it('takes a monthly repeat day on tasks and habits', () => {
    for (const name of ['dsul_create_task', 'dsul_update_task', 'dsul_create_habit', 'dsul_update_habit']) {
      const args = name.startsWith('dsul_create') ? { title: 'Rent', repeatMonthDay: 1 } : { id: 'abc', repeatMonthDay: 1 };
      expect((plan(name, args) as { body: Record<string, unknown> }).body.repeatMonthDay, name).toBe(1);
    }
  });
});

describe('one-day verbs', () => {
  const ACT = '/api/agent/items/abc/act';

  it('ticks one date, done by default', () => {
    expect(plan('dsul_complete', { id: 'abc', date: '2026-10-08' })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'complete', date: '2026-10-08', done: true },
    });
  });

  it('unticks, and carries a habit tally', () => {
    expect(plan('dsul_complete', { id: 'abc', date: '2026-10-08', done: false, count: 2 })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'complete', date: '2026-10-08', done: false, count: 2 },
    });
  });

  it('skips and unskips one date', () => {
    expect(plan('dsul_skip', { id: 'abc', date: '2026-10-08' })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'skip', date: '2026-10-08', skipped: true },
    });
    expect((plan('dsul_skip', { id: 'abc', date: '2026-10-08', skipped: false }) as { body: unknown }).body).toEqual({
      action: 'skip',
      date: '2026-10-08',
      skipped: false,
    });
  });

  it('carries a task to a day', () => {
    expect(plan('dsul_move', { id: 'abc', date: '2026-10-09' })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'move', date: '2026-10-09' },
    });
  });

  it('resets a streak with no other field', () => {
    expect(plan('dsul_reset_streak', { id: 'abc' })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'resetStreak' },
    });
  });

  it('adds or removes one routine or season member', () => {
    expect(plan('dsul_set_membership', { id: 'abc', kind: 'routine', collectionId: 'r1' })).toEqual({
      method: 'POST',
      path: ACT,
      body: { action: 'collect', kind: 'routine', containerId: 'r1', member: true },
    });
    expect(
      (plan('dsul_set_membership', { id: 'abc', kind: 'season', collectionId: 's1', member: false }) as { body: unknown }).body
    ).toEqual({ action: 'collect', kind: 'season', containerId: 's1', member: false });
  });

  it('refuses a missing or loose date rather than guessing today', () => {
    for (const name of ['dsul_complete', 'dsul_skip', 'dsul_move']) {
      expect(plan(name, { id: 'abc' }), name).toHaveProperty('error');
      expect(plan(name, { id: 'abc', date: 'Oct 8' }), name).toHaveProperty('error');
    }
  });

  it('refuses a non-boolean flag and a goal membership', () => {
    expect(plan('dsul_complete', { id: 'abc', date: '2026-10-08', done: 'yes' })).toHaveProperty('error');
    expect(plan('dsul_skip', { id: 'abc', date: '2026-10-08', skipped: 'yes' })).toHaveProperty('error');
    expect(plan('dsul_set_membership', { id: 'abc', kind: 'goal', collectionId: 'g1' })).toHaveProperty('error');
    expect(plan('dsul_set_membership', { id: 'abc', kind: 'routine' })).toHaveProperty('error');
  });

  it('sends every schema property it lists', () => {
    // The verbs rename two keys on the way (collectionId → containerId, and the
    // action), so this compares by value: a property the plan drops is one the
    // model believes it set.
    const cases: [string, Record<string, unknown>][] = [
      ['dsul_complete', { id: 'abc', date: '2026-10-08', done: false, count: 7 }],
      ['dsul_skip', { id: 'abc', date: '2026-10-08', skipped: false }],
      ['dsul_move', { id: 'abc', date: '2026-10-09' }],
      ['dsul_reset_streak', { id: 'abc' }],
      ['dsul_set_membership', { id: 'abc', kind: 'season', collectionId: 's9', member: false }],
    ];
    for (const [name, args] of cases) {
      const props = Object.keys((toolByName(name)!.inputSchema as { properties: Record<string, unknown> }).properties);
      expect(Object.keys(args).sort(), name).toEqual(props.sort());
      const body = JSON.stringify((plan(name, args) as { body: unknown }).body);
      for (const [k, v] of Object.entries(args)) if (k !== 'id') expect(body, `${name}.${k}`).toContain(JSON.stringify(v));
    }
  });
});

describe('the schema and the body agree', () => {
  // A key the schema lists but the plan drops is a field the model believes it
  // set (habit duration and reminderTime were exactly this). A key the plan
  // sends but the schema hides is one no strict client will ever send (task
  // repeatFrequency was). Fill every property and compare.
  const WRITE_TOOLS = [
    'dsul_create_task', 'dsul_update_task', 'dsul_create_habit', 'dsul_update_habit',
    'dsul_create_project', 'dsul_update_project',
  ];
  for (const name of WRITE_TOOLS) {
    it(name, () => {
      const props = Object.keys(
        (toolByName(name)!.inputSchema as { properties: Record<string, unknown> }).properties
      );
      const args = Object.fromEntries(props.map((k) => [k, 'x']));
      const result = plan(name, args) as { body: Record<string, unknown> };
      expect(Object.keys(result.body).sort()).toEqual(props.filter((k) => k !== 'id').sort());
    });
  }
});

describe('projects', () => {
  it('creates a project by name', () => {
    expect(plan('dsul_create_project', { name: 'YouTube', notes: 'Weekly devlog' })).toEqual({
      method: 'POST',
      path: '/api/agent/projects',
      body: { name: 'YouTube', notes: 'Weekly devlog' },
    });
  });

  it('refuses a repeating task with no start day, which would never come round', () => {
    expect(plan('dsul_create_task', { title: 'Bins', repeatFrequency: 'custom', repeatDays: [1] })).toMatchObject({
      error: expect.stringContaining('startDate'),
    });
    expect(
      plan('dsul_create_task', { title: 'Bins', repeatFrequency: 'custom', repeatDays: [1], startDate: '2026-10-12' })
    ).toMatchObject({ method: 'POST' });
    expect(plan('dsul_create_task', { title: 'Once', repeatFrequency: 'none' })).toMatchObject({ method: 'POST' });
  });

  it('refuses a create with no name', () => {
    expect(plan('dsul_create_project', { name: ' ' })).toMatchObject({ error: expect.any(String) });
  });

  it('deletes by id, in the path', () => {
    expect(plan('dsul_delete_project', { id: 'p1' })).toEqual({ method: 'DELETE', path: '/api/agent/projects/p1' });
    expect(plan('dsul_delete_project', {})).toHaveProperty('error');
  });

  it('updates by id, in the path', () => {
    expect(plan('dsul_update_project', { id: 'p1', name: 'Sunday Softworks' })).toEqual({
      method: 'PATCH',
      path: '/api/agent/projects/p1',
      body: { name: 'Sunday Softworks' },
    });
  });

  it('refuses an update that changes nothing, or blanks the name', () => {
    expect(plan('dsul_update_project', { id: 'p1' })).toMatchObject({ error: expect.any(String) });
    expect(plan('dsul_update_project', { id: 'p1', name: '' })).toMatchObject({ error: expect.any(String) });
  });

  it('tells the model to create a new project before filing under it', () => {
    expect(toolByName('dsul_create_task')!.description).toMatch(/dsul_create_project/);
    expect(toolByName('dsul_create_habit')!.description).toMatch(/dsul_create_project/);
  });
});

describe('pause', () => {
  it('pauses with an exclusive return date', () => {
    expect(plan('dsul_pause', { kind: 'habit', id: 'h1', paused: true, until: '2026-08-10' })).toEqual({
      method: 'PATCH',
      path: '/api/agent/habits/h1',
      body: { paused: true, pausedUntil: '2026-08-10' },
    });
  });

  it('resumes without a date', () => {
    expect(plan('dsul_pause', { kind: 'task', id: 't1', paused: false })).toEqual({
      method: 'PATCH',
      path: '/api/agent/tasks/t1',
      body: { paused: false },
    });
  });

  it('refuses a resume that carries a date, rather than silently dropping it', () => {
    expect(
      plan('dsul_pause', { kind: 'task', id: 't1', paused: false, until: '2026-08-10' })
    ).toMatchObject({ error: expect.stringContaining('only valid when pausing') });
  });

  it('refuses a kind that has no pause verb', () => {
    // Seasons use `state`, not pause.
    expect(plan('dsul_pause', { kind: 'season', id: 'p1', paused: true })).toMatchObject({
      error: expect.stringContaining('kind must be one of'),
    });
  });

  it('requires paused to be a boolean', () => {
    expect(plan('dsul_pause', { kind: 'task', id: 't1', paused: 'yes' })).toMatchObject({
      error: expect.any(String),
    });
  });
});

describe('collections', () => {
  it('creates each kind at its own endpoint', () => {
    expect(plan('dsul_create_collection', { kind: 'routine', name: 'Morning' })).toMatchObject({
      method: 'POST',
      path: '/api/agent/routines',
    });
    expect(plan('dsul_create_collection', { kind: 'season', name: 'Marathon block' })).toMatchObject({
      path: '/api/agent/seasons',
    });
    expect(plan('dsul_create_collection', { kind: 'goal', name: 'Run a 10k' })).toMatchObject({
      path: '/api/agent/goals',
    });
  });

  it('REFUSES keys a kind does not take instead of stripping them', () => {
    // Silently dropping milestoneIds off a routine is how a model concludes it
    // created milestones it did not.
    const result = plan('dsul_create_collection', {
      kind: 'routine',
      name: 'Morning',
      milestoneIds: ['a'],
    });
    expect(result).toMatchObject({ error: expect.stringContaining('does not take') });
    expect((result as { error: string }).error).toMatch(/milestoneIds/);
  });

  it('names what the kind DOES accept in the refusal', () => {
    const result = plan('dsul_create_collection', { kind: 'goal', name: 'x', routineIds: ['a'] });
    expect((result as { error: string }).error).toMatch(/memberIds/);
  });

  it('allows each kind its own keys', () => {
    expect(
      plan('dsul_create_collection', {
        kind: 'goal',
        name: 'Run a 10k',
        why: 'because',
        milestoneIds: ['m1'],
        targetOn: '2026-12-01',
      })
    ).toMatchObject({ method: 'POST', path: '/api/agent/goals' });
    expect(
      plan('dsul_update_collection', { kind: 'season', id: 'p1', routineIds: ['r1'], state: 'active' })
    ).toMatchObject({ method: 'PATCH', path: '/api/agent/seasons/p1' });
  });

  it('warns in the tool text that membership replaces rather than appends', () => {
    expect(toolByName('dsul_update_collection')!.description).toMatch(/REPLACE|replace/);
  });

  it('refuses an unknown kind', () => {
    expect(plan('dsul_create_collection', { kind: 'sprocket', name: 'x' })).toMatchObject({
      error: expect.stringContaining('kind must be one of'),
    });
    expect(plan('dsul_delete_collection', { kind: 'sprocket', id: 'x' })).toMatchObject({
      error: expect.any(String),
    });
  });

  it('requires an id to update or delete', () => {
    expect(plan('dsul_update_collection', { kind: 'goal' })).toMatchObject({ error: expect.any(String) });
    expect(plan('dsul_delete_collection', { kind: 'goal' })).toMatchObject({ error: expect.any(String) });
  });
});

describe('delegation — the pull loop', () => {
  it('reports progress against the item, with the pinned status vocabulary', () => {
    // Its own route rather than the generic task PATCH: that one verified only
    // account ownership, so a late report from a superseded run overwrote the
    // work that had replaced it. See the compare-and-set block at the foot.
    expect(plan('dsul_report_progress', { id: 't1', status: 'working' })).toEqual({
      method: 'POST',
      path: '/api/agent/items/t1/progress',
      body: { aiStatus: 'working' },
    });
  });

  it('carries the result text, which is what the user actually reads', () => {
    expect(
      plan('dsul_report_progress', { id: 't1', status: 'done', result: 'Booked for Thu 10am.' })
    ).toMatchObject({ body: { aiStatus: 'done', aiResult: 'Booked for Thu 10am.' } });
  });

  it('refuses a status outside the vocabulary rather than inventing one', () => {
    // aiStatus is a frozen contract the moment a real agent writes it.
    expect(plan('dsul_report_progress', { id: 't1', status: 'in-progress' })).toMatchObject({
      error: expect.stringContaining('status must be one of'),
    });
  });

  it('requires an id and a status', () => {
    expect(plan('dsul_report_progress', { status: 'done' })).toMatchObject({ error: expect.any(String) });
    expect(plan('dsul_report_progress', { id: 't1' })).toMatchObject({ error: expect.any(String) });
  });

  it('teaches the blocked-means-ask-the-user rule in the tool text', () => {
    const description = toolByName('dsul_report_progress')!.description;
    expect(description).toMatch(/blocked/);
    expect(description).toMatch(/question/i);
  });

  it('can write the delegation fields through the ordinary update tool too', () => {
    expect(
      plan('dsul_update_task', { id: 't1', assignee: 'openclaw', aiStatus: 'queued' })
    ).toMatchObject({ body: { assignee: 'openclaw', aiStatus: 'queued' } });
  });
});

describe('selectAssignedWork', () => {
  const task = (over: Record<string, unknown>) => ({
    type: 'task',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  });

  const context = {
    fetchedAt: '2026-08-25T09:00:00.000Z',
    userTimezone: 'Europe/London',
    items: [
      task({ id: 'a', title: 'Book dentist', assignee: 'openclaw', aiStatus: 'queued' }),
      task({ id: 'b', title: 'Mine' }),
      task({ id: 'c', title: 'Finished', assignee: 'openclaw', aiStatus: 'done', aiResult: 'ok' }),
      task({ id: 'd', title: 'Stuck', assignee: 'openclaw', aiStatus: 'blocked' }),
      task({ id: 'e', title: 'No status yet', assignee: 'openclaw' }),
    ],
  };

  it('returns only work that was handed to an agent', () => {
    const { assigned } = selectAssignedWork(context);
    expect(assigned.map((i) => i.id)).not.toContain('b');
  });

  it('defaults to open work — a queue, not a history', () => {
    const { assigned } = selectAssignedWork(context);
    expect(assigned.map((i) => i.id).sort()).toEqual(['a', 'd', 'e']);
  });

  it('treats a missing aiStatus as queued rather than dropping it', () => {
    // An item assigned through the UI has no status until a worker claims it.
    expect(selectAssignedWork(context).assigned.some((i) => i.id === 'e')).toBe(true);
  });

  it('includes finished work only when asked', () => {
    const { assigned } = selectAssignedWork(context, { includeFinished: true });
    expect(assigned.map((i) => i.id).sort()).toEqual(['a', 'c', 'd', 'e']);
  });

  it('keeps the timezone and fetch time, which a scheduled worker needs', () => {
    const result = selectAssignedWork(context);
    expect(result.userTimezone).toBe('Europe/London');
    expect(result.fetchedAt).toBe('2026-08-25T09:00:00.000Z');
  });

  it('carries the result text back so a worker can resume its own thread', () => {
    const { assigned } = selectAssignedWork(context, { includeFinished: true });
    expect(assigned.find((i) => i.id === 'c')?.aiResult).toBe('ok');
  });

  it('never serves a custom-type item — reporting on one would 404 forever', () => {
    // /api/agent/tasks/:id filters on .eq('type','task'), and the agent write
    // API does not expose custom types at all, so serving one here would be a
    // dead loop: visible work that can never be reported on.
    const { assigned } = selectAssignedWork({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      items: [
        { id: 'g', title: 'Goal work', type: 'custom', customType: 'goal', assignee: 'openclaw', status: 'pending' },
      ],
    });
    expect(assigned).toHaveLength(0);
  });

  it('never serves a habit either', () => {
    const { assigned } = selectAssignedWork({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      items: [{ id: 'h', title: 'Stretch', type: 'habit', assignee: 'openclaw', status: 'pending' }],
    });
    expect(assigned).toHaveLength(0);
  });

  it('drops work the user has since completed or cancelled', () => {
    // aiStatus alone would still say "queued" — the app has ONE definition of
    // "does this want doing" and this is not allowed to invent a second.
    const { assigned } = selectAssignedWork({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      items: [
        task({ id: 'done', title: 'Already done', assignee: 'openclaw', aiStatus: 'queued', status: 'completed' }),
        task({ id: 'gone', title: 'Cancelled', assignee: 'openclaw', aiStatus: 'queued', status: 'cancelled' }),
        task({ id: 'live', title: 'Still open', assignee: 'openclaw', aiStatus: 'queued' }),
      ],
    });
    expect(assigned.map((i) => i.id)).toEqual(['live']);
  });

  it('drops work a paused routine has switched off today', () => {
    const { assigned } = selectAssignedWork({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      userTimezone: 'UTC',
      routines: [
        { id: 'r1', name: 'Term time', itemIds: ['paused'], pausedAt: '2026-08-01T00:00:00.000Z', pausedUntil: '2026-12-01' },
      ],
      items: [
        task({ id: 'paused', title: 'Out of season', assignee: 'openclaw', aiStatus: 'queued' }),
        task({ id: 'live', title: 'Still open', assignee: 'openclaw', aiStatus: 'queued' }),
      ],
    });
    expect(assigned.map((i) => i.id)).toEqual(['live']);
  });

  it('survives a response that is missing, empty or the wrong shape', () => {
    expect(selectAssignedWork(undefined).assigned).toEqual([]);
    expect(selectAssignedWork({}).assigned).toEqual([]);
    expect(selectAssignedWork({ items: 'nope' }).assigned).toEqual([]);
    expect(selectAssignedWork({ items: [null, 3, 'x'] }).assigned).toEqual([]);
  });

  /**
   * "Today" is the user's day, not fetchedAt's UTC date. The item menu's "Hand
   * off" offers on the local day (toDateStr(new Date(), tz)), so a queue that
   * read the UTC date disagreed with it for every hour between UTC midnight and
   * the user's, and a hand-off it allowed sat at "Queued" forever.
   */
  describe("on the user's day, near midnight", () => {
    // 18:00 on Oct 5 in Los Angeles (PDT, UTC-7) is already Oct 6 in UTC.
    const LA = { fetchedAt: '2026-10-06T01:00:00.000Z', userTimezone: 'America/Los_Angeles' };
    const LA_DAY = '2026-10-05';
    // 01:00 on Oct 6 in Auckland (NZDT, UTC+13) is still Oct 5 in UTC.
    const AKL = { fetchedAt: '2026-10-05T12:00:00.000Z', userTimezone: 'Pacific/Auckland' };

    const season = (over: Record<string, unknown>) => ({
      id: 's', name: 'Season', state: 'auto', itemIds: ['held'], routineIds: [], ...over,
    });
    const held = () => task({ id: 'held', title: 'In the season', assignee: 'openclaw', aiStatus: 'queued' });
    const served = (body: Record<string, unknown>) => selectAssignedWork(body).assigned.map((i) => i.id);

    it('still serves work in a season that ends today, after UTC midnight', () => {
      expect(served({ ...LA, seasons: [season({ endsOn: '2026-10-05' })], items: [held()] })).toEqual(['held']);
    });

    it('does not serve work in a season that starts tomorrow, after UTC midnight', () => {
      expect(served({ ...LA, seasons: [season({ startsOn: '2026-10-06' })], items: [held()] })).toEqual([]);
    });

    it('keeps a pause that ends tomorrow in force, after UTC midnight', () => {
      const paused = task({
        id: 'paused', title: 'Paused', assignee: 'openclaw', aiStatus: 'queued',
        pausedAt: '2026-09-01T00:00:00.000Z', pausedUntil: '2026-10-06',
      });
      expect(served({ ...LA, items: [paused] })).toEqual([]);
    });

    it('drops a season that ended yesterday east of UTC, before UTC midnight', () => {
      expect(served({ ...AKL, seasons: [season({ endsOn: '2026-10-05' })], items: [held()] })).toEqual([]);
    });

    it("serves exactly what the menu's rule offers on the local day", () => {
      const routines = [
        { id: 'r', name: 'Term time', itemIds: ['in-routine'], pausedAt: '2026-09-01T00:00:00.000Z', pausedUntil: '2026-10-06' },
      ];
      const seasons = [
        season({ id: 's-ends', endsOn: '2026-10-05', itemIds: ['ends-today'] }),
        season({ id: 's-starts', startsOn: '2026-10-06', itemIds: ['starts-tomorrow'] }),
      ];
      const items = [
        task({ id: 'plain', title: 'Plain' }),
        task({ id: 'ends-today', title: 'Season ends today' }),
        task({ id: 'starts-tomorrow', title: 'Season starts tomorrow' }),
        task({ id: 'in-routine', title: 'Routine paused until tomorrow' }),
        task({ id: 'pause-ends', title: 'Pause ends tomorrow', pausedAt: '2026-09-01T00:00:00.000Z', pausedUntil: '2026-10-06' }),
      ].map((i) => ({ ...i, assignee: 'openclaw', aiStatus: 'queued' }));

      const inactive = inactiveItemIdsOn(items as unknown as Item[], LA_DAY, {
        userTimezone: LA.userTimezone,
        routines: routines as unknown as Routine[],
        seasons: seasons as unknown as Season[],
      });
      const offered = (items as unknown as Item[])
        .filter((i) => isOpenLoopOn(i, LA_DAY) && !inactive.has(i.id))
        .map((i) => i.id);

      expect(offered).toEqual(['plain', 'ends-today']);
      expect(served({ ...LA, routines, seasons, items })).toEqual(offered);
    });

    it('falls back to the UTC date on a zone Intl does not know, rather than failing the poll', () => {
      const body = { ...LA, userTimezone: 'Not/AZone', seasons: [season({ endsOn: '2026-10-05' })], items: [held()] };
      expect(() => selectAssignedWork(body)).not.toThrow();
      expect(served(body)).toEqual([]);
    });

    it('still serves open work when fetchedAt is missing or unreadable', () => {
      // No day to gate on is "the server did not say", so nothing is suppressed.
      const seasons = [season({ endsOn: '2026-01-01' })];
      expect(served({ userTimezone: LA.userTimezone, seasons, items: [held()] })).toEqual(['held']);
      expect(served({ fetchedAt: 'later', userTimezone: LA.userTimezone, seasons, items: [held()] })).toEqual(['held']);
    });
  });
});

describe('dsul_item_activity — the reply channel', () => {
  it('reads one item\'s trail', () => {
    expect(plan('dsul_item_activity', { id: 't1' })).toEqual({
      method: 'GET',
      path: '/api/agent/items/t1/events',
    });
  });

  it('requires an id', () => {
    expect(plan('dsul_item_activity', {})).toMatchObject({ error: expect.any(String) });
  });

  it('tells the agent where a blocked answer shows up', () => {
    // Without this steer the agent marks something blocked and never looks back.
    const description = toolByName('dsul_item_activity')!.description;
    expect(description).toMatch(/agent_reply/);
    expect(toolByName('dsul_my_work')!.description).toMatch(/dsul_item_activity/);
  });
});

describe('what the worker is given', () => {
  it('carries the fields it needs to act without a second round-trip', () => {
    const { assigned } = selectAssignedWork({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      items: [
        {
          id: 'a', title: 'Book dentist', type: 'task', status: 'pending',
          isScheduled: false, order: 0, completedDates: [],
          assignee: 'openclaw', aiStatus: 'queued',
          startDate: '2026-08-26', startTime: '09:00', timeBucket: 'morning',
          priority: 'high', notes: 'the one on King St',
        },
      ],
    });
    expect(assigned[0]).toMatchObject({
      status: 'pending', startDate: '2026-08-26', startTime: '09:00',
      timeBucket: 'morning', priority: 'high', notes: 'the one on King St',
    });
  });
});

describe('dsul_ask_user — a question with answers', () => {
  /**
   * Most of what actually stops delegated work is a CHOICE — which Dana, which
   * of the two invoices, is Thursday still fine. `report_progress('blocked')`
   * could ask; it could not offer. Making someone retype a name into a box is
   * the difference between a loop that closes in a second and one that waits
   * until they have the energy to compose a sentence.
   */
  it('blocks the item and posts the question in one call', () => {
    // Two calls would make the half-done state reachable whenever a run dies
    // in between: a question with no block renders nowhere, and a block with no
    // question is the old text-box behaviour.
    expect(plan('dsul_ask_user', { id: 'i1', question: 'Which Dana?' })).toEqual({
      method: 'POST',
      path: '/api/agent/items/i1/ask',
      body: { question: 'Which Dana?' },
    });
  });

  it('carries the options through verbatim', () => {
    const result = plan('dsul_ask_user', {
      id: 'i1',
      question: 'Which Dana?',
      options: ['Dana Reyes', 'Dana Whitfield'],
    });
    expect(result).toMatchObject({
      body: { options: ['Dana Reyes', 'Dana Whitfield'] },
    });
  });

  it('omits options entirely rather than sending an empty list', () => {
    // An empty array reads to the route as "offer no buttons", which is right,
    // but sending the key at all invites a UI that renders an empty chip row.
    const result = plan('dsul_ask_user', { id: 'i1', question: 'What next?', options: [] });
    expect(result).not.toHaveProperty('body.options');
  });

  it('drops rubbish in the options rather than the whole question', () => {
    const result = plan('dsul_ask_user', {
      id: 'i1',
      question: 'Which one?',
      options: ['Real answer', '', '   ', 42, null],
    });
    expect(result).toMatchObject({ body: { options: ['Real answer'] } });
  });

  it('refuses without a question, which is all the user ever sees', () => {
    expect(plan('dsul_ask_user', { id: 'i1' })).toHaveProperty('error');
  });

  it('refuses without an id', () => {
    expect(plan('dsul_ask_user', { question: 'Which Dana?' })).toHaveProperty('error');
  });

  it('tells the agent to write options as answers, not as labels', () => {
    // "the first one" is useless as a reply: the text is sent back verbatim.
    const schema = toolByName('dsul_ask_user')!.inputSchema as {
      properties: { options: { description: string } };
    };
    expect(schema.properties.options.description).toMatch(/verbatim/i);
  });

  it('warns against options that are not exhaustive', () => {
    // A question whose real answer is not on the list is worse than no options
    // — it reads as a closed set and the user has to notice it is not.
    expect(toolByName('dsul_ask_user')!.description).toMatch(/exhaustive/i);
  });
});

describe('resuming a run that died', () => {
  /**
   * `working` is already in the open set, so the queue re-offers a stuck item —
   * what was missing is the evidence to tell a live run from a dead one. A
   * worker that treats every `working` item as somebody else's leaves the user
   * work they handed over and never got back; one that treats every `working`
   * item as abandoned double-runs whatever is genuinely in flight.
   */
  const working = (id: string, title: string, aiStatusAt?: string) => ({
    type: 'task',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    id,
    title,
    assignee: 'openclaw',
    aiStatus: 'working',
    ...(aiStatusAt ? { aiStatusAt } : {}),
  });

  const root = {
    fetchedAt: '2026-08-26T12:00:00.000Z',
    userTimezone: 'UTC',
    items: [
      working('live-1', 'Still going', '2026-08-26T11:56:00.000Z'),
      working('dead-1', 'Died hours ago', '2026-08-26T06:00:00.000Z'),
    ],
  };

  it('carries the stamp, so elapsed is computable against fetchedAt', () => {
    const { assigned, fetchedAt } = selectAssignedWork(root, {});
    expect(fetchedAt).toBe('2026-08-26T12:00:00.000Z');
    expect(assigned.map((a) => a.aiStatusAt)).toEqual([
      '2026-08-26T11:56:00.000Z',
      '2026-08-26T06:00:00.000Z',
    ]);
  });

  it('still returns a stuck working item — the queue never dropped it', () => {
    const { assigned } = selectAssignedWork(root, {});
    expect(assigned.map((a) => a.id)).toContain('dead-1');
  });

  it('omits the stamp cleanly when there is none', () => {
    const { assigned } = selectAssignedWork(
      { ...root, items: [working('nostamp-1', 'No stamp')] },
      {}
    );
    expect(assigned[0]).not.toHaveProperty('aiStatusAt');
  });

  it('tells the worker to leave a live run alone, and names a threshold', () => {
    /**
     * An earlier version of this text said "hours old means that run died —
     * pick it up and finish it". `dsul_report_progress` instructed reports
     * only at START, FINISH and STUCK, so a HEALTHY two-hour job has a
     * two-hour-old stamp by construction — that sentence was an instruction to
     * double-run every long job, issued to a runtime with no user in the loop.
     * It also named no boundary, so the model picked a different one each run.
     */
    const description = toolByName('dsul_my_work')!.description;
    expect(description).toMatch(/leave it alone/i);
    expect(description).toMatch(/not a heartbeat/i);
    expect(description).toMatch(/\d+ hours/);
    expect(description).toMatch(/assigned to you/i);
    expect(description).toMatch(/never touch an item assigned to someone else/i);
    // And the taking must go through the refusable call, not just be asserted.
    expect(description).toMatch(/dsul_report_progress/);
  });

  it('tells the worker to report periodically, which is what makes the stamp mean anything', () => {
    const description = toolByName('dsul_report_progress')!.description;
    expect(description).toMatch(/periodically/i);
    expect(description).toMatch(/lastSeenAt/);
    expect(description).toMatch(/refused/i);
  });

  it('sends a progress report to the route that can refuse it', () => {
    // The generic task PATCH verified only account ownership: no assignee
    // check, no precondition, so a late report from a superseded run landed
    // unconditionally over the work that replaced it.
    expect(
      plan('dsul_report_progress', { id: 'i1', status: 'done', lastSeenAt: '2026-08-26T10:00:00.000Z' })
    ).toEqual({
      method: 'POST',
      path: '/api/agent/items/i1/progress',
      body: { aiStatus: 'done', lastSeenAt: '2026-08-26T10:00:00.000Z' },
    });
  });

  it('omits the precondition when the worker has no stamp to send', () => {
    expect(plan('dsul_report_progress', { id: 'i1', status: 'working' })).toEqual({
      method: 'POST',
      path: '/api/agent/items/i1/progress',
      body: { aiStatus: 'working' },
    });
  });
});
