import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The waiting shimmer's marks (lib/planner-shimmer.ts, app/globals.css): the
 * one thing it may dim is a row title's TEXT, so the mark sits on the element
 * that holds the title and nothing else. An open title takes the band; a
 * title that rests muted (done, set aside, skipped) is marked so and keeps
 * its own ink, so a waiting open row never reads dimmer than a muted one.
 * Inside it, each emoji sits in its own `data-row-emoji` span, which keeps
 * its fill: through the shimmer's clipped ground a colour glyph would be a
 * flat silhouette.
 *
 * Rendered through the real TaskRow and ScheduleBlock on the row-controls
 * harness (row-controls.test.tsx): the planner store hydrated from mocked db
 * reads.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  setItemSkip: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { RowTitleText, splitEmoji } from '@/components/primitives/row-title-text';
import { ScheduleBlock, type TimedEntry } from '@/components/views/day-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, Task, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-07-14';
const store = () => usePlannerStore.getState();

const task = (id: string, extra: Partial<TaskItem> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Title of ${id}`,
    status: 'pending',
    isScheduled: false,
    timeBucket: 'anytime',
    order: 0,
    startDate: TODAY,
    completedDates: [],
    skippedDates: [],
    ...extra,
  }) as Item;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([
    task('open'),
    task('done', { status: 'completed' }),
    task('daily', { repeatFrequency: 'daily', startDate: '2026-07-01', skippedDates: [TODAY] }),
    task('timed', { isScheduled: true, startTime: '10:00', duration: 60, timeBucket: 'morning' }),
    task('timed-done', { isScheduled: true, startTime: '12:00', duration: 60, status: 'completed' }),
    task('emoji', { title: 'Buy 🍋 lemons and 🥑' }),
    task('timed-emoji', { title: '🎂 Order the cake', isScheduled: true, startTime: '14:00', duration: 30 }),
  ]);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Row({ id }: { id: string }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const row: RowItem = { itemType: 'task', item: item as unknown as Task };
  return <TaskRow row={row} />;
}

function Block({ id }: { id: string }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const entry: TimedEntry = { itemType: 'task', item: item as unknown as Task, startMin: 600, duration: 60 };
  return (
    <DndContext>
      <ScheduleBlock entry={entry} gridStartMin={480} hourPx={60} variant="day" fieldWidth={900} />
    </DndContext>
  );
}

/** The one marked element, which holds the title's text and nothing interactive. */
function mark(container: HTMLElement, id: string, text = `Title of ${id}`) {
  const marked = [...container.querySelectorAll('[data-row-title]')];
  expect(marked, 'one mark per row').toHaveLength(1);
  const el = marked[0] as HTMLElement;
  expect(el.textContent).toBe(text);
  expect(el.querySelector('button, input, svg, [role]'), 'nothing but the text').toBeNull();
  return el.getAttribute('data-row-title');
}

describe('row titles carry the shimmer’s mark', () => {
  it('an open row: open', () => {
    const { container } = render(<Row id="open" />);
    expect(mark(container, 'open')).toBe('open');
  });

  it('a done row: muted, so it keeps its own ink', () => {
    const { container } = render(<Row id="done" />);
    expect(mark(container, 'done')).toBe('muted');
  });

  it('a skipped row: muted', () => {
    const { container } = render(<Row id="daily" />);
    expect(mark(container, 'daily')).toBe('muted');
  });

  it('an emoji keeps its own span inside the mark, the title text unchanged', () => {
    const row = render(<Row id="emoji" />);
    expect(mark(row.container, 'emoji', 'Buy 🍋 lemons and 🥑')).toBe('open');
    const title = row.container.querySelector('[data-row-title]')!;
    expect([...title.querySelectorAll('[data-row-emoji]')].map((e) => e.textContent)).toEqual(['🍋', '🥑']);
    row.unmount();
    const block = render(<Block id="timed-emoji" />);
    expect(mark(block.container, 'timed-emoji', '🎂 Order the cake')).toBe('open');
    expect([...block.container.querySelectorAll('[data-row-title] [data-row-emoji]')].map((e) => e.textContent)).toEqual(['🎂']);
  });

  it('a schedule block: open, and muted once done', () => {
    const open = render(<Block id="timed" />);
    expect(mark(open.container, 'timed')).toBe('open');
    open.unmount();
    const done = render(<Block id="timed-done" />);
    expect(mark(done.container, 'timed-done')).toBe('muted');
  });
});

describe('emoji runs in a title', () => {
  const runs = (t: string) => splitEmoji(t).map((r) => (r.emoji ? `[${r.text}]` : r.text)).join('');

  it('wraps each cluster whole: sequences, skin tones, flags, keycaps and tags', () => {
    expect(runs('Buy 🍋 lemons and 🥑')).toBe('Buy [🍋] lemons and [🥑]');
    expect(runs('Family 👨‍👩‍👧 dinner')).toBe('Family [👨‍👩‍👧] dinner');
    expect(runs('👍🏽 ok')).toBe('[👍🏽] ok');
    expect(runs('Trip 🇯🇵🇺🇸')).toBe('Trip [🇯🇵🇺🇸]');
    expect(runs('Keycap 1️⃣ two')).toBe('Keycap [1️⃣] two');
    expect(runs('☀️ walk ❤️‍🔥')).toBe('[☀️] walk [❤️‍🔥]');
    expect(runs('🏴󠁧󠁢󠁳󠁣󠁴󠁿 trip')).toBe('[🏴󠁧󠁢󠁳󠁣󠁴󠁿] trip');
  });

  it('leaves text-style symbols and digits in the ink', () => {
    expect(runs('© 2026 ™, a bare ❤ and #3')).toBe('© 2026 ™, a bare ❤ and #3');
    expect(splitEmoji('')).toEqual([{ text: '', emoji: false }]);
  });

  it('renders a title with no emoji as the bare string', () => {
    const { container } = render(
      <p>
        <RowTitleText text="Plain title" />
      </p>
    );
    expect(container.querySelector('p')!.childNodes).toHaveLength(1);
    expect(container.querySelector('p')!.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  });
});
