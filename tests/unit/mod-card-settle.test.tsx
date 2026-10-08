// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * The braindump's mod card waits out a running settle before it first
 * appears (components/mods/mod-card.tsx, memory/plans/instant-planner.md).
 * Make's rows usually land one round trip after the planner, mid-glide, and
 * the card sits outside the braindump's settle scope, so appearing then would
 * shrink the list under the conductor and snap the quick-add and Paused strip
 * up. Once shown it stays through a later settle.
 */

vi.mock('@/components/mods/mod-surface', () => ({
  ModSurface: ({ panelRef }: { panelRef: { modId: string; panelId: string } }) => (
    <div data-testid="mod-surface" data-mod={panelRef.modId} />
  ),
}));

import { ModCard } from '@/components/mods/mod-card';
import { useModsStore } from '@/lib/mods-store';
import { SETTLING_ATTR } from '@/lib/settle';
import type { UserMod } from '@/lib/mods/schema';

const withCard: UserMod = {
  id: 'm1',
  userId: 'u',
  kind: 'mod',
  slug: 'm1',
  name: 'Water',
  enabled: true,
  manifest: { version: 1, uses: ['ui'], commands: [], panels: [{ id: 'main', label: 'Main', card: true }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
} as UserMod;

const settling = (on: boolean) =>
  act(() => {
    if (on) document.documentElement.setAttribute(SETTLING_ATTR, 'true');
    else document.documentElement.removeAttribute(SETTLING_ATTR);
  });

// The attribute's observer reports in a microtask.
const flush = () => act(async () => {});

beforeEach(() => {
  useModsStore.setState({ rows: [], safeMode: false });
  document.documentElement.removeAttribute(SETTLING_ATTR);
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(SETTLING_ATTR);
});

describe('the mod card and the settle', () => {
  it('shows at once when nothing is settling', () => {
    useModsStore.setState({ rows: [withCard] });
    render(<ModCard />);
    expect(screen.getByTestId('mod-surface')).toHaveAttribute('data-mod', 'm1');
  });

  it('holds a card whose rows arrive mid-settle until the run is over', async () => {
    render(<ModCard />);
    await settling(true);
    await flush();
    act(() => useModsStore.setState({ rows: [withCard] }));
    expect(screen.queryByTestId('mod-card')).toBeNull();

    await settling(false);
    await flush();
    expect(screen.getByTestId('mod-card')).toBeInTheDocument();
  });

  it('stays through a later settle once shown', async () => {
    useModsStore.setState({ rows: [withCard] });
    render(<ModCard />);
    expect(screen.getByTestId('mod-card')).toBeInTheDocument();
    await settling(true);
    await flush();
    expect(screen.getByTestId('mod-card')).toBeInTheDocument();
  });

  it('shows nothing in safe mode, settle or not', () => {
    useModsStore.setState({ rows: [withCard], safeMode: true });
    render(<ModCard />);
    expect(screen.queryByTestId('mod-card')).toBeNull();
  });
});
