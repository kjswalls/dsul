'use client';

import { create } from 'zustand';
import { applyThemeChange } from '@/lib/theme-transition';
import {
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  LOOK_STORAGE_KEYS,
  isDarkLook,
  isLightLook,
  type DarkLook,
  type LightLook,
} from '@/lib/theme-looks';

/**
 * The theme picked for each mode (lib/theme-looks.ts). Both picks live here at
 * once — that is what lets a switch to dark and back find the light theme you
 * left. Which one is SHOWING is the mode's business (next-themes, `.dark`),
 * not this store's.
 *
 * Same shape as palette-store, for the same reasons: not persist()ed, because
 * the pre-hydration script in app/layout.tsx reads the raw localStorage
 * strings; the DOM stamp and the localStorage mirror live in one place,
 * supabase-provider's sync effect; server truth is user_settings.theme_light /
 * theme_dark, applied by hydration with eased=false.
 */
interface LookStore {
  light: LightLook;
  dark: DarkLook;
  setLight: (look: LightLook, opts?: { eased?: boolean }) => void;
  setDark: (look: DarkLook, opts?: { eased?: boolean }) => void;
}

function stored<T extends string>(key: string, guard: (v: unknown) => v is T, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return guard(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export const useLookStore = create<LookStore>((set) => ({
  light: stored(LOOK_STORAGE_KEYS.light, isLightLook, DEFAULT_LIGHT_LOOK),
  dark: stored(LOOK_STORAGE_KEYS.dark, isDarkLook, DEFAULT_DARK_LOOK),

  setLight: (light, opts) => {
    const write = () => set({ light });
    if (opts?.eased) applyThemeChange(write);
    else write();
  },
  setDark: (dark, opts) => {
    const write = () => set({ dark });
    if (opts?.eased) applyThemeChange(write);
    else write();
  },
}));
