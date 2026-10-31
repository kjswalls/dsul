import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playSynth = vi.fn();
vi.mock('@/lib/sounds/synth', () => ({ playSynth }));

import { EXT_SOUNDS, extensionManifest } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { withSuppressed } from '@/lib/mod-events';
import { auditionSound, cueSound } from '@/lib/sounds/cue';
import {
  DEFAULT_SOUND_PACK,
  SOUND_EVENTS,
  SOUND_GROUPS,
  SOUND_PACKS,
  readSoundsConfig,
} from '@/lib/sounds/registry';
import { setSoundVolume } from '@/lib/sounds/volume';

/** The lazy import resolves on a later microtask. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function sounds(enabled: boolean, config: Record<string, unknown> = {}) {
  useExtensionsStore.setState({ enabled: { [EXT_SOUNDS]: enabled }, configs: { [EXT_SOUNDS]: config } });
}

describe('the Sounds registry', () => {
  it('puts every sound in exactly one group', () => {
    const grouped = SOUND_GROUPS.flatMap((g) => g.events);
    expect([...grouped].sort()).toEqual([...SOUND_EVENTS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('starts off, as a sound is never quiet until used', () => {
    expect(extensionManifest(EXT_SOUNDS)?.defaultEnabled).toBe(false);
  });

  it('reads a missing or broken config as the defaults', () => {
    const fresh = readSoundsConfig(undefined);
    expect(fresh.pack).toBe(DEFAULT_SOUND_PACK);
    for (const g of SOUND_GROUPS) expect(fresh.groups[g.id]).toBe(g.defaultOn);
    expect(readSoundsConfig({ pack: 'kazoo', groups: [true] }).pack).toBe(DEFAULT_SOUND_PACK);
    expect(readSoundsConfig({ groups: { panels: 'yes' } }).groups.panels).toBe(false);
  });

  it('keeps what was stored', () => {
    const c = readSoundsConfig({ pack: 'relay', groups: { tick: false, panels: true } });
    expect(c.pack).toBe('relay');
    expect(c.groups.tick).toBe(false);
    expect(c.groups.panels).toBe(true);
    expect(c.groups.ai).toBe(true);
  });

  it('has a pack for every id it offers', async () => {
    const real = await vi.importActual<typeof import('@/lib/sounds/synth')>('@/lib/sounds/synth');
    // No Web Audio in the test environment: every call is a quiet no-op, never a throw.
    for (const p of SOUND_PACKS) for (const e of SOUND_EVENTS) expect(() => real.playSynth(p.id, e, 0.5)).not.toThrow();
  });
});

describe('cueSound', () => {
  beforeEach(() => {
    playSynth.mockClear();
    setSoundVolume(60);
  });
  afterEach(() => {
    useExtensionsStore.getState().reset();
  });

  it('is silent while the extension is off', async () => {
    sounds(false);
    cueSound('add');
    await settle();
    expect(playSynth).not.toHaveBeenCalled();
  });

  it('plays the picked pack when on', async () => {
    sounds(true, { pack: 'felt' });
    cueSound('remove');
    await settle();
    expect(playSynth).toHaveBeenCalledWith('felt', 'remove', expect.any(Number));
  });

  it('is silent for a group switched off, and for panels by default', async () => {
    sounds(true, { groups: { edit: false } });
    cueSound('remove');
    cueSound('open');
    await settle();
    expect(playSynth).not.toHaveBeenCalled();
  });

  it('is silent for writes the person did not make', async () => {
    sounds(true);
    withSuppressed(() => cueSound('undo'));
    await settle();
    expect(playSynth).not.toHaveBeenCalled();
    // A mod event was already checked when it was raised.
    withSuppressed(() => cueSound('complete', { fromModEvent: true }));
    await settle();
    expect(playSynth).toHaveBeenCalledTimes(1);
  });

  it('plays the same sound twice in a blink once', async () => {
    sounds(true);
    cueSound('drop');
    cueSound('drop');
    await settle();
    expect(playSynth).toHaveBeenCalledTimes(1);
  });

  it('is silent at volume 0, even to try', async () => {
    sounds(true);
    setSoundVolume(0);
    cueSound('nope');
    auditionSound('glass', 'nope');
    await settle();
    expect(playSynth).not.toHaveBeenCalled();
  });

  it('lets the console try any sound with the extension off', async () => {
    sounds(false, { groups: { panels: false } });
    auditionSound('pixel', 'open');
    await settle();
    expect(playSynth).toHaveBeenCalledWith('pixel', 'open', expect.any(Number));
  });
});
