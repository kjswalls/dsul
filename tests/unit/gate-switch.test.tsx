import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { GroupSection } from '@/components/primitives/group-section';
import { usePlannerStore } from '@/lib/planner-store';
import type { Routine, Season } from '@dsul/types';

/**
 * The seam a mutation would break silently: RowGroup.gate → GroupSection → the
 * GateSwitch. It renders a switch ONLY on gate sections, reflecting the
 * container's stored (local) on/off, and no switch anywhere else.
 */

const routine = (id: string, over: Partial<Routine> = {}): Routine => ({
  id,
  name: `Routine ${id}`,
  itemIds: [],
  ...over,
});

const season = (id: string, over: Partial<Season> = {}): Season => ({
  id,
  name: `Season ${id}`,
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...over,
});

const seed = (routines: Routine[], seasons: Season[]) =>
  usePlannerStore.setState({ routines, seasons, userTimezone: 'UTC', projects: [] });

afterEach(() => cleanup());

describe('GroupSection gate header — the pause-switch seam', () => {
  it('renders a switch showing ON for an unpaused routine section', () => {
    seed([routine('r')], []);
    render(
      <GroupSection groupKey="r" label="Mornings" gate={{ kind: 'routine', id: 'r' }} variant="canvas">
        <div>child</div>
      </GroupSection>
    );
    const sw = screen.getByTestId('gate-switch');
    expect(sw.getAttribute('data-gate-on')).toBe('on');
    // The name is the accessible label; the verb lives in the tooltip.
    expect(sw.getAttribute('aria-label')).toBe('Routine r');
  });

  it('shows OFF for a paused routine — the recovery-on-canvas case', () => {
    seed([routine('r', { pausedAt: '2000-01-01T12:00:00Z' })], []);
    render(
      <GroupSection groupKey="r" label="Mornings" gate={{ kind: 'routine', id: 'r' }} variant="canvas">
        <div />
      </GroupSection>
    );
    expect(screen.getByTestId('gate-switch').getAttribute('data-gate-on')).toBe('off');
  });

  it('shows a season section’s switch, resolved from its state', () => {
    seed([], [season('p', { state: 'paused' })]);
    render(
      <GroupSection groupKey="p" label="Summer" gate={{ kind: 'season', id: 'p' }} variant="canvas">
        <div />
      </GroupSection>
    );
    expect(screen.getByTestId('gate-switch').getAttribute('data-gate-on')).toBe('off');
  });

  it('renders NO switch on a non-gate (container) section', () => {
    seed([], []);
    render(
      <GroupSection groupKey="project:Work" label="Work" variant="canvas">
        <div />
      </GroupSection>
    );
    expect(screen.queryByTestId('gate-switch')).toBeNull();
  });
});
