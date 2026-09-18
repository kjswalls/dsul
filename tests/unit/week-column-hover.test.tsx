import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DndContext } from '@dnd-kit/core';

/**
 * Week day-column emphasis: hovering one day recedes the other six, and the
 * recede is spelled in tokens rather than in opacity.
 *
 * Week × Schedule used to render `!selected && 'opacity-60 hover:opacity-100'`,
 * so six days out of seven were faded whether or not the pointer was anywhere
 * near the grid; Week × Buckets did the same thing per-element on its header.
 * Both were replaced by a `hover:bg-accent` wash on the hovered column, which
 * read as a second selection mark beside the lime header pill — so the recede
 * is back, keyed to the POINTER this time, and spelled the one way that is
 * available to it.
 *
 * Not `opacity` on the siblings, which is the bug this suite mostly exists to
 * keep from coming back: a column opacity composites everything inside it, and
 * an ordinary Tuesday is full of lime — the accent rail and start bead of every
 * project-less scheduled block, the completion checkbox of every done row, the
 * multi-select marks, and any project whose name hashes to --accent-8.
 * CLAUDE.md: the accent never fades through a parent's opacity. A filter or a
 * scrim dims lime the same way, so those are out too.
 *
 * What is in: a non-hovered column re-points the NEUTRAL half of the palette
 * (ink, surfaces, hairlines) at receded twins, and leaves every chromatic token
 * alone. The first invariant below is checked the only way that survives a
 * rewrite of the mechanism — mount the real views with real lime in an ordinary
 * column, find the accent marks, and walk up from each one asserting no
 * ancestor fades; the rest read the rule itself out of globals.css.
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
  setItemCompletion: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  fetchPrograms: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { WeekBuckets } from '@/components/views/week-buckets';
import { WeekList } from '@/components/views/week-list';
import { WeekSchedule } from '@/components/views/week-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import { toDateStr } from '@/lib/recurrence';
import type { Task } from '@/lib/planner-types';

const TZ = 'UTC';
/** A Thursday in a week that holds no "today", so every column is an ordinary one. */
const DATE_STR = '2026-08-13';
const DATE = new Date(`${DATE_STR}T12:00:00Z`);
/** Tuesday of the same week — neither the selected column nor today. */
const PLAIN_STR = '2026-08-11';

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: PLAIN_STR,
    timeBucket: 'morning',
    duration: 60,
    ...over,
  }) as Task;

/**
 * Everything lime an ordinary column can hold, all of it filed on PLAIN_STR:
 *   - a project-LESS timed task, whose block rail and start bead are
 *     `var(--primary)` (day-schedule's `accent` fallback);
 *   - a completed untimed task, whose checkbox is `border-primary bg-primary`
 *     with a `text-primary-foreground` tick inside it.
 * Neither needs a setting turned on beyond showCompletedTasks, which is on by
 * default.
 */
const limeTasks: Task[] = [
  task({ id: 'timed', title: 'Unfiled block', startTime: '09:00' }),
  task({ id: 'done', title: 'Finished thing', status: 'completed', isScheduled: false }),
];

type PlannerState = Parameters<typeof usePlannerStore.setState>[0];

