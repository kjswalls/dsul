import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_QUIET_AFTER_MS } from '@/lib/agent-status';
import { agentWorking, aiWorkSummary, hasLiveRun, type AiWorkItem } from '@/lib/ai-work';
import type { PrepPack } from '@/lib/prep-packs';

/**
 * The account's reading of the AI's work, for the do stuff key and the dock's
 * line. It is built from the same rules the rows use, so neither can show the
 * relay while every row under it is still, or count a pack the item panel
 * would not show.
 */

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const item = (over: Partial<AiWorkItem> = {}): AiWorkItem => ({ id: 'a', title: 'Email Mara', ...over });
const pack = (itemId: string, madeFor: string): PrepPack => ({
  itemId,
  madeFor,
  updatedAt: ago(0),
  pack: { kind: 'steps', steps: ['Open the invoice', 'Reply with the total'] },
});
const none = { preparing: {}, packs: {} };

describe('agentWorking', () => {
  it('is true for a live run that has not gone quiet', () => {
    expect(agentWorking(item({ assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(60_000) }), NOW)).toBe(true);
    expect(agentWorking(item({ assignee: 'openclaw', aiStatus: 'queued', aiStatusAt: ago(60_000) }), NOW)).toBe(true);
  });

  it('is false once the run has gone quiet, so the relay never claims work nobody is doing', () => {
    const quiet = item({ assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(AGENT_QUIET_AFTER_MS + 1) });
    expect(agentWorking(quiet, NOW)).toBe(false);
  });

  it('is false for a question, a failure, a finished item and an unassigned one', () => {
    expect(agentWorking(item({ assignee: 'openclaw', aiStatus: 'blocked' }), NOW)).toBe(false);
    expect(agentWorking(item({ assignee: 'openclaw', aiStatus: 'failed' }), NOW)).toBe(false);
    expect(agentWorking(item({ assignee: 'openclaw', aiStatus: 'working', status: 'completed' }), NOW)).toBe(false);
    expect(agentWorking(item({ aiStatus: 'working' }), NOW)).toBe(false);
  });
});

describe('hasLiveRun', () => {
  it('only asks for a clock when a handed-off run is live', () => {
    expect(hasLiveRun([item()])).toBe(false);
    expect(hasLiveRun([item({ assignee: 'openclaw', aiStatus: 'blocked' })])).toBe(false);
    expect(hasLiveRun([item({ assignee: 'openclaw', aiStatus: 'working' })])).toBe(true);
  });
});

describe('aiWorkSummary', () => {
  it('works while a prep ask is in flight', () => {
    expect(aiWorkSummary([item()], { preparing: { a: true }, packs: {} }, NOW).working).toBe(true);
    expect(aiWorkSummary([item()], none, NOW).working).toBe(false);
  });

  it('counts packs on open items written for the title they have now', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', title: 'Renamed' }), item({ id: 'c', status: 'completed' })];
    const packs = { a: pack('a', 'Email Mara'), b: pack('b', 'Old title'), c: pack('c', 'Email Mara') };
    expect(aiWorkSummary(items, { preparing: {}, packs }, NOW).ready).toBe(1);
  });

  it('counts what is being worked on, and the questions among what is ready', () => {
    const q: PrepPack = { ...pack('b', 'Email Mara'), pack: { kind: 'question', question: 'Which day?', answers: [] } as never };
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const sum = aiWorkSummary(items, { preparing: { c: true }, packs: { a: pack('a', 'Email Mara'), b: q } }, NOW);
    expect(sum).toEqual({ working: true, workingCount: 1, ready: 2, questions: 1 });
  });

  it('ignores a pack whose item is gone', () => {
    expect(aiWorkSummary([], { preparing: {}, packs: { z: pack('z', 'x') } }, NOW).ready).toBe(0);
  });
});

describe('the badges in the stylesheet', () => {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
  const section = css.slice(css.indexOf('AI work badges'), css.indexOf('The do stuff key: a keycap'));

  it('never fades a tile through opacity: the lime marks stay at full strength', () => {
    expect(section).not.toMatch(/opacity\s*:/);
  });

  it('stops under reduced motion, from the OS and from the app switch', () => {
    expect(section).toMatch(/prefers-reduced-motion: reduce/);
    expect(section).toMatch(/\[data-reduce-motion='true'\] \[data-ai-relay\]/);
    expect(section).toMatch(/\[data-reduce-motion='true'\] \[data-ai-sheen-slow\]/);
  });

  it("shimmers a working row's title off the working mark, not off every relay (the do stuff key has one)", () => {
    expect(section).toMatch(/\[data-row-title='open'\]:has\(~ \[data-ai-working\]\)/);
    expect(section).not.toMatch(/:has\(~ \[data-ai-relay\]\)/);
  });

  it("crosses the dock's ready line once every eight seconds, then rests", () => {
    expect(section).toMatch(/\[data-ai-sheen-slow\][^}]*animation: ai-sheen-slow 8s/);
  });
});

describe('letting a pack go', () => {
  it('can be undone until the delete goes, and never deletes once undone', async () => {
    const { usePrepPacksStore, UNDO_MS } = await import('@/lib/prep-packs-store');
    const { vi } = await import('vitest');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      usePrepPacksStore.setState({ packs: { a: pack('a', 'Email Mara') } });
      const undo = usePrepPacksStore.getState().dismiss('a');
      expect(usePrepPacksStore.getState().packs.a).toBeUndefined();
      undo!();
      expect(usePrepPacksStore.getState().packs.a).toBeDefined();
      vi.advanceTimersByTime(UNDO_MS);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(usePrepPacksStore.getState().dismiss('missing')).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
