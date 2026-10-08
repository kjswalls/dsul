import { useLookStore } from '@/lib/look-store';
import { DEFAULT_DARK_LOOK, DEFAULT_LIGHT_LOOK, LOOK_STORAGE_KEYS } from '@/lib/theme-looks';
import { isUserThemeSlug } from './css';

/**
 * Account switch and sign-out (lib/local-state.ts RAW_CLEARERS): a light or
 * dark pick naming one of the last account's themes goes back to the default,
 * in the store and its localStorage mirror. The picks are per device and
 * outlive an account, so without this the next account (one that never chose
 * a theme) would inherit a `u-` slug it cannot resolve, and could save it to
 * its own settings. Built-in picks stay, as they always have. Only this device:
 * user_settings is the departing account's and is left as it is.
 */
export function forgetUserThemePicks(): void {
  const { light, dark } = useLookStore.getState();
  if (isUserThemeSlug(light)) {
    useLookStore.getState().setLight(DEFAULT_LIGHT_LOOK);
    removeKey(LOOK_STORAGE_KEYS.light);
  }
  if (isUserThemeSlug(dark)) {
    useLookStore.getState().setDark(DEFAULT_DARK_LOOK);
    removeKey(LOOK_STORAGE_KEYS.dark);
  }
}

function removeKey(key: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key);
  } catch {
    // Private mode: the store is reset, which is what paints.
  }
}
