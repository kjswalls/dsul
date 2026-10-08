import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The run log and the fault log share mod_runs (lib/recipes/runs.ts,
 * lib/mods/faults-log.ts): runs never show a fault, and Problems shows only
 * faults.
 */

const db = vi.hoisted(() => ({
  calls: [] as [string, unknown[]][][],
  results: [] as { data: unknown; error: unknown }[],
}));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => {
      const ops: [string, unknown[]][] = [];
      db.calls.push(ops);
      const result = db.results.shift() ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'not', 'like', 'order', 'limit', 'insert']) {
        b[op] = (...args: unknown[]) => {
          ops.push([op, args]);
          return b;
        };
      }
      b.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return b;
    },
  }),
}));

import { fetchRecentRuns } from '@/lib/recipes/runs';
import { fetchRecentFaults, logFault } from '@/lib/mods/faults-log';

const MOD = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  db.calls = [];
  db.results = [];
});

describe('fetchRecentRuns', () => {
  it('leaves a mod’s fault rows out in the query, before the limit', async () => {
    await fetchRecentRuns(MOD, 10);
    const ops = db.calls[0].map(([op]) => op);
    expect(db.calls[0]).toContainEqual(['not', ['claim_key', 'like', 'fault:%']]);
    expect(ops.indexOf('not')).toBeLessThan(ops.indexOf('limit'));
  });
});

describe('the fault log', () => {
  it('writes a fault row under a fault: key, clipped to the summary cap', async () => {
    await logFault(USER, MOD, { kind: 'fault', hook: 'command Log', code: 'cpu', message: 'x'.repeat(9000), day: '2026-03-10' });
    const [, args] = db.calls[0].find(([op]) => op === 'insert')!;
    const row = args[0] as { claim_key: string; summary: { message: string } };
    expect(row.claim_key).toMatch(/^fault:[0-9a-f-]{36}$/);
    expect(new TextEncoder().encode(JSON.stringify(row.summary)).length).toBeLessThanOrEqual(4096);
  });

  it('reads back only fault rows, newest first, dropping any other shape', async () => {
    db.results.push({
      data: [
        { summary: { kind: 'fault', hook: 'timer', code: 'wall', message: 'slow', day: 'd' }, at: '2' },
        { summary: { kind: 'fault', hook: 'timer', code: 'writes', message: 'x', day: 'd' }, at: '1' },
        { summary: { kind: 'run' }, at: '0' },
      ],
      error: null,
    });
    const rows = await fetchRecentFaults(MOD);
    expect(rows.map((r) => r.summary.code)).toEqual(['wall']);
    expect(db.calls[0]).toContainEqual(['like', ['claim_key', 'fault:%']]);
  });
});
