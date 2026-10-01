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
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  isLayoutTheme,
  layoutDef,
  type LayoutDef,
  type LayoutTheme,
} from '@/lib/layout-themes';

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
 *
 * The layout (lib/layout-themes.ts) lives here too: it is the third pick on
 * the Look pane, and unlike the two above it is NOT per mode.
 */
interface LookStore {
  light: LightLook;
  dark: DarkLook;
  setLight: (look: LightLook, opts?: { eased?: boolean }) => void;
  setDark: (look: DarkLook, opts?: { eased?: boolean }) => void;
  layout: LayoutTheme;
  setLayout: (layout: LayoutTheme) => void;
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
  layout: stored(LAYOUT_STORAGE_KEY, isLayoutTheme, DEFAULT_LAYOUT),

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
  // Never eased: a layout moves whole surfaces, and a crossfade between two
  // arrangements reads as the app glitching rather than as a transition.
  setLayout: (layout) => set({ layout }),
}));

/**
 * The slot variants the desktop shell draws. Desktop-only by construction:
 * only the desktop shell and what it mounts call this.
 */
export function useLayoutDef(): LayoutDef {
  return layoutDef(useLookStore((s) => s.layout));
}
