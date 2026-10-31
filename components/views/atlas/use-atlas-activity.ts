'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchCompletedAt, fetchItemEventsFor, getItemEventsAvailable } from '@/lib/db';
import {
  cachedTouches,
  cardActivity,
  idsKey,
  readItemTouches,
  rememberTouches,
  type ActivityDeps,
  type ItemTouches,
} from '@/lib/atlas-activity';
import type { AtlasCard } from '@/lib/atlas-model';

const DEPS: ActivityDeps = {
  fetchEvents: (ids, since) => fetchItemEventsFor(ids, since),
  fetchCompletedAt: (ids) => fetchCompletedAt(ids),
  eventsAvailable: () => getItemEventsAvailable(),
};

/**
 * When each card was last touched (lib/atlas-activity.ts), for Momentum and
 * Hide resting. Reads only while `enabled` (a layout or filter that needs it)
 * and an account has settled, twice (now and at +2s), and reuses a read made
 * in the last minute, so switching layouts never re-reads. Until the server
 * answers, the store's own touch is used; nothing missing ever reads resting.
 */
export function useAtlasActivity(
  cards: readonly AtlasCard[],
  { enabled, todayStr, tz }: { enabled: boolean; todayStr: string; tz: string },
): ReadonlyMap<string, string | 'unknown'> {
  const ids = useMemo(() => cards.flatMap((c) => c.members.map((m) => m.item.id)), [cards]);
  const key = useMemo(() => idsKey(ids), [ids]);
  const [server, setServer] = useState<{ key: string; value: ItemTouches } | null>(null);

  // A read made in the last minute answers at once (a layout switch).
  const cached = useMemo(() => (enabled && key ? cachedTouches(key.split(',')) : null), [enabled, key]);

  useEffect(() => {
    if (!enabled || !key || cached) return;
    const list = key.split(',');
    let live = true;
    const read = () =>
      readItemTouches(list, DEPS)
        .then((value) => {
          rememberTouches(list, value);
          if (live) setServer({ key, value });
        })
        .catch(() => {
          // A read that throws is unknown, never quiet: the store's touch stands.
        });
    void read();
    const again = setTimeout(() => void read(), 2000);
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [enabled, key, cached]);

  // A read for a slightly different set (an item added since) still holds
  // good touches by item id; it stands until the new read answers, so a card
  // never hops columns while one is in flight.
  const value = cached ?? server?.value ?? null;
  return useMemo(() => cardActivity(cards, value, todayStr, tz), [cards, value, todayStr, tz]);
}
