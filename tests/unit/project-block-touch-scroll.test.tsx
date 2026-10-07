import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The drag grip inside a project block must not opt out of touch scrolling.
 *
 * `touch-action: none` is settled BEFORE any sensor sees the gesture: it tells
 * the browser not to pan, so it applies whichever sensor eventually claims the
 * touch. On a grip that means a finger landing there can neither scroll the
 * list nor — for the TouchSensor's first 250ms — drag anything. It is a dead
 * 16px column down the left of every row in the block.
 *
 * The grip is `opacity-0` until hover, which is why this survived the first pass
 * at the scroll bug: it looks like desktop-only chrome. It is not. It occupies
 * layout and hit-tests at full size regardless, and project blocks render on
 * phones through DayBuckets, the default mobile layout
 * (`components/mobile/mobile-view-router.tsx`).
 *
 * The class assertion is the whole test on purpose. jsdom computes no
 * `touch-action` and dispatches no scroll, so there is nothing behavioural to
 * observe — but the failure mode here is a single word in a className, which is
 * exactly what a string assertion catches. Same rule, same reason, in
 * `components/primitives/task-row.tsx`.
 */

const TASK = {
  id: 'gym',
  title: 'Go to the gym',
  type: 'task',
  status: 'pending',
  project: 'Work',
  inProjectBlock: true,
  repeatFrequency: 'none',
  completedDates: [],
} as never;

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: () => ({
    getProjectColor: () => 'var(--accent-3)',
    tasks: [TASK],
    moveTaskToProjectBlock: vi.fn(),
    moveTasksToProjectBlock: vi.fn(),
    toggleTaskStatus: vi.fn(),
    selectedDate: new Date('2026-07-29T12:00:00Z'),
    userTimezone: 'UTC',
  }),
}));

const { ProjectBlock } = await import('@/components/views/project-block');

describe('the block task drag grip', () => {
  it('leaves touch panning to the browser', () => {
    const { container } = render(
      <DndContext>
        <ProjectBlock
          project={{ id: 'p1', name: 'Work', emoji: '💼', startTime: '09:00' }}
          tasks={[TASK]}
          onTaskClick={() => {}}
        />
      </DndContext>
    );

    const grip = container.querySelector('button.cursor-grab') as HTMLElement;
    expect(grip).not.toBeNull();
    expect(grip.className).toContain('touch-manipulation');
    expect(grip.className).not.toContain('touch-none');
  });
});

describe('the block droppable id (#214)', () => {
  it('carries its day, so a block repeated across week columns registers once per column', () => {
    const project = { id: 'p1', name: 'Work', emoji: '💼', startTime: '09:00' } as never;
    const { container } = render(
      <DndContext>
        <ProjectBlock project={project} tasks={[TASK]} onTaskClick={() => {}} />
        <ProjectBlock
          project={project}
          tasks={[TASK]}
          onTaskClick={() => {}}
          variant="week"
          date={new Date('2026-07-30T12:00:00Z')}
        />
      </DndContext>
    );

    const ids = [...container.querySelectorAll('[data-testid="project-block"]')].map((el) =>
      el.getAttribute('data-dnd-id')
    );
    // Day view falls back to the selected day; a week column passes its own.
    expect(ids).toEqual(['projectblock:2026-07-29:Work', 'projectblock:2026-07-30:Work']);
  });
});
