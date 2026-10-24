import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { QuestionRound, questionsWaiting } from '@/components/sidebar/question-round';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import type { PrepPack } from '@/lib/prep-packs';
import type { Item } from '@/lib/planner-types';

/**
 * The quick round (Kirby's pick D, 2026-10-23): the AI's questions one card at
 * a time; an answer sends its item back to be prepared and deals the next.
 */

const q = (itemId: string, madeFor: string, question: string, at: string): PrepPack => ({
  itemId,
  madeFor,
  updatedAt: at,
  pack: { kind: 'question', question, options: ['Yes', 'No'] },
});
const task = (id: string, title: string, status = 'pending') =>
  ({ type: 'task', id, title, status, isScheduled: false, order: 0 }) as Item;

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the quick round', () => {
  it('takes only fresh questions on open items, oldest first', () => {
    const packs = {
      a: q('a', 'hang up trip map', 'Poster?', '2026-10-23T02:00:00Z'),
      b: q('b', 'plan trip', 'Dates set?', '2026-10-23T01:00:00Z'),
      c: q('c', 'old title', 'Stale?', '2026-10-23T00:00:00Z'),
      d: q('d', 'done one', 'Done?', '2026-10-23T00:00:00Z'),
      e: { ...q('e', 'email', 'x', '2026-10-23T00:00:00Z'), pack: { kind: 'steps', steps: ['a', 'b'] } } as PrepPack,
    };
    const items = [task('a', 'hang up trip map'), task('b', 'plan trip'), task('c', 'new title'), task('d', 'done one', 'completed'), task('e', 'email')];
    expect(questionsWaiting(items, packs).map((w) => w.itemId)).toEqual(['b', 'a']);
  });

  it('deals the next question once one is answered', () => {
    const packs = {
      a: q('a', 'hang up trip map', 'What kind of map is it?', '2026-10-23T01:00:00Z'),
      b: q('b', 'plan trip', 'Are the dates set?', '2026-10-23T02:00:00Z'),
    };
    const updateTask = vi.fn();
    usePlannerStore.setState({ items: [task('a', 'hang up trip map'), task('b', 'plan trip')], userTimezone: 'UTC', updateTask } as never);
    usePrepPacksStore.setState({ packs, available: true, preparing: {}, tried: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ packs: [] }), { status: 200 })));
    render(<QuestionRound onClose={() => {}} />);
    expect(screen.getByText('What kind of map is it?')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Yes')[0]);
    fireEvent.click(screen.getByTestId('prep-pack-submit'));
    expect(updateTask).toHaveBeenCalledWith('a', { notes: 'What kind of map is it? Yes' }, expect.anything());
    expect(screen.getByText('Are the dates set?')).toBeTruthy();
  });

  it('says so when nothing is left to answer', () => {
    usePlannerStore.setState({ items: [] } as never);
    usePrepPacksStore.setState({ packs: {} });
    render(<QuestionRound onClose={() => {}} />);
    expect(screen.getByTestId('question-round-done')).toBeTruthy();
  });
});
