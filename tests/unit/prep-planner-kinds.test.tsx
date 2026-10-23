import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
const openDraftedSteps = vi.hoisted(() => vi.fn());
vi.mock('@/components/sidebar/first-steps', () => ({ openDraftedSteps }));

import { PackCard } from '@/components/sidebar/prep-pack';
import { usePlannerStore } from '@/lib/planner-store';
import { answerNotes, usePrepPacksStore } from '@/lib/prep-packs-store';
import { clockLabel, mapHref, packAction, packApplies, packHref, packLabel, PackSchema, type PrepPack } from '@/lib/prep-packs';
import type { Item } from '@/lib/planner-types';

/**
 * The pack kinds that act on the planner (memory/plans/power-mode.md, "Pack
 * kinds that act on the planner"): subtasks, an answer and a time each take
 * one tap, which is one planner action; a place and a pick leave the app only
 * through a link.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the schemas', () => {
  it('parse, label and name their tap', () => {
    const subtasks = PackSchema.parse({ kind: 'subtasks', subtasks: ['Find the box', 'Tape it'] });
    expect(packLabel(subtasks)).toBe('2 subtasks');
    expect(packApplies(subtasks)).toBe(true);
    expect(packAction(subtasks)).toBe('Add subtasks');

    const time = PackSchema.parse({ kind: 'time', time: '15:30', date: '2026-10-22', duration: 45 });
    expect(packLabel(time)).toBe('3:30pm');
    expect(packAction(time)).toBe('Put it on the day');
    expect(clockLabel('09:00')).toBe('9am');
    expect(clockLabel('00:05')).toBe('12:05am');

    const place = PackSchema.parse({ kind: 'place', name: 'Post office', address: '1 High St' });
    expect(packApplies(place)).toBe(false);
    expect(packHref(place)).toBe(mapHref(place));
    expect(packHref(place)).toContain(encodeURIComponent('Post office, 1 High St'));

    expect(packLabel(PackSchema.parse({ kind: 'answer', answer: 'Good until March.' }))).toBe('answer found');
  });

  it('refuse a bad time, and drop a bad date or duration while keeping the time', () => {
    expect(PackSchema.safeParse({ kind: 'time', time: '25:00' }).success).toBe(false);
    const kept = PackSchema.parse({ kind: 'time', time: '08:15', date: 'tomorrow', duration: 9999 });
    expect(kept).toMatchObject({ kind: 'time', time: '08:15' });
    expect(kept).not.toHaveProperty('date', 'tomorrow');
    expect((kept as { duration?: number }).duration).toBeUndefined();
  });

  it("refuse a pick that recommends a choice it doesn't have", () => {
    const pick = (recommended: number) => ({
      kind: 'pick',
      choices: [{ name: 'A' }, { name: 'B' }],
      recommended,
      why: 'Cheaper.',
    });
    expect(PackSchema.safeParse(pick(1)).success).toBe(true);
    expect(PackSchema.safeParse(pick(2)).success).toBe(false);
  });
});

function mount(pack: PrepPack['pack'], over: Record<string, unknown> = {}) {
  const stored: PrepPack = { itemId: 'a', madeFor: 'Sort the move', updatedAt: '2026-10-21T12:00:00.000Z', pack };
  const task = { type: 'task', id: 'a', title: 'Sort the move', status: 'pending', isScheduled: false, order: 0, ...over } as Item;
  const addTasksBulk = vi.fn();
  const updateTask = vi.fn();
  usePlannerStore.setState({ items: [task], goals: [], userTimezone: 'UTC', addTasksBulk, updateTask } as never);
  usePrepPacksStore.setState({ packs: { a: stored }, available: true, preparing: {}, tried: {} });
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<PackCard itemId="a" title="Sort the move" stored={stored} onClose={() => {}} />);
  return { addTasksBulk, updateTask, fetchMock };
}

describe('one tap', () => {
  it('shows subtasks as a glance, and opens them in the item rather than adding them', () => {
    const { addTasksBulk } = mount({ kind: 'subtasks', subtasks: ['Book a van', 'Get boxes'] });
    // Steps are drafted rows in the item's Subtasks now (drafted-steps.tsx): no textarea here.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('prep-pack-steps').textContent).toContain('Book a van');
    expect(screen.getByTestId('prep-pack-primary').textContent).toBe('Open in the item');
    fireEvent.click(screen.getByTestId('prep-pack-primary'));
    expect(openDraftedSteps).toHaveBeenCalledWith('a');
    expect(addTasksBulk).not.toHaveBeenCalled();
    expect(usePrepPacksStore.getState().packs.a).toBeDefined();
  });

  it('keeps the answer and its sources in the notes', () => {
    const { updateTask } = mount(
      { kind: 'answer', answer: 'Your passport is good until March.', sources: [{ title: 'Gov', url: 'https://gov.example/passport' }] },
      { notes: 'check expiry' }
    );
    fireEvent.click(screen.getByTestId('prep-pack-primary'));
    expect(updateTask).toHaveBeenCalledWith(
      'a',
      { notes: 'check expiry\n\nYour passport is good until March.\nhttps://gov.example/passport' },
      expect.anything()
    );
    expect(answerNotes(undefined, ' Yes. ')).toBe('Yes.');
  });

  it('puts the item on the day at its time, today when the pack names no day', () => {
    const { updateTask } = mount({ kind: 'time', time: '16:00', duration: 30 });
    fireEvent.click(screen.getByTestId('prep-pack-primary'));
    const [, patch] = updateTask.mock.calls[0];
    expect(patch).toMatchObject({ isScheduled: true, startTime: '16:00', duration: 30, timeBucket: 'afternoon' });
    expect(patch.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves a goal milestone's target date alone", () => {
    const { updateTask } = mount({ kind: 'time', time: '10:00', date: '2026-10-23' });
    usePlannerStore.setState({ goals: [{ id: 'g', milestoneIds: ['a'] }] } as never);
    fireEvent.click(screen.getByTestId('prep-pack-primary'));
    const [, patch] = updateTask.mock.calls[0];
    expect(patch.startTime).toBe('10:00');
    expect(patch).not.toHaveProperty('startDate');
  });
});

describe('the prompt and the database', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/ai/prep/route.ts'), 'utf8');
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/080_prep_planner_kinds.sql'), 'utf8');
  it('names every new kind to the model, and lets a sourced number into a call', () => {
    for (const kind of ['subtasks', 'answer', 'place', 'time', 'pick']) {
      expect(route).toContain(`"kind": "${kind}"`);
      expect(sql).toContain(`'${kind}'`);
    }
    expect(route).toMatch(/"number" may come from a page you list in "sources"/);
    expect(sql).toMatch(/if exists \(select 1 from pg_constraint where conname = 'prep_packs_kind_check'\)/);
  });
});
