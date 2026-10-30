'use client';

import { useEffect } from 'react';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_X_EFFECT, resolveEnabled } from '@/lib/extension-registry';
import { toDateStr } from '@/lib/recurrence';
import { X_EFFECT_SINCE_KEY } from '@/lib/x-effect';

/**
 * The day cards began for this account (lib/x-effect.ts), kept in the
 * extension's own config so it needs no column. Written once, on the first
 * turn-on, and never moved: switching X effect off and on keeps every card.
 */

function sinceOf(configs: Record<string, Record<string, unknown>>): string | null {
  const v = configs[EXT_X_EFFECT]?.[X_EFFECT_SINCE_KEY];
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Stamp today as `since` unless one is already stored. A no-op until config has loaded. */
export function stampXEffectSince(userId: string): void {
  const store = useExtensionsStore.getState();
  if (!store.configsLoaded || sinceOf(store.configs)) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  store.setConfigValue(userId, EXT_X_EFFECT, X_EFFECT_SINCE_KEY, toDateStr(new Date(), tz));
}

/**
 * `since` while X effect is on, else null. Stamps it when the extension is on
 * with none stored (a turn-on whose config write never landed), so the cards
 * cannot stay missing for good.
 */
export function useXEffectSince(userId: string | null): string | null {
  const on = useExtensionsStore((s) => resolveEnabled(s.enabled, EXT_X_EFFECT));
  const loaded = useExtensionsStore((s) => s.configsLoaded);
  const since = useExtensionsStore((s) => sinceOf(s.configs));
  useEffect(() => {
    if (on && loaded && !since && userId) stampXEffectSince(userId);
  }, [on, loaded, since, userId]);
  return on ? since : null;
}
