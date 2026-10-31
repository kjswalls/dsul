'use client';

import { useSyncExternalStore } from 'react';

/**
 * The Sounds extension's volume, per device on purpose: a laptop in a café
 * and a desktop at home want different levels, and the account's pack and
 * switches (user_extensions.config) are the part that should follow you.
 *
 * `dsul.sounds.volume` holds one number from 0 to 100. It says nothing about
 * who is signed in, so nothing clears it (tests/unit/local-state.test.ts).
 */

const KEY = 'dsul.sounds.volume';
export const DEFAULT_SOUND_VOLUME = 60;

const listeners = new Set<() => void>();
let cached: number | null = null;

export function getSoundVolume(): number {
  if (cached !== null) return cached;
  let v = DEFAULT_SOUND_VOLUME;
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) v = Math.min(100, Math.max(0, Math.round(parsed)));
  } catch {
    // Storage blocked: the default it is.
  }
  cached = v;
  return v;
}

export function setSoundVolume(v: number): void {
  cached = Math.min(100, Math.max(0, Math.round(v)));
  try {
    window.localStorage.setItem(KEY, String(cached));
  } catch {
    // Storage blocked: the level holds for this page load.
  }
  for (const l of listeners) l();
}

/** The 0–100 level as a gain: a curve, so the slider's middle sounds like the middle. */
export function volumeGain(level: number): number {
  return Math.pow(level / 100, 1.6) * 0.9;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useSoundVolume(): number {
  return useSyncExternalStore(subscribe, getSoundVolume, () => DEFAULT_SOUND_VOLUME);
}
