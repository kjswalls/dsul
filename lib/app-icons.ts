/**
 * Catalog of APP ICONS — the mark in the browser tab and the desktop app's
 * Dock and taskbar.
 *
 * One pick, not one per mode, and stored in user_settings.app_icon (migration
 * 056) so a second browser and the desktop shell learn it too. Unrelated to
 * the colour theme on purpose: the icon is how dsul is FOUND among other
 * windows, and a mark that changed at sunset would be harder to find.
 *
 * Aurora is the bundle icon everywhere and the only one a home-screen install
 * or a closed desktop app ever shows; Lime is swapped in at runtime
 * (components/providers/favicon-sync.tsx in the tab, the bridge's setAppIcon in
 * the shell). The tab also turns Lime for the rest of a day whose items are
 * all done (lib/day-done.ts), whatever is picked here.
 */

export const APP_ICONS = [
  { value: 'aurora', label: 'Aurora' },
  { value: 'lime', label: 'Lime' },
] as const;

export type AppIcon = (typeof APP_ICONS)[number]['value'];

export const DEFAULT_APP_ICON: AppIcon = 'aurora';

/**
 * Raw localStorage key — a bare string, same reason as LAYOUT_STORAGE_KEY: it
 * is this device's last-known pick, read before the server answers.
 */
export const APP_ICON_STORAGE_KEY = 'dsul-app-icon';

export function isAppIcon(value: unknown): value is AppIcon {
  return typeof value === 'string' && APP_ICONS.some((i) => i.value === value);
}

/**
 * Where an icon href lives for a look. The lime set mirrors the Aurora file
 * names under /icons/lime/, so the swap is a prefix change and nothing else —
 * tests/unit/app-icons.test.ts fails if a twin is missing.
 */
export function iconHrefFor(href: string, look: AppIcon): string {
  return look === 'lime' ? href.replace('/icons/', '/icons/lime/') : href;
}
