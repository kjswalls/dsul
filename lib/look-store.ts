'use client';

import { create } from 'zustand';
import { applyThemeChange } from '@/lib/theme-transition';
import { useSidebarStore } from '@/lib/sidebar-store';
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
import { APP_ICON_STORAGE_KEY, DEFAULT_APP_ICON, isAppIcon, type AppIcon } from '@/lib/app-icons';

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
 * the Look pane, and unlike the two above it is NOT per mode. So does the app
 * icon (lib/app-icons.ts), for the same reason.
 */
interface LookStore {
  light: LightLook;
  dark: DarkLook;
  setLight: (look: LightLook, opts?: { eased?: boolean }) => void;
  setDark: (look: DarkLook, opts?: { eased?: boolean }) => void;
  layout: LayoutTheme;
  setLayout: (layout: LayoutTheme) => void;
  appIcon: AppIcon;
  /**
   * False only while `appIcon` is the untouched fallback: nothing in this
   * device's localStorage, no server value, no pick this session. The desktop
   * bridge reads it so a fresh shell never tells main "Aurora" on the strength
   * of a default — that would overwrite the Lime it saved last time with a
   * value nobody chose.
   */
  appIconKnown: boolean;
  setAppIcon: (appIcon: AppIcon) => void;
}

function readStored(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function stored<T extends string>(key: string, guard: (v: unknown) => v is T, fallback: T): T {
  const raw = readStored(key);
  return guard(raw) ? raw : fallback;
}

export const useLookStore = create<LookStore>((set) => ({
  light: stored(LOOK_STORAGE_KEYS.light, isLightLook, DEFAULT_LIGHT_LOOK),
  dark: stored(LOOK_STORAGE_KEYS.dark, isDarkLook, DEFAULT_DARK_LOOK),
  layout: stored(LAYOUT_STORAGE_KEY, isLayoutTheme, DEFAULT_LAYOUT),
  appIcon: stored(APP_ICON_STORAGE_KEY, isAppIcon, DEFAULT_APP_ICON),
  appIconKnown: isAppIcon(readStored(APP_ICON_STORAGE_KEY)),

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
  // Store state only, like setLayout: the localStorage mirror lives in
  // supabase-provider, and the tab and the shell each read the store.
  setAppIcon: (appIcon) => set({ appIcon, appIconKnown: true }),
}));

/**
 * The slot variants the desktop shell draws. Desktop-only by construction:
 * only the desktop shell and what it mounts call this.
 */
export function useLayoutDef(): LayoutDef {
  return layoutDef(useLookStore((s) => s.layout));
}

/**
 * Open the column the capture dock lives in, if it lives in one. The catch-up
 * host, the dock's notices and the omnibar sit in the collapsible left column
 * only under `capture: 'dock'`; a layout that lays the dock across the bottom
 * keeps them on screen whatever the braindump is doing, so reopening a
 * braindump the person closed would be a side effect nobody asked for.
 */
export function revealDock(): void {
  if (layoutDef(useLookStore.getState().layout).slots.capture === 'prompt-bottom') return;
  useSidebarStore.getState().setLeftSidebarOpen(true);
}
