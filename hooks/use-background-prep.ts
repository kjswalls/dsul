'use client';

import { useEffect, useRef } from 'react';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { inactiveItemIdsOn } from '@/lib/active';
import { handOffItem } from '@/lib/agent-handoff';
import { useAgentsStore, useHandOffTargets } from '@/lib/agents-store';
import { useAwayStore } from '@/lib/away-store';
import {
  agentCandidates,
  backgroundPrepOn,
  backgroundPrepWorker,
  ledgerFor,
  prepCandidates,
  recordAsked,
  remainingToday,
  TICK_MS,
  type PrepLedger,
} from '@/lib/background-prep';
import { aiModeColumnSeen } from '@/lib/db';
import { useDoStuffStore } from '@/lib/do-stuff';
import { EXT_DO_STUFF } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';
import { packIsStale, PREP_BATCH } from '@/lib/prep-packs';
import { prepItemFor, usePrepPacksStore } from '@/lib/prep-packs-store';
import { toDateStr } from '@/lib/recurrence';
import { isStuck } from '@/lib/stuck';
import { movesOf, useStuckStore } from '@/lib/stuck-store';

/**
 * Runs background prep (lib/background-prep.ts) while the page is open and
 * visible: once when it can, then every TICK_MS. Mounted once, with
 * PrepPacksBoot. Nothing runs unless Do stuff is on, the person turned
 * background prep on, and whoever it names can do it: their own model while it
 * answers here (`canPrep`), or an agent they can hand work to.
 *
 * The ledger is per browser (localStorage), so two open devices each keep
 * their own count; the cap is a ceiling on one page's spending, not the
 * account's.
 */

const LEDGER_KEY = (userId: string) => `dsul.backgroundPrep.v1.${userId}`;

function readLedger(userId: string): PrepLedger | null {
  try {
    const raw = localStorage.getItem(LEDGER_KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrepLedger;
    return typeof parsed?.day === 'string' && typeof parsed.count === 'number' && parsed.asked ? parsed : null;
  } catch {
    return null;
  }
}

function writeLedger(userId: string, ledger: PrepLedger): void {
  try {
    localStorage.setItem(LEDGER_KEY(userId), JSON.stringify(ledger));
  } catch {
    // Private mode or full: the cap then holds for this page only.
  }
}

export function useBackgroundPrep(): void {
  const userId = usePlannerStore((s) => s.userId);
  const enabled = useExtensionsStore((s) => s.isEnabled(EXT_DO_STUFF));
  const config = useExtensionsStore((s) => s.configs[EXT_DO_STUFF]);
  const on = enabled && backgroundPrepOn(config);
  const worker = backgroundPrepWorker(config);
  const { canPrep } = useAICapabilities();
  const targets = useHandOffTargets();
  const handTo = useDoStuffStore((s) => s.handTo);
  const target = targets.find((t) => t.assignee === handTo) ?? targets[0] ?? null;
  const ready = worker === 'model' ? canPrep : target !== null;

  // The tick reads the latest of these, so a changed target never restarts it.
  const latest = useRef({ worker, assignee: target?.assignee ?? null });
  useEffect(() => {
    latest.current = { worker, assignee: target?.assignee ?? null };
  }, [worker, target?.assignee]);

  // The agents besides OpenClaw are asked once, when an agent is to be used.
  useEffect(() => {
    if (on && worker === 'agent') void useAgentsStore.getState().load();
  }, [on, worker]);

  useEffect(() => {
    if (!userId || !on || !ready) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        await runOnce(userId, latest.current.worker, latest.current.assignee);
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, on, ready]);
}

async function runOnce(userId: string, worker: 'model' | 'agent', assignee: string | null): Promise<void> {
  const planner = usePlannerStore.getState();
  if (planner.userId !== userId) return;
  const tz = planner.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  const ledger = ledgerFor(readLedger(userId), todayStr);
  const room = remainingToday(ledger);
  if (room === 0) return;

  const prep = usePrepPacksStore.getState();
  if (worker === 'model') {
    await prep.load(userId);
    if (usePrepPacksStore.getState().available === false) return;
  }
  const packs = usePrepPacksStore.getState().packs;
  const inactiveIds = inactiveItemIdsOn(planner.items, todayStr, {
    userTimezone: tz,
    routines: planner.routines,
    seasons: planner.seasons,
    away: useAwayStore.getState().periods,
  });
  await useStuckStore.getState().load(userId);
  const stuck = (item: Item) => isStuck(movesOf(item.id));
  const all = prepCandidates(planner.items, {
    todayStr,
    inactiveIds,
    ledger,
    stuck,
    hasPack: (item) => {
      const pack = packs[item.id];
      return !!pack && !packIsStale(pack, item.title);
    },
  });

  if (worker === 'model') {
    const batch = all.slice(0, Math.min(PREP_BATCH, room));
    if (batch.length === 0) return;
    writeLedger(userId, recordAsked(ledger, batch, stuck));
    await usePrepPacksStore.getState().prepare(
      batch.map((item) => prepItemFor(item, planner.items)),
      { today: todayStr, again: true }
    );
    return;
  }

  // An agent is handed the item to get ready only, and that limit lives in
  // migration 078's column: until a read has shown it, nothing is handed over,
  // because the hand-off would land without its limit.
  if (!assignee || !aiModeColumnSeen()) return;
  const batch = agentCandidates(all, { todayStr, inactiveIds }).slice(0, Math.min(PREP_BATCH, room));
  if (batch.length === 0) return;
  writeLedger(userId, recordAsked(ledger, batch, stuck));
  for (const item of batch) handOffItem(item, assignee, { mode: 'prepare' });
}
