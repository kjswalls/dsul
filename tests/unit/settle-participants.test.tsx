import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The settle's participants, mounted (design §9.2).
 *
 * lib/settle.ts finds what to animate by attribute alone — `data-settle-key`,
 * `data-settle-role="frame"`, a row's `data-item-id` and its signature
 * attributes — and settle-conductor.test.tsx drives it over hand-built
 * fixtures. What only a mount can show is that the REAL views carry those
 * attributes, in the shapes the conductor assumes:
 *
 *  - a row's key is `${its day}|${its id}` in every view and both variants
 *    (the braindump, which has no day, keys on the id alone), so the same
 *    habit in seven week columns is seven rows, never one key seven times;
 *  - every row says which item it is, so a row whose key changed can still be
 *    paired;
 *  - a frame's key, qualified the way settle.ts qualifies it, is unique in its
 *    scope with no dedupe needed — a `#2` in normal use would pair the wrong
 *    boxes the moment the duplicates' order differed;
 *  - nothing interpolates a missing value into a key;
 *  - a row's first drawn text starts its title, inside the title element
 *    that holds the whole of it (an emoji sits in a span of its own), which
 *    is what a type-in paces itself to (lib/settle.ts textEndX), and a
 *    schedule block draws its surface on one plate of its own
 *    (`data-settle-plate`), which a lift makes solid in place of a ground.
 */

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { Braindump } from '@/components/sidebar/braindump';
import { DayList } from '@/components/views/day-list';
import { WeekList } from '@/components/views/week-list';
import { DayBuckets } from '@/components/views/day-buckets';
import { WeekBuckets } from '@/components/views/week-buckets';
import { DaySchedule } from '@/components/views/day-schedule';
import { WeekSchedule } from '@/components/views/week-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { HabitItem, Project, Task } from '@/lib/planner-types';

const TZ = 'UTC';
/** A Thursday, and today: the clock is pinned inside it so both now-markers draw. */
const D = '2026-08-13';
/** The week around it, Sunday-first (weekStartDay below). */
const WEEK = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

const task = (over: Partial<Task>): Task =>
  ({ status: 'pending', isScheduled: true, order: 0, startDate: D, ...over }) as Task;

const habit = (over: Partial<HabitItem>): HabitItem =>
  ({
    project: 'Health',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    repeatFrequency: 'daily',
    ...over,
  }) as HabitItem;

const TASKS: Task[] = [
  // Emoji in a title split it into several nodes (components/primitives/row-title-text.tsx):
  // leading, trailing, and leading in the braindump.
  task({ id: 't-timed', title: '🏋️ Timed', startTime: '09:00', duration: 60, timeBucket: 'morning' }),
  task({ id: 't-loose', title: 'Loose ✍🏽', timeBucket: 'afternoon', project: 'Work' }),
  task({ id: 't-dump', title: '🎂 Dumped', isScheduled: false, startDate: undefined }),
];
const HABITS: HabitItem[] = [
  // Every day of the week: seven week-view rows that must never share a key.
  habit({ id: 'h-daily', title: 'Daily', timeBucket: 'morning' }),
  // Skipped today: the slim variant, as a list row and as a grid block.
  habit({ id: 'h-skip', title: 'Skipped', timeBucket: 'evening', startTime: '18:00', skippedDates: [D] }),
];
const PROJECTS: Project[] = [
  // A recurring block: a ProjectBlock frame in both bucket views.
  {
    id: 'p1',
    name: 'Work',
    emoji: '💼',
    startTime: '07:00',
    duration: 60,
    timeBucket: 'morning',
    repeatFrequency: 'daily',
  } as Project,
];

