import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The wiring between the overlap pass and the block it positions.
 *
 * schedule-overlap.test.ts pins the arithmetic; this pins that the numbers
 * actually reach the DOM — and, most importantly, that a block with NOTHING
 * overlapping it still renders the markup this component rendered before the pass
 * existed. That regression is the one that would go unnoticed: every uncrowded day
 * is the common case.
 */

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: () => ({
    getProjectColor: () => 'var(--accent-3)',
    getHabitGroupColor: () => 'var(--accent-2)',
    selectedDate: new Date('2026-07-29T12:00:00Z'),
    userTimezone: 'UTC',
    toggleTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    updateHabit: vi.fn(),
  }),
}));
vi.mock('@/lib/use-time-format', () => ({ useTimeFormat: () => 'h:mm a' }));
vi.mock('@/lib/ui-store', () => ({ openEditFor: vi.fn() }));

const { ScheduleBlock, toOverlapEntries } = await import('@/components/views/day-schedule');
const { layoutOverlaps } = await import('@/lib/schedule-overlap');
const { LANE_PX } = await import('@/lib/schedule-constants');
type TimedEntry = import('@/components/views/day-schedule').TimedEntry;

const HM = (h: number, m = 0) => h * 60 + m;

function timed(id: string, title: string, startMin: number, duration: number): TimedEntry {
  const hh = String(Math.floor(startMin / 60)).padStart(2, '0');
  const mm = String(startMin % 60).padStart(2, '0');
  return {
    itemType: 'task',
    item: {
      id,
      title,
      type: 'task',
      status: 'pending',
      startTime: `${hh}:${mm}`,
      duration,
      repeatFrequency: 'none',
      completedDates: [],
    } as never,
    startMin,
    duration,
  };
}

const HOUR = 52;
const GRID = HM(9);

function paint(entries: TimedEntry[], fieldWidth: number | null = 900) {
  const layout = layoutOverlaps(toOverlapEntries(entries), {
    hourPx: HOUR,
    gridStartMin: GRID,
    variant: 'day',
    fieldWidth,
  });
  const { container } = render(
    <DndContext>
      {entries.map((e) => (
        <ScheduleBlock
          key={e.item.id}
          entry={e}
          gridStartMin={GRID}
          hourPx={HOUR}
          layout={layout.get(e.item.id)}
          fieldWidth={fieldWidth}
        />
      ))}
    </DndContext>
  );
  const byId = (id: string) =>
    container.querySelector(`[data-item-id="${id}"]`) as HTMLElement;
  return { container, byId };
}

const paneOf = (blk: HTMLElement) => blk.querySelector('[class*="rounded-\\[5px\\]"]') as HTMLElement;
const pocketsOf = (blk: HTMLElement) => blk.querySelectorAll('[class*="sched-pocket"]');

describe('ScheduleBlock — no overlap keeps today’s markup', () => {
  it('carries the literal left-0 right-1 classes and a plain 12px pane inset', () => {
    const { byId } = paint([timed('solo', 'Go to the gym', HM(10), 60)]);
    const blk = byId('solo');
    expect(blk.className).toContain('left-0');
    expect(blk.className).toContain('right-1');
    // No inline band overriding them.
    expect(blk.style.left).toBe('');
    expect(blk.style.right).toBe('');
    expect(paneOf(blk).style.marginLeft).toBe(`${LANE_PX}px`);
    expect(paneOf(blk).style.marginRight).toBe('0px');
    expect(pocketsOf(blk)).toHaveLength(0);
    // Content fills the pane, exactly as before.
    expect(blk.style.getPropertyValue('--blk-z')).toBe('2');
  });

  it('leaves two far-apart blocks both untouched', () => {
    const { byId } = paint([
      timed('a', 'Gym', HM(10), 60),
      timed('b', 'Dinner', HM(14), 60),
    ]);
    for (const id of ['a', 'b']) {
      expect(byId(id).className).toContain('left-0');
      expect(pocketsOf(byId(id))).toHaveLength(0);
    }
  });
});

