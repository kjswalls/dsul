'use client';

import { useEffect, useLayoutEffect } from 'react';
import { useModsStore } from '@/lib/mods-store';
import { useLookStore } from '@/lib/look-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { setUserThemesFromRows, useUserThemes } from '@/lib/user-themes/store';
import { composeUserThemeCss, isUserThemeSlug } from '@/lib/user-themes/css';

/**
 * Your themes as one stylesheet (memory/plans/mods.md, "Injection").
 *
 * Route-level, in app/layout.tsx: a theme shows on every route, /settings
 * included, which never loads the planner. So it loads the theme rows itself
 * (mods-store, by the session's user) whenever a pick names one of your themes,
 * rather than waiting for RecipeHost.
 *
 * It owns `<style id="dsul-user-themes">`, kept last in <head> and written with
 * textContent from host-printed declarations only (lib/user-themes/css.ts). On
 * its first write it removes the pre-paint script's boot sheet, which held the
 * same live rules. Each write bumps `data-user-themes-rev` on <html>, which the
 * RelayField watches, so editing the relay colours of the theme you are on
 * repaints without a reload.
 */

export const USER_THEME_STYLE_ID = 'dsul-user-themes';
export const USER_THEME_BOOT_STYLE_ID = 'dsul-user-themes-boot';
export const USER_THEMES_REV_ATTR = 'data-user-themes-rev';

export function ThemeInjector() {
  const userId = useSessionUserStore((s) => s.user?.id ?? null);
  const light = useLookStore((s) => s.light);
  const dark = useLookStore((s) => s.dark);
  const rows = useModsStore((s) => s.rows);
  const loaded = useModsStore((s) => s.loaded);
  const available = useModsStore((s) => s.available);
  const hydratedUserId = useModsStore((s) => s.hydratedUserId);
  const safeMode = useModsStore((s) => s.safeMode);
  const themes = useUserThemes((s) => s.themes);
  const draft = useUserThemes((s) => s.draft);
  const rev = useUserThemes((s) => s.rev);

  const wantsRows = isUserThemeSlug(light) || isUserThemeSlug(dark);
  useEffect(() => {
    if (userId && wantsRows && !safeMode) void useModsStore.getState().hydrate(userId);
  }, [userId, wantsRows, safeMode]);

  useEffect(() => {
    if (safeMode) setUserThemesFromRows([], true);
    else if (!available) setUserThemesFromRows([], false);
    else if (loaded && userId && hydratedUserId === userId) setUserThemesFromRows(rows, false);
  }, [rows, loaded, available, hydratedUserId, userId, safeMode]);

  // Before paint, so the boot sheet never goes before its replacement lands.
  useLayoutEffect(() => {
    const head = document.head;
    let style = document.getElementById(USER_THEME_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = USER_THEME_STYLE_ID;
    }
    style.textContent = composeUserThemeCss(Object.values(themes), { preview: true, draft });
    // Appending an attached node moves it: the sheet stays last in <head>.
    head.appendChild(style);
    document.getElementById(USER_THEME_BOOT_STYLE_ID)?.remove();
    // Only on a change to the live themes: a draft keystroke must not wake
    // the RelayField, which watches this attribute.
    const root = document.documentElement;
    if (root.getAttribute(USER_THEMES_REV_ATTR) !== String(rev)) root.setAttribute(USER_THEMES_REV_ATTR, String(rev));
  }, [themes, draft, rev]);

  useEffect(
    () => () => {
      document.getElementById(USER_THEME_STYLE_ID)?.remove();
    },
    []
  );

  return null;
}
