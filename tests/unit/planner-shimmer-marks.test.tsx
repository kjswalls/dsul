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
  const runs = (t: string, segmenter?: Intl.Segmenter | null) =>
    splitEmoji(t, segmenter).map((r) => (r.emoji ? `[${r.text}]` : r.text)).join('');
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const ZWJ = 0x200d;
  const VS16 = 0xfe0f;
  const TONE = 0x1f3fd;
  /**
   * Titles whose emoji are easy to cut in two: a text-default base with a skin
   * tone and no selector (what the iOS keyboard types for ✍🏽 and 🏋🏽‍♀️),
   * minimally qualified ZWJ sequences, a ZWJ after a text-default base.
   */
  const TRICKY: [title: string, wrapped: string][] = [
    [`${cp(0x270d, TONE)} Journal`, `[${cp(0x270d, TONE)}] Journal`],
    [`${cp(0x1f3cb, TONE, ZWJ, 0x2640, VS16)} Gym`, `[${cp(0x1f3cb, TONE, ZWJ, 0x2640, VS16)}] Gym`],
    [`${cp(0x1f3cb, TONE)} Gym`, `[${cp(0x1f3cb, TONE)}] Gym`],
    [`${cp(0x270c, TONE)} peace`, `[${cp(0x270c, TONE)}] peace`],
    [`${cp(0x261d, 0x1f3fe)} up`, `[${cp(0x261d, 0x1f3fe)}] up`],
    [`${cp(0x1f590, 0x1f3fc)} hi`, `[${cp(0x1f590, 0x1f3fc)}] hi`],
    [`${cp(0x1f575, 0x1f3fb)} spy`, `[${cp(0x1f575, 0x1f3fb)}] spy`],
    [`${cp(0x26f9, TONE)} ball`, `[${cp(0x26f9, TONE)}] ball`],
    [`Pride ${cp(0x1f3f3, ZWJ, 0x1f308)}`, `Pride [${cp(0x1f3f3, ZWJ, 0x1f308)}]`],
    [`${cp(0x1f441, ZWJ, 0x1f5e8)} eye`, `[${cp(0x1f441, ZWJ, 0x1f5e8)}] eye`],
    [`Love ${cp(0x2764, ZWJ, 0x1f525)}`, `Love [${cp(0x2764, ZWJ, 0x1f525)}]`],
    [`Code ${cp(0x1f9d1, TONE, ZWJ, 0x1f4bb)}`, `Code [${cp(0x1f9d1, TONE, ZWJ, 0x1f4bb)}]`],
  ];

  it('never cuts an emoji in two: a skin tone or a join stays with a text-default base', () => {
    for (const [title, wrapped] of TRICKY) expect(runs(title), title).toBe(wrapped);
  });

  it('cuts only at grapheme boundaries, with or without Intl.Segmenter, alike', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const corpus = [
      ...TRICKY.map(([t]) => t),
      'Buy 🍋 lemons and 🥑',
      'Family 👨‍👩‍👧 dinner',
      '👍🏽 ok',
      'Trip 🇯🇵🇺🇸',
      'Keycap 1️⃣ two',
      '☀️ walk ❤️‍🔥',
      '🏴󠁧󠁢󠁳󠁣󠁴󠁿 trip',
      '© 2026 ™, a bare ❤ and #3',
      'Call mom 📞',
      'a😀b',
      `Gym ${cp(TONE)}`,
      `Caf${cp(0x65, 0x301)} 🎂`,
    ];
    for (const title of corpus) {
      const bounds = new Set([0]);
      let at = 0;
      for (const g of segmenter.segment(title)) bounds.add((at += g.segment.length));
      for (const segment of [segmenter, null]) {
        const parts = splitEmoji(title, segment);
        expect(parts.map((r) => r.text).join(''), title).toBe(title);
        let end = 0;
        for (const part of parts) {
          end += part.text.length;
          expect(bounds.has(end), `${title}: a cut at ${end}`).toBe(true);
        }
      }
      expect(runs(title, null), title).toBe(runs(title, segmenter));
    }
  });

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