function seed() {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: new Date(`${D}T12:00:00Z`),
    weekStartDay: 'sunday',
    navDirection: null,
    tasks: TASKS,
    habits: HABITS,
    items: [...TASKS, ...HABITS] as never,
    projects: PROJECTS,
    routines: [],
    seasons: [],
    goals: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
    showCurrentTimeIndicator: true,
  });
  useViewStore.setState({
    // Grouped, so the list views draw GroupSection frames with a groupKey.
    canvasGroupBy: 'project',
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
}

/** Mounted the way the routers mount them: inside a settle scope. */
const inCanvas = (view: React.ReactElement) => (
  <div data-settle-scope="canvas" style={{ display: 'contents' }}>
    {view}
  </div>
);

const KEY = '[data-settle-key]';
const FRAME = '[data-settle-role="frame"]';

/** The key settle.ts resolves for `el` (lib/settle.ts resolveScope), before any `#n`. */
function qualified(el: Element, scope: Element): string {
  const raw = el.getAttribute('data-settle-key') ?? '';
  if (el.getAttribute('data-settle-role') !== 'frame') return raw;
  const outer = el.parentElement?.closest(FRAME);
  const prefix =
    (outer && scope.contains(outer) ? qualified(outer, scope) : '') ||
    el.closest('[data-date]')?.getAttribute('data-date') ||
    '';
  return `${prefix}/${raw}`;
}

/** [raw key, role, how many] — every participant this fixture must draw. */
type Expected = [key: string, role: 'row' | 'frame', count?: number];

const rowsOf = (ids: string[], dates: string[] = [D]): Expected[] =>
  ids.flatMap((id) => dates.map((d): Expected => [`${d}|${id}`, 'row']));

const VIEWS: [name: string, ui: () => React.ReactElement, expected: Expected[]][] = [
  [
    'Day × List',
    () => inCanvas(<DayList />),
    [
      ...rowsOf(['t-timed', 't-loose', 'h-daily', 'h-skip']),
      ['group:project:Work', 'frame'],
      ['group:project:Health', 'frame'],
    ],
  ],
  [
    'Week × List',
    () => inCanvas(<WeekList />),
    [
      ...WEEK.map((d): Expected => [`day:${d}`, 'frame']),
      ...rowsOf(['h-daily', 'h-skip'], WEEK),
      ...rowsOf(['t-timed', 't-loose']),
    ],
  ],
  [
    'Day × Schedule',
    () => inCanvas(<DaySchedule activeId={null} />),
    [
      ...rowsOf(['t-timed', 'h-skip', 't-loose', 'h-daily']),
      ['grid', 'frame'],
      ['hour:9', 'frame'],
      ['hour:18', 'frame'],
      ['now', 'frame'],
      ['gutter-now', 'frame'],
    ],
  ],
  [
    'Week × Schedule',
    () => inCanvas(<WeekSchedule activeId={null} />),
    [
      ...rowsOf(['h-daily', 'h-skip'], WEEK),
      ...rowsOf(['t-timed', 't-loose']),
      ['grid', 'frame', 7],
      ['hour:9', 'frame', 7],
      ['now', 'frame'],
      ['gutter', 'frame'],
      ['gutter-hour:9', 'frame'],
      ['gutter-now', 'frame'],
    ],
  ],
  [
    'Day × Buckets',
    () => inCanvas(<DayBuckets activeId={null} />),
    [
      ...rowsOf(['t-timed', 't-loose', 'h-daily', 'h-skip']),
      ['bucket:morning', 'frame'],
      ['bucket:afternoon', 'frame'],
      ['bucket:evening', 'frame'],
      ['project:p1', 'frame'],
    ],
  ],
  [
    'Week × Buckets',
    () => inCanvas(<WeekBuckets activeId={null} />),
    [
      ...rowsOf(['h-daily', 'h-skip'], WEEK),
      ...rowsOf(['t-timed', 't-loose']),
      ['bucket:morning', 'frame', 7],
      ['project:p1', 'frame', 7],
    ],
  ],
  [
    'Braindump',
    () => <Braindump />,
    [
      ['|t-dump', 'row'],
      ['braindump:quickadd', 'frame'],
    ],
  ],
];

/** What the conductor reads into a row's change signature (lib/settle.ts SIG_ATTRS). */
const SIG_ATTRS = [
  'data-row-variant',
  'data-completed',
  'data-suppressed',
  'data-bucket',
  'data-start-time',
  'data-start-min',
  'data-duration',
];

describe('settle participants', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${D}T10:30:00Z`));
    seed();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe.each(VIEWS)('%s', (_name, ui, expected) => {
    const mount = () => {
      render(<DndContext>{ui()}</DndContext>);
      const scope = document.querySelector('[data-settle-scope]');
      if (!scope) throw new Error('no settle scope mounted');
      return scope;
    };

    it('keys every participant with its role', () => {
      const scope = mount();
      for (const [key, role, count = 1] of expected) {
        const found = [...scope.querySelectorAll(`[data-settle-key="${CSS.escape(key)}"]`)];
        expect(found, key).toHaveLength(count);
        for (const el of found) {
          expect(el.getAttribute('data-settle-role'), key).toBe(role === 'frame' ? 'frame' : null);
        }
      }
    });

    it('interpolates nothing missing, and every row says which item it is', () => {
      const scope = mount();
      const all = [...scope.querySelectorAll<HTMLElement>(KEY)];
      expect(all.length).toBeGreaterThan(0);
      for (const el of all) {
        const key = el.getAttribute('data-settle-key')!;
        expect(key, key).not.toMatch(/undefined|null|NaN|\[object/);
        expect([null, 'frame']).toContain(el.getAttribute('data-settle-role'));
        // A real box: settle.ts reads its rect and animates it.
        expect(el.classList.contains('contents'), key).toBe(false);
        expect(el.style.display, key).not.toBe('contents');
        if (el.getAttribute('data-settle-role') === 'frame') continue;
        const id = el.getAttribute('data-item-id');
        expect(id, key).toBeTruthy();
        expect(key).toMatch(new RegExp(`^(\\d{4}-\\d{2}-\\d{2})?\\|${id}$`));
      }
    });

    it("a row's first drawn text starts its title, in the element that holds all of it: what a type-in paces to", () => {
      const scope = mount();
      const titles = new Map<string, string>([...TASKS, ...HABITS].map((it) => [it.id, it.title]));
      const rows = [...scope.querySelectorAll<HTMLElement>(`${KEY}:not(${FRAME})`)];
      expect(rows.length).toBeGreaterThan(0);
      for (const el of rows) {
        const key = el.getAttribute('data-settle-key')!;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let first: Text | null = null;
        for (let n = walker.nextNode(); n && first === null; n = walker.nextNode()) {
          if ((n as Text).data.trim() !== '') first = n as Text;
        }
        const title = titles.get(el.getAttribute('data-item-id')!)!;
        expect(first, key).not.toBeNull();
        expect(title.startsWith(first!.data), key).toBe(true);
        // textEndX measures this element whole, so an emoji's span never cuts the title short.
        const holder = first!.parentElement!.closest('[data-row-title]');
        expect(holder && el.contains(holder), key).toBe(true);
        expect(holder!.textContent, key).toBe(title);
      }
    });

    it('needs no dedupe: each resolved key is unique in its scope', () => {
      const scope = mount();
      const keys = [...scope.querySelectorAll(KEY)]
        .filter((el) => el.closest('[data-settle-scope]') === scope)
        .map((el) => qualified(el, scope));
      const repeated = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect(repeated).toEqual([]);
    });
  });

  it('a skipped occurrence keeps its key as it changes shape, row and block alike', () => {
    render(
      <DndContext>
        {inCanvas(
          <>
            <DayList />
            <DaySchedule activeId={null} />
          </>
        )}
      </DndContext>
    );
    const skipped = [...document.querySelectorAll(`[data-settle-key="${D}|h-skip"]`)];
    expect(skipped.map((el) => el.getAttribute('data-testid')).sort()).toEqual(['item-card', 'schedule-block']);
    for (const el of skipped) expect(el).toHaveAttribute('data-row-variant', 'skipped');
  });

  it('a schedule block draws its surface on one plate of its own, live and skipped alike; a list row on itself', () => {
    render(
      <DndContext>
        {inCanvas(
          <>
            <DayList />
            <DaySchedule activeId={null} />
          </>
        )}
      </DndContext>
    );
    const blocks = [...document.querySelectorAll<HTMLElement>('[data-testid="schedule-block"]')];
    expect(blocks.map((b) => b.getAttribute('data-row-variant'))).toEqual(expect.arrayContaining(['default', 'skipped']));
    for (const b of blocks) {
      const plates = [...b.querySelectorAll('[data-settle-plate]')].filter((p) => p.closest(KEY) === b);
      expect(plates, b.getAttribute('data-settle-key')!).toHaveLength(1);
    }
    const rows = [...document.querySelectorAll('[data-testid="item-card"]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.querySelector('[data-settle-plate]')).toBeNull();
  });

  it('every attribute the change signature reads is written by some row', () => {
    // A signature attribute no row carries would read '' on both sides forever:
    // a change the conductor believes it watches and never sees.
    render(
      <DndContext>
        {inCanvas(
          <>
            <DayList />
            <DaySchedule activeId={null} />
          </>
        )}
      </DndContext>
    );
    const rows = [...document.querySelectorAll(`${KEY}:not(${FRAME})`)];
    for (const attr of SIG_ATTRS) {
      expect(
        rows.some((el) => el.hasAttribute(attr)),
        attr
      ).toBe(true);
    }
  });
});