describe('ScheduleBlock — NESTED renders the pocket and moves the title', () => {
  const entries = [
    timed('span', 'Plan a date for Monday or Tuesday', HM(10), 420),
    timed('task', 'Log my food!', HM(14), 180),
  ];

  it('sinks one pocket in the container, sized to its child', () => {
    const { byId } = paint(entries);
    const pockets = pocketsOf(byId('span'));
    expect(pockets).toHaveLength(1);
    const p = pockets[0] as HTMLElement;
    // 10:00 pane top is 55; 14:00 pane top is 263 → pocket at 208 inside it.
    expect(p.style.top).toBe('208px');
    expect(parseFloat(p.style.height)).toBeCloseTo(152, 1);
  });

  it('re-anchors the container title into the band ABOVE its child', () => {
    const { byId } = paint(entries);
    // This is the reported bug: the title used to centre over the whole 360px
    // pane and land underneath the covering plate.
    const content = byId('span').querySelector('[style*="--clr-h"]') as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.style.marginTop).toBe('0px');
    expect(content.style.getPropertyValue('--clr-h')).toBe('208px');
  });

  it('insets the child on both edges and puts it on a solid plate', () => {
    const { byId } = paint(entries);
    const blk = byId('task');
    expect(blk.style.left).toBe('14px');
    // Inset right too, so the pocket frames it rather than the child running out
    // to the parent's own border.
    expect(blk.style.right).toBe('12px');
    expect(paneOf(blk).className).toContain('surface-2');
    // Its bead is punched out of the parent's plate, not the canvas.
    const bead = blk.querySelector('[class*="rounded-full"]') as HTMLElement;
    expect(bead.style.boxShadow).toContain('var(--surface-2)');
  });

  it('emits a hover z that keeps the container under its own child', () => {
    // Reported from the browser: only the parent could be hovered. Every block
    // lifted to a flat z-7 on hover, so the parent — which the pointer must cross
    // to reach the child — latched :hover and sat on top of it permanently.
    const { byId } = paint(entries);
    const span = byId('span');
    const task = byId('task');
    const z = (el: HTMLElement, prop: string) => Number(el.style.getPropertyValue(prop));
    expect(z(span, '--blk-zh')).toBeLessThan(z(task, '--blk-z'));
    expect(z(span, '--blk-zh')).toBeGreaterThan(z(span, '--blk-z'));
  });

  it('forks the lane once, at the child start', () => {
    const { byId } = paint(entries);
    const ticks = byId('span').querySelectorAll('[class*="sched-rail"]');
    expect(ticks).toHaveLength(1);
    expect((ticks[0] as HTMLElement).style.top).toBe('205px');
  });

  it('retreats the container’s bottom handle into its own lane on the flush edge', () => {
    const { byId } = paint(entries);
    const handle = byId('span').querySelector('[aria-label="Resize duration"]') as HTMLElement;
    // Both end 17:00, so a full-width strip would sit 0px from the child's.
    expect(handle.style.left).toBe('0px');
    expect(handle.style.width).toBe(`${LANE_PX + 8}px`);
    // The top edge is not shared, so it keeps the full-width strip.
    const top = byId('span').querySelector('[aria-label="Resize start"]') as HTMLElement;
    expect(top.style.width).toBe('');
  });
});

