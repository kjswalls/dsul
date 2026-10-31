'use client';

import { useEffect } from 'react';

import { useConversationsStore } from '@/lib/conversations-store';
import { isDayCleared } from '@/lib/day-done';
import { useDoStuffStore } from '@/lib/do-stuff';
import { EXT_SOUNDS, resolveEnabled } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { subscribeModEvents } from '@/lib/mod-events';
import { usePlannerStore } from '@/lib/planner-store';
import { toDateStr } from '@/lib/recurrence';
import { askOpenOf, useSidebarStore } from '@/lib/sidebar-store';
import { cueSound } from '@/lib/sounds/cue';
import { useAwayStore } from '@/lib/away-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';

/**
 * The Sounds extension's ears: the moments that are not one store action but
 * a change something else already announces. Mounted once in the root layout
 * and renders nothing; it listens only while the extension is on.
 *
 * The rest are called where they happen: deletes and undo in planner-store,
 * pick up and drop in AppShell's drag handlers. Everything goes through
 * cueSound (lib/sounds/cue.ts), which owns the switches.
 *
 * - Ticks, unticks and adds come off the mod event bus (lib/mod-events.ts),
 *   which already raises only the person's own transitions, once each.
 * - Day done is asked after a tick: the same isDayCleared the tab icon reads
 *   (components/providers/favicon-sync.tsx), at most once a day.
 * - Panels and views are changes of state that a sync, a catch-up or a saved
 *   setting arriving can also make. Those must stay silent, so they sound only
 *   within a moment of the person's own click or key.
 * - A Do stuff sprint runs out silently by design (lib/do-stuff.ts, "no sound,
 *   no red"). This is the opt-in: only with Sounds on and Moments switched on.
 * - The AI starts when a conversation starts streaming and finishes when it
 *   stops with a complete reply; a stopped or failed one makes no sound.
 */

const INPUT_WINDOW_MS = 800;
const BUS = { fromModEvent: true } as const;

export function SoundCues() {
  const on = useExtensionsStore((s) => resolveEnabled(s.enabled, EXT_SOUNDS));

  useEffect(() => {
    if (!on) return;
    const offs: Array<() => void> = [];

    let lastInput = 0;
    const markInput = () => {
      lastInput = performance.now();
    };
    window.addEventListener('pointerdown', markInput, true);
    window.addEventListener('keydown', markInput, true);
    offs.push(() => {
      window.removeEventListener('pointerdown', markInput, true);
      window.removeEventListener('keydown', markInput, true);
    });
    const byHand = () => performance.now() - lastInput < INPUT_WINDOW_MS;

    // Ticks, unticks, adds, and the day done.
    let dayDoneOn: string | null = null;
    offs.push(
      subscribeModEvents((e) => {
        if (e.kind === 'item.completed') {
          cueSound('complete', BUS);
          const planner = usePlannerStore.getState();
          const tz = planner.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          const today = toDateStr(new Date(), tz);
          if (e.date !== today || dayDoneOn === today) return;
          const cleared = isDayCleared(planner.items, today, {
            userTimezone: tz,
            routines: planner.routines,
            seasons: planner.seasons,
            away: useAwayStore.getState().periods,
          });
          if (cleared) {
            dayDoneOn = today;
            // After the tick's own sound, not over it.
            window.setTimeout(() => cueSound('daydone'), 280);
          }
        } else if (e.kind === 'item.uncompleted') {
          cueSound('uncomplete', BUS);
        } else if (e.kind === 'item.created') {
          cueSound('add', BUS);
        }
      })
    );

    // The item panel and Ask, opened and closed.
    offs.push(
      useUIStore.subscribe((s, prev) => {
        const open = s.activeDialog?.type === 'edit-item';
        const was = prev.activeDialog?.type === 'edit-item';
        if (open !== was && byHand()) cueSound(open ? 'open' : 'close');
      })
    );
    offs.push(
      useSidebarStore.subscribe((s, prev) => {
        const open = askOpenOf(s);
        if (open !== askOpenOf(prev) && byHand()) cueSound(open ? 'open' : 'close');
      })
    );

    // Day, week and the other views.
    offs.push(
      useViewStore.subscribe((s, prev) => {
        if ((s.scope !== prev.scope || s.layout !== prev.layout) && byHand()) cueSound('nav');
      })
    );

    // A sprint running out.
    let sprintTimer: number | undefined;
    const armSprint = (sprint: ReturnType<typeof useDoStuffStore.getState>['sprint']) => {
      window.clearTimeout(sprintTimer);
      sprintTimer = undefined;
      if (!sprint) return;
      const wait = sprint.endsAt - Date.now();
      // One that ran out before this page was here has nothing to announce.
      if (wait <= 0) return;
      sprintTimer = window.setTimeout(() => {
        if (useDoStuffStore.getState().sprint === sprint) cueSound('timer');
      }, wait);
    };
    armSprint(useDoStuffStore.getState().sprint);
    offs.push(
      useDoStuffStore.subscribe((s, prev) => {
        if (s.sprint !== prev.sprint) armSprint(s.sprint);
      })
    );
    offs.push(() => window.clearTimeout(sprintTimer));

    // The AI starting and finishing a reply.
    offs.push(
      useConversationsStore.subscribe((s, prev) => {
        if (s.threads === prev.threads) return;
        for (const [id, t] of Object.entries(s.threads)) {
          const was = prev.threads[id]?.streaming ?? false;
          if (t.streaming === was) continue;
          if (t.streaming) {
            cueSound('aiStart');
          } else {
            const reply = [...t.messages].reverse().find((m) => m.role === 'assistant');
            if (reply?.status === 'complete') cueSound('aiDone');
          }
        }
      })
    );

    return () => {
      for (const off of offs) off();
    };
  }, [on]);

  return null;
}
