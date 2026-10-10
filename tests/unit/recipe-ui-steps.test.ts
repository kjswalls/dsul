import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** A recipe's "apply a Look" step (lib/recipes/ui-steps.ts): a built-in, or one of your own that is on. */

const manifest = vi.hoisted(() => ({ applyLook: vi.fn(), applyUserLook: vi.fn(), settingById: vi.fn() }));
vi.mock('@/lib/settings/manifest', () => manifest);
vi.mock('sonner', () => ({ toast: vi.fn() }));

import { runUiStep } from '@/lib/recipes/ui-steps';
import { useModsStore } from '@/lib/mods-store';
import { lookById } from '@/lib/looks';
import type { UserMod } from '@/lib/mods/schema';

const look = (id: string, name: string, enabled: boolean): UserMod => ({
  id,
  userId: 'u1',
  kind: 'look',
  slug: `u-${id.slice(0, 8)}`,
  name,
  enabled,
  manifest: { version: 1, layout: 'writer', light: 'studio', dark: 'dusk' },
  disabledReason: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
});

const deps = { navigate: vi.fn() };
// The step imports the manifest lazily; let that settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  manifest.applyLook.mockReset();
  manifest.applyUserLook.mockReset();
  useModsStore.setState({
    rows: [look('abcdef01-2345-4678-9abc-def012345678', 'Deep work', true), look('bbbbbbbb-2345-4678-9abc-def012345678', 'Resting', false)],
    safeMode: false,
  });
});
afterEach(() => {
  useModsStore.getState().reset();
  useModsStore.setState({ safeMode: false });
});

describe('applyLook step', () => {
  it('a built-in id applies that preset', async () => {
    runUiStep({ do: 'applyLook', look: 'console' }, 'R', deps);
    await settle();
    expect(manifest.applyLook).toHaveBeenCalledWith(lookById('console'), expect.objectContaining({ setTheme: expect.any(Function) }));
    expect(manifest.applyUserLook).not.toHaveBeenCalled();
  });

  it('one of your Looks that is on applies it', async () => {
    runUiStep({ do: 'applyLook', look: 'u-abcdef01' }, 'R', deps);
    await settle();
    expect(manifest.applyUserLook).toHaveBeenCalledTimes(1);
    expect(manifest.applyUserLook.mock.calls[0][0]).toMatchObject({ ref: 'u-abcdef01', label: 'Deep work', layout: 'writer' });
  });

  it('one that is off, unknown, or held back by safe mode does nothing', async () => {
    runUiStep({ do: 'applyLook', look: 'u-bbbbbbbb' }, 'R', deps);
    runUiStep({ do: 'applyLook', look: 'u-deadbeef' }, 'R', deps);
    useModsStore.setState({ safeMode: true });
    runUiStep({ do: 'applyLook', look: 'u-abcdef01' }, 'R', deps);
    await settle();
    expect(manifest.applyUserLook).not.toHaveBeenCalled();
    expect(manifest.applyLook).not.toHaveBeenCalled();
  });
});
