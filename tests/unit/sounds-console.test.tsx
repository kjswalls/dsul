import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The Sounds console: every pack and every sound can be heard, picking a pack
 * or flipping a switch writes the account's config, and nothing writes before
 * that config has loaded.
 */

const audition = vi.fn();
vi.mock('@/lib/sounds/cue', () => ({ auditionSound: (...a: unknown[]) => audition(...a) }));

import { SoundsConsole } from '@/components/settings/sounds-console';
import { EXT_SOUNDS } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import type { SettingCtx } from '@/lib/settings/manifest';
import { SOUND_EVENTS, SOUND_GROUPS, SOUND_PACKS } from '@/lib/sounds/registry';

const ctx = { userId: 'u1', theme: undefined, setTheme: () => {} } as SettingCtx;
const setConfigValue = vi.fn();

function loaded(config: Record<string, unknown> = {}, enabled = true) {
  useExtensionsStore.setState({
    available: true,
    configsLoaded: true,
    enabled: { [EXT_SOUNDS]: enabled },
    configs: { [EXT_SOUNDS]: config },
    setConfigValue,
  });
}

describe('SoundsConsole', () => {
  beforeEach(() => {
    // The volume slider (Radix) measures its thumb.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.useFakeTimers();
    audition.mockClear();
    setConfigValue.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useExtensionsStore.getState().reset();
  });

  it('offers every pack, every switch and a try for every sound', () => {
    loaded();
    render(<SoundsConsole ctx={ctx} />);
    expect(screen.getAllByRole('radio')).toHaveLength(SOUND_PACKS.length);
    expect(screen.getAllByRole('switch')).toHaveLength(SOUND_GROUPS.length);
    for (const e of SOUND_EVENTS) expect(screen.getByTestId(`sounds-try-${e}`)).toBeTruthy();
    expect(screen.getByTestId('sounds-pack-silk').getAttribute('aria-checked')).toBe('true');
  });

  it('picking a pack plays it and saves it', () => {
    loaded();
    render(<SoundsConsole ctx={ctx} />);
    fireEvent.click(screen.getByTestId('sounds-pack-glass'));
    vi.runAllTimers();
    expect(audition).toHaveBeenCalledWith('glass', 'complete');
    expect(setConfigValue).toHaveBeenCalledWith('u1', EXT_SOUNDS, 'pack', 'glass');
  });

  it('a try plays the picked pack, even with Sounds off', () => {
    loaded({ pack: 'felt' }, false);
    render(<SoundsConsole ctx={ctx} />);
    expect(screen.getByTestId('sounds-off-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sounds-try-aiDone'));
    expect(audition).toHaveBeenCalledWith('felt', 'aiDone');
  });

  it('a switch writes the whole group map', () => {
    loaded({ groups: { tick: false } });
    render(<SoundsConsole ctx={ctx} />);
    fireEvent.click(screen.getByRole('switch', { name: /panels and views/i }));
    expect(setConfigValue).toHaveBeenCalledWith(
      'u1',
      EXT_SOUNDS,
      'groups',
      expect.objectContaining({ tick: false, panels: true, ai: true })
    );
  });

  it('writes nothing before the config has loaded', () => {
    loaded();
    useExtensionsStore.setState({ configsLoaded: false });
    render(<SoundsConsole ctx={ctx} />);
    fireEvent.click(screen.getByTestId('sounds-pack-pixel'));
    expect(setConfigValue).not.toHaveBeenCalled();
    // The play button still works: hearing a pack needs no account.
    fireEvent.click(screen.getByTestId('sounds-pack-play-pixel'));
    vi.runAllTimers();
    expect(audition).toHaveBeenCalledWith('pixel', 'complete');
  });
});
