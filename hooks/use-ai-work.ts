'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { aiWorkSummary, hasLiveRun, type AiWorkSummary } from '@/lib/ai-work';

/**
 * What the AI is doing across the account (lib/ai-work.ts), for the do stuff
 * key and the dock's line about it: what is being worked on, and what is ready.
 * Packs are read at sign-in (PrepPacksBoot, in the app shell), so the counts
 * are there before the mode is first started. The clock ticks only while a
 * handed-off run is live, since only that can go quiet.
 */
export function useAiWork(): AiWorkSummary {
  const items = usePlannerStore((s) => s.items);
  const preparing = usePrepPacksStore((s) => s.preparing);
  const packs = usePrepPacksStore((s) => s.packs);
  const live = useMemo(() => hasLiveRun(items), [items]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [live]);
  return useMemo(() => aiWorkSummary(items, { preparing, packs }, now), [items, preparing, packs, now]);
}
