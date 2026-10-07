import { useLookStore } from '@/lib/look-store';
import { DEFAULT_DARK_LOOK, DEFAULT_LIGHT_LOOK } from '@/lib/theme-looks';
import { settingById, type SettingCtx } from '@/lib/settings/manifest';
import { themeSlugForId } from './css';

/**
 * Before a theme is switched off or deleted in Make: if it is a saved pick,
 * write the default through the pick's own record (store and user_settings),
 * so no device keeps a pick for a theme that has gone. A theme that only
 * fails to load (safe mode, a slow network) never comes through here, and its
 * pick is kept.
 */
export function releaseUserTheme(rowId: string, ctx: SettingCtx): void {
  const slug = themeSlugForId(rowId);
  const { light, dark } = useLookStore.getState();
  if (light === slug) settingById('look.lightTheme')?.write(DEFAULT_LIGHT_LOOK, ctx);
  if (dark === slug) settingById('look.darkTheme')?.write(DEFAULT_DARK_LOOK, ctx);
}