describe('ScheduleBlock — DOUBLE-BOOKED tiles, each rail beside its pane', () => {
  const entries = [
    timed('dentist', 'Dentist', HM(10), 60),
    timed('standup', 'Standup', HM(10), 60),
  ];

  it('keeps both members on the same band and tiles their panes with a lane gutter', () => {
    const { byId } = paint(entries);
    expect(byId('dentist').style.left).toBe(byId('standup').style.left);
    // Member 0's pane ends at the tile boundary (band() writes 50% as a zero-px
    // calc); member 1's starts a full lane past it, so member 1's rail+bead sit
    // in that gutter beside its own pane.
    expect(paneOf(byId('dentist')).style.marginRight).toBe('calc(50% + 0px)');
    expect(paneOf(byId('standup')).style.marginLeft).toBe(`calc(50% + ${LANE_PX}px)`);
  });

  it('seats the second member’s swell beside its own tile, not the shared edge', () => {
    const { byId } = paint(entries);
    const swell = (blk: HTMLElement) =>
      blk.querySelector('[data-slot="rail"]') as HTMLElement;
    expect(swell(byId('dentist')).style.left).toBe('5px');
    // The CSS serialiser is free to reorder a calc's terms, so assert on parts.
    expect(swell(byId('standup')).style.left).toContain('50%');
    expect(swell(byId('standup')).style.left).toContain('5px');
  });

  it('draws the start-tie once, on the first member only', () => {
    const { byId } = paint(entries);
    // The tie is the hairline with a `right` inset stopping under the last bead;
    // no other element on a plain double-booking carries a border-t + right.
    const tieOf = (blk: HTMLElement) =>
      Array.from(blk.querySelectorAll('[class*="border-t"]')).find(
        (el) => (el as HTMLElement).style.right
      ) as HTMLElement | undefined;
    expect(tieOf(byId('dentist'))?.style.right).toContain('50%');
    expect(tieOf(byId('standup'))).toBeUndefined();
  });

  it('registers the corner marks against each pane’s real edge', () => {
    const { byId } = paint(entries);
    // Default mark style is 'nodes' — hollow squares filled with --canvas, one
    // per vertex. A mark left at the literal LANE_PX would annotate empty grid
    // for member 1, so it must anchor off the pane's real inset (50% + 12px now
    // that each tile carries its own lane). Asserted on the parts, not the
    // string: the CSS serialiser is free to reorder a calc's terms, and does.
    const marks = byId('standup').querySelectorAll('[class*="bg-\\[var(--canvas)\\]"]');
    const left = Array.from(marks).find((m) => (m as HTMLElement).style.left) as HTMLElement;
    expect(left.style.left).toContain(`50% + ${LANE_PX}px`);
    expect(left.style.left).not.toBe(`${LANE_PX - 3}px`);
  });
});

describe('ScheduleBlock — the content treatment follows WIDTH, not view', () => {
  const crossing = [
    timed('a', 'Design review with the whole team', HM(10), 120),
    timed('b', 'Lunch with Ana', HM(11), 120),
  ];
  const titleOf = (blk: HTMLElement) =>
    blk.querySelector('[class*="font-content"]') as HTMLElement;

  it('keeps a wide day pane on one truncated line', () => {
    // 900px field, two channels → 450px panes. Nowhere near the threshold.
    const { byId } = paint(crossing, 900);
    expect(titleOf(byId('a')).className).toContain('truncate');
    expect(titleOf(byId('a')).className).not.toContain('break-words');
  });

  it('wraps a narrow day channel exactly like a week column', () => {
    // 300px field, two channels → 150px panes, under PANE_WRAP_PX.
    const { byId } = paint(crossing, 300);
    const title = titleOf(byId('a'));
    expect(title.className).toContain('break-words');
    expect(title.className).toContain('line-clamp');
    expect(title.className).not.toContain('truncate');
  });

  it('leaves an unmeasured field on the wide treatment', () => {
    const { byId } = paint(crossing, null);
    expect(titleOf(byId('a')).className).toContain('truncate');
  });

  it('does not narrow a lone block however the field is measured', () => {
    // The common case: no overlap → fraction 1 → never narrow.
    const { byId } = paint([timed('solo', 'Go to the gym', HM(10), 60)], 300);
    expect(titleOf(byId('solo')).className).toContain('truncate');
  });
});

describe('ScheduleBlock — week shingles without splitting width', () => {
  it('steps the second block 10px and keeps its pane full width', () => {
    const entries = [
      timed('span', 'Deep work', HM(10), 420),
      timed('task', 'Log my food!', HM(14), 180),
    ];
    const layout = layoutOverlaps(toOverlapEntries(entries), {
      hourPx: HOUR,
      gridStartMin: GRID,
      variant: 'week',
    });
    const { container } = render(
      <DndContext>
        {entries.map((e) => (
          <ScheduleBlock
            key={e.item.id}
            entry={e}
            gridStartMin={GRID}
            hourPx={HOUR}
            variant="week"
            layout={layout.get(e.item.id)}
          />
        ))}
      </DndContext>
    );
    const task = container.querySelector('[data-item-id="task"]') as HTMLElement;
    expect(task.style.left).toBe('10px');
    expect(paneOf(task).style.marginLeft).toBe(`${LANE_PX}px`);
    // No containment vocabulary in week.
    expect(pocketsOf(container.querySelector('[data-item-id="span"]') as HTMLElement)).toHaveLength(0);
  });
});
