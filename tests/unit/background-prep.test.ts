import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentCandidates,
  backgroundPrepOn,
  backgroundPrepWorker,
  DAILY_CAP,
  ledgerFor,
  prepCandidates,
  prepSignature,
  recordAsked,
  remainingToday,
} from '@/lib/background-prep';
import { agentPrepReady, aiWorkSummary } from '@/lib/ai-work';
import { canHandOff } from '@/lib/agent-handoff';
import { answerNote, PackSchema, packFromRow, packLabel } from '@/lib/prep-packs';
import type { Item } from '@/lib/planner-types';

/**
 * Background prep (lib/background-prep.ts): prep only, each item once until it
 * changes, a daily cap, off by default, and "Hand off to…" still gives the
 * whole job.
 */

const TODAY = '2026-10-20';
const task = (over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: 'a', title: 'Email Mara', status: 'pending', isScheduled: false, order: 0, ...over }) as Item;
const none = new Set<string>();
const ctx = (over: Partial<Parameters<typeof prepCandidates>[1]> = {}) => ({
  todayStr: TODAY,
  inactiveIds: none,
  hasPack: () => false,
  ledger: ledgerFor(null, TODAY),
  ...over,
});

describe('the setting', () => {
  it('is off until the person turns it on, and the model does the work unless they pick an agent', () => {
    expect(backgroundPrepOn(undefined)).toBe(false);
    expect(backgroundPrepOn({ background: 'true' })).toBe(false);
    expect(backgroundPrepOn({ background: true })).toBe(true);
    expect(backgroundPrepWorker(undefined)).toBe('model');
    expect(backgroundPrepWorker({ backgroundWorker: 'agent' })).toBe('agent');
  });

  it('is declared off in the settings manifest', () => {
    const src = readFileSync(join(process.cwd(), 'lib/settings/manifest.ts'), 'utf8');
    const record = src.slice(src.indexOf("id: 'extensions.doStuff.background'"));
    expect(record.slice(0, record.indexOf('},\n  {'))).toMatch(/defaultValue: false/);
  });
});

describe('who is a candidate', () => {
  it("takes today's tasks first, then the braindump's", () => {
    const items = [task({ id: 'dump' }), task({ id: 'today', startDate: TODAY, isScheduled: true })];
    expect(prepCandidates(items, ctx()).map((i) => i.id)).toEqual(['today', 'dump']);
  });

  it('leaves out anything done, repeating, a subtask, held, paused, packed, or on another day', () => {
    const items = [
      task({ id: 'done', status: 'completed' }),
      task({ id: 'gone', status: 'cancelled' }),
      task({ id: 'repeat', repeatFrequency: 'daily' }),
      task({ id: 'child', parentItemId: 'x' }),
      task({ id: 'held', assignee: 'openclaw' }),
      task({ id: 'paused' }),
      task({ id: 'packed' }),
      task({ id: 'later', startDate: '2026-10-25' }),
      { type: 'habit', id: 'habit', title: 'Walk' } as unknown as Item,
    ];
    const got = prepCandidates(items, ctx({ inactiveIds: new Set(['paused']), hasPack: (i) => i.id === 'packed' }));
    expect(got).toEqual([]);
  });

  it('asks about an item once until its title or notes change', () => {
    const item = task({ notes: 'about the invoice' });
    const ledger = recordAsked(ledgerFor(null, TODAY), [item]);
    expect(prepCandidates([item], ctx({ ledger }))).toEqual([]);
    const answered = task({ notes: answerNote('about the invoice', 'Which invoice?', 'March') });
    expect(prepCandidates([answered], ctx({ ledger }))).toHaveLength(1);
    expect(prepSignature(answered)).not.toBe(prepSignature(item));
  });
});

describe('the daily cap', () => {
  it('counts every ask and starts again the next day, never forgetting what was asked', () => {
    const items = Array.from({ length: DAILY_CAP }, (_, n) => task({ id: `t${n}` }));
    const spent = recordAsked(ledgerFor(null, TODAY), items);
    expect(remainingToday(spent)).toBe(0);
    const tomorrow = ledgerFor(spent, '2026-10-21');
    expect(remainingToday(tomorrow)).toBe(DAILY_CAP);
    expect(tomorrow.asked.t0).toBe(prepSignature(items[0]));
  });
});

describe('the agent half', () => {
  it("offers the agent only what its own queue would serve", () => {
    const items = [task({ id: 'ok' }), task({ id: 'off' })];
    expect(agentCandidates(items, { todayStr: TODAY, inactiveIds: new Set(['off']) }).map((i) => i.id)).toEqual(['ok']);
  });

  it('reads a finished get-it-ready hand-off as ready, and counts it', () => {
    const prepared = { id: 'a', title: 'Email Mara', assignee: 'openclaw', aiStatus: 'done', aiMode: 'prepare' };
    expect(agentPrepReady(prepared)).toBe(true);
    expect(agentPrepReady({ ...prepared, aiMode: undefined })).toBe(false);
    expect(agentPrepReady({ ...prepared, status: 'completed' })).toBe(false);
    expect(aiWorkSummary([prepared], { preparing: {}, packs: {} }, Date.now()).ready).toBe(1);
  });

  it('lets "Hand off to…" give the whole job once the prep is over, never while it runs', () => {
    const hctx = { canDelegate: true, todayStr: TODAY, inactiveIds: none };
    expect(canHandOff(task({ assignee: 'openclaw', aiMode: 'prepare', aiStatus: 'done' }), hctx)).toBe(true);
    expect(canHandOff(task({ assignee: 'openclaw', aiMode: 'prepare', aiStatus: 'working' }), hctx)).toBe(false);
    expect(canHandOff(task({ assignee: 'openclaw', aiStatus: 'done' }), hctx)).toBe(false);
  });

  it('tells an MCP agent what prepare means', () => {
    const src = readFileSync(join(process.cwd(), 'lib/mcp/tools.ts'), 'utf8');
    expect(src).toMatch(/aiMode 'prepare'/);
    expect(src).toMatch(/Never send, book, buy, pay, submit, post or delete/);
  });
});

describe('question packs', () => {
  it('parse, label and round-trip', () => {
    const parsed = PackSchema.safeParse({ kind: 'question', question: 'Which invoice?', options: ['March', 'April'] });
    expect(parsed.success).toBe(true);
    const row = packFromRow({
      item_id: 'a',
      kind: 'question',
      body: { question: 'Which invoice?', options: ['March', 'April'] },
      made_for: 'Email Mara',
      updated_at: '2026-10-20T12:00:00.000Z',
    });
    expect(row?.pack.kind).toBe('question');
    expect(packLabel(row!.pack)).toBe('1 question');
  });

  it('keep the question with its answer in the notes', () => {
    expect(answerNote(undefined, 'Which invoice?', 'March')).toBe('Which invoice? March');
    expect(answerNote('Ask about the total\n', 'Which invoice?', ' March ')).toBe('Ask about the total\nWhich invoice? March');
  });
});

describe('migration 078', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/078_prep_questions_and_ai_mode.sql'), 'utf8');
  it('adds the question kind and a prepare-only mode, safely re-runnable', () => {
    expect(sql).toMatch(/'question'/);
    expect(sql).toMatch(/add column if not exists ai_mode text/);
    expect(sql).toMatch(/ai_mode in \('prepare'\)/);
    expect(sql).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'items_ai_mode_check'\)/);
  });
});