function seed(over: Partial<PlannerState> = {}) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: DATE,
    weekStartDay: 'sunday',
    navDirection: null,
    tasks: limeTasks,
    habits: [],
    items: limeTasks as never,
    projects: [],
    routines: [],
    programs: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
    showCurrentTimeIndicator: false,
    ...over,
  });
  useViewStore.setState({
    canvasGroupBy: 'none',
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
}

const mount = (ui: React.ReactElement) => render(<DndContext>{ui}</DndContext>);

const columnViews = () => [
  ['Week × Schedule', <WeekSchedule key="ws" activeId={null} />] as const,
  ['Week × Buckets', <WeekBuckets key="wb" activeId={null} />] as const,
];

const columns = (root: ParentNode) =>
  [...root.querySelectorAll('[data-testid="week-column"]')] as HTMLElement[];

/**
 * Does this element paint an accent — lime (--primary / --success-text) or a
 * colour off the user-content ramp, one rung of which (--accent-8) IS lime?
 * Matches both the utility spelling and the `var()` spelling, in class names and
 * in inline styles, because the views use all four.
 */
const ACCENT =
  /(?:^|[\s:[(])(?:bg|text|border|ring|fill|stroke|shadow|from|via|to)-primary\b|var\(--primary\)|var\(--accent-\d|text-success-text|--blk-mk/;

const paintsAccent = (el: HTMLElement) =>
  ACCENT.test(el.className || '') || ACCENT.test(el.getAttribute('style') ?? '');

/**
 * The opacity this element applies to itself AND to everything under it.
 * `null` when it applies none. Covers the utility (`opacity-60`, and any variant
 * that can latch, e.g. `hover:opacity-60`), the arbitrary form
 * (`opacity-[0.6]`), and an inline style.
 */
function selfOpacity(el: HTMLElement): number | null {
  const cls = el.className || '';
  for (const m of cls.matchAll(/(?:^|[\s:])opacity-(?:\[([\d.]+)\]|(\d{1,3}))\b/g)) {
    const v = m[1] !== undefined ? Number(m[1]) : Number(m[2]) / 100;
    if (v < 1) return v;
  }
  const inline = el.style?.opacity;
  if (inline && Number(inline) < 1) return Number(inline);
  return null;
}

/**
 * Every STRICT ancestor of `el`, up to and including `root`.
 *
 * Strict because the rule is about a parent's opacity: an accent mark fading
 * ITSELF is how several of them are drawn — a block's multi-select registration
 * marks rest at `opacity-0` and are revealed by `group-hover/blk:opacity-100`,
 * which is a reveal, not a dim, and there is nothing above them to composite.
 */
function ancestors(el: HTMLElement, root: ParentNode): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let cur = el.parentElement;
  while (cur) {
    chain.push(cur);
    if ((cur as ParentNode) === root) break;
    cur = cur.parentElement;
  }
  return chain;
}

afterEach(cleanup);
beforeEach(() => seed());

describe('no accent is ever composited through a parent opacity', () => {
  /**
   * THE constraint (CLAUDE.md), and the one the first fix broke. It is asserted
   * against the mounted views rather than against a stylesheet on purpose: a
   * substring test passes just as happily when the selector has been moved onto
   * the wrong compound.
   */
  it.each([
    ['Week × Schedule', () => <WeekSchedule activeId={null} />],
    ['Week × Buckets', () => <WeekBuckets activeId={null} />],
  ])('%s: nothing above a lime mark fades', (name, ui) => {
    const { container } = mount(ui());

    const marks = ([...container.querySelectorAll('*')] as HTMLElement[]).filter(paintsAccent);
    // Guard the guard: if the fixture stopped rendering lime this would pass
    // vacuously, which is exactly how the branch it replaces went green.
    expect(marks.length, `${name} rendered no accent marks to check`).toBeGreaterThan(3);

    const offenders = marks.flatMap((mark) =>
      ancestors(mark, container)
        .filter((a) => selfOpacity(a) !== null)
        .map((a) => `${a.tagName}.${a.className} @${selfOpacity(a)} over ${mark.className}`)
    );
    expect(offenders, name).toEqual([]);
  });

  it('the lime is in an ORDINARY column — not the selected one, not today', () => {
    // The exclusions the reverted rule leaned on (`:not([data-selected])`,
    // `:not([data-today])`) would not have saved any of these.
    const { container } = mount(<WeekSchedule activeId={null} />);
    const plain = columns(container).find((c) => c.getAttribute('data-date') === PLAIN_STR)!;
    expect(plain.getAttribute('data-selected')).toBe('false');
    expect(plain.getAttribute('data-today')).toBe('false');
    expect(
      ([...plain.querySelectorAll('*')] as HTMLElement[]).filter(paintsAccent).length
    ).toBeGreaterThan(0);
  });
});

describe('the emphasis is a recede on the OTHER columns', () => {
  const css = () => readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');

  /** The recede rule's body — everything the non-hovered column re-points. */
  const recedeRule = () => {
    const src = css();
    const at = src.indexOf('[data-week-cols]:has(> [data-week-col]:hover) > [data-week-col]:not(:hover)');
    expect(at, 'the week recede rule is gone from globals.css').toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    return src.slice(open + 1, src.indexOf('}', open));
  };

  it('marks up both views with the hooks the rule selects on', () => {
    for (const [name, ui] of columnViews()) {
      const { container } = mount(ui);
      const cols = columns(container);
      expect(cols, name).toHaveLength(7);
      for (const col of cols) expect(col.hasAttribute('data-week-col'), name).toBe(true);

      // The rule is `> [data-week-col]` under the row, so the hook has to sit
      // on the columns' DIRECT parent or it selects nothing.
      const rows = new Set(cols.map((c) => c.parentElement!));
      expect(rows.size, name).toBe(1);
      for (const row of rows) expect(row.hasAttribute('data-week-cols'), name).toBe(true);
      cleanup();
    }
  });

  it('no longer marks the hovered column instead', () => {
    // The wash read as a selection highlight next to the lime header pill.
    // Removing it is the change; a column that lights up again is a revert.
    for (const [name, ui] of columnViews()) {
      const { container } = mount(ui);
      for (const col of columns(container)) {
        expect(col.className, name).not.toContain('hover:bg-accent');
      }
      cleanup();
    }
  });

  it('recedes with tokens, never with an opacity, filter or scrim', () => {
    const body = recedeRule();
    // Each of these dims lime exactly the way the reverted version did.
    expect(body).not.toMatch(/(^|[\s;])opacity\s*:/);
    expect(body).not.toMatch(/(^|[\s;])filter\s*:/);
    expect(body).not.toMatch(/(^|[\s;])background(-color)?\s*:/);
    // And it only ever assigns custom properties.
    for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
      if (decl.startsWith('/*') || decl.startsWith('*')) continue;
      expect(decl, `not a token swap: ${decl}`).toMatch(/^--[a-z0-9-]+\s*:/);
    }
  });

  it('leaves every chromatic token at full strength', () => {
    // THE constraint, at the other end from the mounted-tree check above: the
    // rule must not name --primary, the user-content ramp (--accent-8 IS lime),
    // or any other colour mark. Neutrals only.
    const named = [...recedeRule().matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(5);

    const CHROMATIC =
      /^--(primary|ring|success|warning|destructive|ai|accent-\d|priority|habit|morning|afternoon|evening|anytime|lime|honey|coral|day-today|sunrise)/;
    expect(named.filter((t) => CHROMATIC.test(t))).toEqual([]);
  });

  it('is guarded for touch, where :hover sticks after a tap', () => {
    // Unlike the wash it replaces. What stuck under the wash was a highlight on
    // the day you just tapped; what would stick here is six days dimmed.
    const src = css();
    const guard = src.lastIndexOf('@media (hover: hover) and (pointer: fine)');
    const rule = src.indexOf('[data-week-cols]:has(> [data-week-col]:hover)');
    expect(guard, 'the recede lost its pointer guard').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rule);
  });

  it('does not animate — the recede lands on one frame', () => {
    // It shipped with `transition-property: color, background-color,
    // border-color` on `[data-week-col] *`, which asks the compositor to
    // interpolate every node under six columns for eight frames. Measured worst
    // frame on hover: 93.5ms at 10 items per column, 297.3ms at 40, against
    // 18.8/22.0 with no transition — the cost scaled with the item count, which
    // is exactly where a planner grid gets busy. Nothing may re-add a
    // transition keyed to the recede's own hooks.
    const src = css();
    const guarded = src.slice(
      src.indexOf('--day-recede:'),
      src.indexOf('@layer base {\n  * {')
    );
    expect(guarded.length).toBeGreaterThan(100);
    for (const decl of guarded.matchAll(/^\s*(transition[a-z-]*)\s*:/gm)) {
      throw new Error(`the recede grew a transition again: ${decl[1]}`);
    }
    // And the selector that carried it is gone from the stylesheet's rules.
    expect(src).not.toMatch(/\[data-week-col\]\s*\*\s*\{/);
  });

  it('derives the receded twins at :root so every theme gets its own', () => {
    // A self-referencing custom property is a cycle and computes to nothing,
    // which is why these cannot be written inline in the rule above.
    const src = css();
    for (const t of ['--recede-ink-0', '--recede-ink-2', '--recede-border']) {
      expect(src, `${t} is not derived`).toContain(`${t}: color-mix(`);
    }
    expect(src).toContain('--day-recede:');
  });
});

describe('the Buckets day header', () => {
  it('rests at full surface and ink strength', () => {
    // Its `bg-surface-2/60`, `text-muted-foreground/70` and `text-foreground/70`
    // were the resting dim wearing a different hat.
    const { container } = mount(<WeekBuckets activeId={null} />);
    const headers = [...container.querySelectorAll('[data-testid="week-column-header"]')];
    expect(headers).toHaveLength(7);

    const unselected = headers.filter(
      (h) => h.closest('[data-testid="week-column"]')?.getAttribute('data-selected') === 'false'
    );
    expect(unselected).toHaveLength(6);
    for (const h of unselected) {
      expect(h.className).toContain('bg-surface-2');
      for (const el of [h, ...h.querySelectorAll('*')]) {
        expect(el.className).not.toMatch(/(bg|text)-[a-z-]+\/\d/);
      }
    }
  });

  it('keeps a hover affordance, and one that can actually animate', () => {
    // `hover-wash` paints a background-image, which is not an interpolable
    // property — under `transition-colors` it popped where the old
    // `bg-surface-2/60 → bg-surface-2` faded. The wash is its own element
    // fading its own opacity instead.
    const { container } = mount(<WeekBuckets activeId={null} />);
    const unselected = [
      ...container.querySelectorAll('[data-testid="week-column-header"]'),
    ].filter(
      (h) => h.closest('[data-testid="week-column"]')?.getAttribute('data-selected') === 'false'
    ) as HTMLElement[];
    expect(unselected).toHaveLength(6);
    for (const h of unselected) {
      expect(h.className).not.toContain('hover-wash');
      expect(h.className).toContain('group/dayhdr');
      const wash = h.querySelector('[aria-hidden]');
      expect(wash, 'the header lost its hover wash element').not.toBeNull();
      expect(wash!.className).toContain('bg-accent');
      expect(wash!.className).toContain('transition-opacity');
      expect(wash!.className).toContain('group-hover/dayhdr:opacity-100');
      // The wash is absolutely positioned and comes first, so the labels have
      // to be positioned too or it would paint over today's lime date.
      for (const label of h.querySelectorAll('span:not([aria-hidden])')) {
        expect(label.className).toMatch(/(^|\s)relative(\s|$)/);
      }
    }
  });
});

describe('the now-marker and data-today agree', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * `today` was date-fns `isToday`, which reads the MACHINE's calendar day,
   * while `nowY` is gated on `toDateStr(new Date(), userTimezone)`. One instant
   * spans 26 hours of offsets, so some timezone always disagrees with the
   * runner's — pick it rather than assuming the runner is UTC.
   */
  it('puts the marker in the column flagged data-today', () => {
    const instant = new Date('2026-08-26T21:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(instant);

    const machineDay = toDateStr(instant, Intl.DateTimeFormat().resolvedOptions().timeZone);
    const tz = ['Pacific/Kiritimati', 'Pacific/Midway', 'UTC'].find(
      (z) => toDateStr(instant, z) !== machineDay
    )!;
    const userDay = toDateStr(instant, tz);

    seed({
      userTimezone: tz,
      selectedDate: instant,
      showCurrentTimeIndicator: true,
      tasks: [],
      items: [] as never,
    });

    const { container } = mount(<WeekSchedule activeId={null} />);
    const cols = columns(container);
    const marked = cols.filter((c) => c.querySelector('[class*="now-z"]'));
    const flagged = cols.filter((c) => c.getAttribute('data-today') === 'true');

    expect(marked, `no now-marker rendered for ${tz}`).toHaveLength(1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].getAttribute('data-date')).toBe(userDay);
    expect(marked[0]).toBe(flagged[0]);
  });
});

describe('Week × List is out of scope, and stays out', () => {
  it('has no day columns to emphasise', () => {
    // Same line lib/week-columns.ts draws with isScalableLayout: schedule and
    // buckets have day columns, list does not. There are no siblings in a
    // vertical agenda, and it dims nothing already.
    const { container } = mount(<WeekList />);
    expect(container.querySelectorAll('[data-testid="week-column"]')).toHaveLength(0);
  });
});
