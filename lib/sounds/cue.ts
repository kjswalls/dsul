'use client';

import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_SOUNDS } from '@/lib/extension-registry';
import { isModEventsSuppressed } from '@/lib/mod-events';
import { readSoundsConfig, soundGroupOf, type SoundEvent, type SoundPackId } from './registry';
import { getSoundVolume, volumeGain } from './volume';

/**
 * The one door every sound goes through. Callers name the moment; this
 * decides whether it is heard.
 *
 * Silent unless the Sounds extension is on and the moment's group is switched
 * on, and silent for a write the person did not make: recipes, mods and an AI
 * applying its changes all run inside withSuppressed (lib/mod-events.ts), and
 * a sound for those would be the app clapping for itself. The same sound twice
 * in a blink (a bulk tick, a selection deleted at once) is one sound.
 *
 * The synth is imported lazily, so nobody with the extension off loads it, and
 * planner-store (which calls this) stays importable in node tests.
 */

const RECENT_MS = 60;
const lastPlayed = new Map<SoundEvent, number>();

export function cueSound(event: SoundEvent, opts: { fromModEvent?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  // A mod event was checked for suppression when it was raised, and its
  // listeners then run inside withSuppressed by design, so asking again
  // there would silence every one of them.
  if (!opts.fromModEvent && isModEventsSuppressed()) return;
  const ext = useExtensionsStore.getState();
  if (!ext.isEnabled(EXT_SOUNDS)) return;
  const config = readSoundsConfig(ext.configs[EXT_SOUNDS]);
  if (!config.groups[soundGroupOf(event).id]) return;
  const now = performance.now();
  const last = lastPlayed.get(event);
  if (last !== undefined && now - last < RECENT_MS) return;
  lastPlayed.set(event, now);
  play(config.pack, event);
}

/**
 * Play a sound whatever the switches say: the settings console's try buttons.
 * Still at this device's volume, so a try is as loud as the real thing.
 */
export function auditionSound(pack: SoundPackId, event: SoundEvent): void {
  if (typeof window === 'undefined') return;
  play(pack, event);
}

function play(pack: SoundPackId, event: SoundEvent) {
  const level = getSoundVolume();
  if (level === 0) return;
  import('./synth')
    .then(({ playSynth }) => playSynth(pack, event, volumeGain(level)))
    .catch((err) => console.warn('[sounds]', err));
}
