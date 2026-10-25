import { describe, it, expect } from 'vitest';

/**
 * Who ticks off work an agent was handed (lib/agent-finish.ts). Kirby,
 * 2026-10-25: an agent's "done" is its report; the item waits for the user to
 * check the work and tick it, unless they let agents finish it themselves.
 */

import { AGENT_FINISH_REFUSED, readAgentsMayComplete, refuseAgentFinish, ticksOff } from '@/lib/agent-finish';
import { agentFinished } from '@/lib/ai-work';

type Row = Record<string, unknown> | null;
type Err = { code: string } | null;

/** A client answering `items` and `user_settings` reads, one row each. */
function db(tables: { items?: Row; user_settings?: Row; settingsError?: Err }) {
  return {
    from(table: string) {
      const answer =
        table === 'items'
          ? { data: tables.items ?? null, error: null }
          : { data: tables.user_settings ?? null, error: tables.settingsError ?? null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => answer,
      };
      return chain;
    },
  } as never;
}

const yes = () => true;

describe('ticksOff', () => {
  it('reads a completed status as a tick', () => {
    expect(ticksOff({ status: 'completed' }, [])).toBe(true);
    expect(ticksOff({ status: 'pending' }, [])).toBe(false);
  });

  it('reads a date added to the set as a tick, and a set that only shrinks as none', () => {
    expect(ticksOff({ completedDates: ['2026-10-24', '2026-10-25'] }, ['2026-10-24'])).toBe(true);
    expect(ticksOff({ completedDates: [] }, ['2026-10-24'])).toBe(false);
    expect(ticksOff({ completedDates: ['2026-10-24'] }, ['2026-10-24'])).toBe(false);
  });
});

describe('refuseAgentFinish', () => {
  it('refuses a tick on an item handed to an agent', async () => {
    const refusal = await refuseAgentFinish(db({ items: { assignee: 'claude' } }), 'u1', 'i1', yes);
    expect(refusal).toBe(AGENT_FINISH_REFUSED);
    expect(refusal).toMatch(/dsul_report_progress/);
  });

  it('lets an agent tick it when the account allows it', async () => {
    const client = db({ items: { assignee: 'openclaw' }, user_settings: { agents_may_complete: true } });
    expect(await refuseAgentFinish(client, 'u1', 'i1', yes)).toBeNull();
  });

  it('leaves items nobody handed off alone', async () => {
    expect(await refuseAgentFinish(db({ items: { assignee: null } }), 'u1', 'i1', yes)).toBeNull();
    expect(await refuseAgentFinish(db({ items: { assignee: '  ' } }), 'u1', 'i1', yes)).toBeNull();
  });

  it('leaves a write that ticks nothing alone', async () => {
    expect(await refuseAgentFinish(db({ items: { assignee: 'claude' } }), 'u1', 'i1', () => false)).toBeNull();
  });

  it('refuses while the setting cannot be read (085 unapplied)', async () => {
    const client = db({ items: { assignee: 'claude' }, settingsError: { code: '42703' } });
    expect(await refuseAgentFinish(client, 'u1', 'i1', yes)).toBe(AGENT_FINISH_REFUSED);
  });

  it('leaves a missing item to the route', async () => {
    expect(await refuseAgentFinish(db({}), 'u1', 'i1', yes)).toBeNull();
  });
});

describe('readAgentsMayComplete', () => {
  it('is off by default, null before 085', async () => {
    expect(await readAgentsMayComplete(db({ user_settings: null }), 'u1')).toBe(false);
    expect(await readAgentsMayComplete(db({ settingsError: { code: 'PGRST204' } }), 'u1')).toBeNull();
    expect(await readAgentsMayComplete(db({ user_settings: { agents_may_complete: true } }), 'u1')).toBe(true);
  });
});

describe('agentFinished', () => {
  it('holds a done hand-off until the item is ticked', () => {
    expect(agentFinished({ assignee: 'claude', aiStatus: 'done' })).toBe(true);
    expect(agentFinished({ assignee: 'claude', aiStatus: 'done', status: 'completed' })).toBe(false);
    expect(agentFinished({ assignee: 'claude', aiStatus: 'working' })).toBe(false);
    // Prep reads as ready, not finished (agentPrepReady).
    expect(agentFinished({ assignee: 'claude', aiStatus: 'done', aiMode: 'prepare' })).toBe(false);
  });
});
