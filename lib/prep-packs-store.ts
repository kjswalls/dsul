import { create } from 'zustand';
import { useAISettingsStore } from './ai-settings-store';
import { researchOn } from './background-prep';
import { writingStyleOf } from './writing-style';
import { AI_KNOWS_KEY, aiKnowsOf, withKnown } from './ai-knows';
import { isStuck } from './stuck';
import { movesOf } from './stuck-store';
import { EXT_DO_STUFF } from './extension-registry';
import { useExtensionsStore } from './extensions-store';
import type { Item } from './planner-types';
import { usePlannerStore } from './planner-store';
import { milestoneItemIds } from './goals';
import { scheduleTaskPatch } from './item-edit';
import { getBucketForTime } from './time-bucket';
import { answersNote, meantNote, PREP_BATCH, type Pack, type PrepPack } from './prep-packs';
import { toDateStr } from './recurrence';

/** The person's clock as HH:mm in their zone, for "a time later than now". */
function clockNow(tz: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date());
  } catch {
    return undefined;
  }
}

/** The answer kept in the notes, with the pages it came from under it. */
export function answerNotes(notes: string | undefined, answer: string, sources?: { url: string }[]): string {
  const block = [answer.trim(), ...(sources ?? []).map((s) => s.url)].join('\n');
  const before = (notes ?? '').trimEnd();
  return before ? `${before}\n\n${block}` : block;
}

/** How long Discard can be undone before the pack is deleted for good. */
export const UNDO_MS = 6000;

/**
 * The prep packs the account has, and the asks in flight (lib/prep-packs.ts;
 * /api/ai/prep is the one reader and writer). Memory only: the packs live in
 * the database, and this is the copy the open page draws from.
 *
 * Asked by Do stuff when it starts, while the person's own model answers
 * (`canPrep`). An item is asked about at most once a session, whether or not
 * a pack came back, so starting the mode again never pays twice for the same
 * "nothing to prepare here".
 */

export interface PrepItem {
  id: string;
  title: string;
  notes?: string;
  /** The project it is filed under, for tone and who it is for. */
  project?: string;
  /** The day it is planned for, yyyy-MM-dd. */
  day?: string;
  /** Its open subtasks' titles, so steps build on them. */
  subtasks?: string[];
  /** Moved to another day again and again (lib/stuck.ts): the first step gets tiny. */
  stuck?: true;
}

/** An item as prep reads it: its own words plus the context around it. */
export function prepItemFor(item: Item, all: readonly Item[]): PrepItem {
  const notes = (item as { notes?: string }).notes?.trim();
  const project = (item as { project?: string }).project?.trim();
  const day = (item as { startDate?: string }).startDate;
  const subtasks = all
    .filter((c) => (c as { parentItemId?: string }).parentItemId === item.id && c.type !== 'habit')
    .filter((c) => (c as { status?: string }).status !== 'completed' && (c as { status?: string }).status !== 'cancelled')
    .map((c) => c.title)
    .slice(0, 10);
  return {
    id: item.id,
    title: item.title,
    ...(notes ? { notes } : {}),
    ...(project ? { project } : {}),
    ...(day ? { day } : {}),
    ...(subtasks.length > 0 ? { subtasks } : {}),
    ...(isStuck(movesOf(item.id)) ? { stuck: true as const } : {}),
  };
}

interface PrepPacksState {
  /** Whose packs these are; a different account starts over. */
  userId: string | null;
  packs: Record<string, PrepPack>;
  /** False once the server said the table is not there yet (074 unapplied). */
  available: boolean | null;
  loaded: boolean;
  /** Items being prepared right now. */
  preparing: Record<string, true>;
  /** Items asked about this session. */
  tried: Record<string, true>;
  /** The last ask's failure, in our own words, until the next ask. */
  error: string | null;
  load: (userId: string) => Promise<void>;
  /**
   * Reads the packs again, the server's copy winning: an agent saved one from
   * outside the browser (MCP's dsul_save_prep), so the store has not seen it.
   */
  refresh: (userId: string) => Promise<void>;
  /**
   * Asks for packs. `today` is the user's own day, for timing. `again` asks
   * about items already tried or prepared: an answered question, or an item
   * that changed since its last ask.
   */
  prepare: (items: readonly PrepItem[], opts?: { today?: string; again?: boolean }) => Promise<void>;
  /** Lets a pack go; returns its undo, or null when there was none. */
  dismiss: (itemId: string) => (() => void) | null;
  /**
   * Answers a question pack: the answers go into the item's notes, a line
   * each (where the user can see and change them, and the next ask reads
   * them), the question is deleted, and the item is asked about again. A
   * bare string answers the first question. `remember` also keeps the
   * answers for every item (lib/ai-knows.ts), the person's own tick.
   */
  answer: (
    itemId: string,
    answers: string | readonly { question: string; answer: string }[],
    opts?: { remember?: boolean }
  ) => void;
  /**
   * "Not quite?": the person says what the item meant. The line goes into the
   * notes as "I meant: …", the pack built on the wrong reading is deleted, and
   * the item is asked about again.
   */
  reread: (itemId: string, meant: string) => void;
  /**
   * Takes a pack that acts on the planner (packApplies): adds its subtasks,
   * keeps its answer in the notes, or puts the item on the day at its time.
   * The write is one planner action, so ⌘Z undoes it; the pack is then gone.
   * `pack` is the card's, with the person's edits. Returns what to say.
   */
  apply: (itemId: string, pack: Pack) => string | null;
  /**
   * The pack's drafted steps were all kept or dropped one by one in the item
   * panel (components/planner/drafted-steps.tsx), which wrote the subtasks
   * itself: the pack goes, with nothing to undo here.
   */
  settle: (itemId: string) => void;
}

const EMPTY = {
  packs: {},
  available: null,
  loaded: false,
  preparing: {},
  tried: {},
  error: null,
};

function byItem(list: readonly PrepPack[]): Record<string, PrepPack> {
  return Object.fromEntries(list.map((p) => [p.itemId, p]));
}

/**
 * Writes what the person told the AI into the item's notes, drops the pack it
 * replaces, and asks about the changed item again: the one path an answer and
 * a corrected reading share.
 */
function rewriteNotes(itemId: string, write: (notes: string | undefined) => string, label: string): void {
  const planner = usePlannerStore.getState();
  const item = planner.items.find((i) => i.id === itemId);
  if (!item || item.type === 'habit') return;
  const notes = write((item as { notes?: string }).notes);
  planner.updateTask(itemId, { notes }, { label: `${label}: ${item.title}` });
  usePrepPacksStore.setState((s) => {
    const packs = { ...s.packs };
    delete packs[itemId];
    return { packs };
  });
  // The ask after it replaces the row anyway, so the pack goes now; a delete
  // that fails leaves it for the next load, under the new pack.
  void fetch(`/api/ai/prep?item=${encodeURIComponent(itemId)}`, { method: 'DELETE' }).catch(() => {});
  const next = { ...item, notes } as Item;
  void usePrepPacksStore.getState().prepare([prepItemFor(next, usePlannerStore.getState().items)], {
    today: toDateStr(new Date(), plannerZone()),
    again: true,
  });
}

const plannerZone = () => usePlannerStore.getState().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

export const usePrepPacksStore = create<PrepPacksState>((set, get) => ({
  userId: null,
  ...EMPTY,

  load: async (userId) => {
    if (get().userId !== userId) set({ userId, ...EMPTY });
    else if (get().loaded) return;
    try {
      const res = await fetch('/api/ai/prep', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { packs?: PrepPack[]; available?: boolean };
      if (get().userId !== userId) return;
      set((s) => ({
        loaded: true,
        available: body.available ?? true,
        packs: { ...byItem(body.packs ?? []), ...s.packs },
      }));
    } catch {
      // Offline or signed out: no packs, and the next start asks again.
    }
  },

  refresh: async (userId) => {
    if (get().userId !== userId || !get().loaded) return get().load(userId);
    try {
      const res = await fetch('/api/ai/prep', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { packs?: PrepPack[] };
      if (get().userId !== userId) return;
      set((s) => {
        const fresh = byItem(body.packs ?? []);
        // An item being prepared here keeps what this page is about to write.
        for (const id of Object.keys(s.preparing)) delete fresh[id];
        return { packs: { ...s.packs, ...fresh } };
      });
    } catch {
      // Offline: the next refresh asks again.
    }
  },

  prepare: async (items, opts = {}) => {
    const s = get();
    if (s.available === false) return;
    const ask = items
      .filter((i) => !s.preparing[i.id] && (opts.again || (!s.tried[i.id] && !s.packs[i.id])))
      .slice(0, PREP_BATCH);
    if (ask.length === 0) return;
    const ids = Object.fromEntries(ask.map((i) => [i.id, true as const]));
    set((st) => ({ preparing: { ...st.preparing, ...ids }, tried: { ...st.tried, ...ids }, error: null }));
    const done = () =>
      set((st) => ({
        preparing: Object.fromEntries(Object.entries(st.preparing).filter(([id]) => !ids[id])),
      }));
    const style = writingStyleOf(useExtensionsStore.getState().configs[EXT_DO_STUFF]);
    const knows = aiKnowsOf(useExtensionsStore.getState().configs[EXT_DO_STUFF]);
    try {
      const res = await fetch('/api/ai/prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: ask,
          ...(opts.today ? { today: opts.today, now: clockNow(plannerZone()) } : {}),
          customInstructions: useAISettingsStore.getState().systemPrompt,
          // How you write (lib/writing-style.ts), when there is any.
          ...(style ? { style } : {}),
          // What your AI knows (lib/ai-knows.ts), when there is any.
          ...(knows ? { knows } : {}),
          // The research switch (lib/background-prep.ts); the route asks only
          // a provider that can search.
          ...(researchOn(useExtensionsStore.getState().configs[EXT_DO_STUFF])
            ? { research: true, timezone: usePlannerStore.getState().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        packs?: PrepPack[];
        error?: string;
        available?: boolean;
      };
      if (!res.ok) {
        set({ error: body.error ?? "Couldn't get things ready.", ...(body.available === false ? { available: false } : {}) });
        return;
      }
      set((st) => ({ packs: { ...st.packs, ...byItem(body.packs ?? []) } }));
    } catch {
      set({ error: "Couldn't get things ready." });
    } finally {
      done();
    }
  },

  answer: (itemId, answers, opts = {}) => {
    const was = get().packs[itemId];
    if (!was || was.pack.kind !== 'question') return;
    const list =
      typeof answers === 'string' ? [{ question: was.pack.question, answer: answers }] : answers;
    if (!list.some((a) => a.answer.trim())) return;
    const userId = get().userId;
    if (opts.remember && userId) {
      const ext = useExtensionsStore.getState();
      const known = withKnown(
        aiKnowsOf(ext.configs[EXT_DO_STUFF]),
        list.filter((a) => a.answer.trim()).map((a) => `${a.question.trim()} ${a.answer.trim()}`)
      );
      ext.setConfigValue(userId, EXT_DO_STUFF, AI_KNOWS_KEY, known);
    }
    rewriteNotes(itemId, (notes) => answersNote(notes, list), 'Answer');
  },

  reread: (itemId, meant) => {
    if (!get().packs[itemId] || !meant.trim()) return;
    rewriteNotes(itemId, (notes) => meantNote(notes, meant), 'Meant');
  },

  settle: (itemId) => {
    if (!get().packs[itemId]) return;
    set((s) => {
      const packs = { ...s.packs };
      delete packs[itemId];
      return { packs };
    });
    void fetch(`/api/ai/prep?item=${encodeURIComponent(itemId)}`, { method: 'DELETE' }).catch(() => {});
  },

  apply: (itemId, pack) => {
    if (!get().packs[itemId]) return null;
    const planner = usePlannerStore.getState();
    const item = planner.items.find((i) => i.id === itemId);
    if (!item || item.type === 'habit') return null;
    let said: string;
    if (pack.kind === 'subtasks') {
      const titles = pack.subtasks.map((t) => t.trim()).filter(Boolean);
      if (titles.length === 0) return null;
      planner.addTasksBulk('task', titles.map((title) => ({ title, parentItemId: itemId })));
      said = titles.length === 1 ? 'Added 1 subtask' : `Added ${titles.length} subtasks`;
    } else if (pack.kind === 'answer') {
      if (!pack.answer.trim()) return null;
      const notes = answerNotes((item as { notes?: string }).notes, pack.answer, pack.sources);
      planner.updateTask(itemId, { notes }, { label: `Keep the answer: ${item.title}` });
      said = 'Kept in its notes';
    } else if (pack.kind === 'time') {
      // A goal's milestone keeps its target date (memory/plans/long-term-goals.md):
      // it takes the time only.
      const milestone = milestoneItemIds(planner.goals).has(itemId);
      const date = milestone ? undefined : pack.date ?? toDateStr(new Date(), plannerZone());
      planner.updateTask(
        itemId,
        {
          ...scheduleTaskPatch(getBucketForTime(pack.time), pack.time),
          ...(date ? { startDate: date } : {}),
          ...(pack.duration ? { duration: pack.duration } : {}),
        },
        { label: `Schedule task: ${item.title}` }
      );
      said = 'On the day';
    } else {
      return null;
    }
    set((s) => {
      const packs = { ...s.packs };
      delete packs[itemId];
      return { packs };
    });
    void fetch(`/api/ai/prep?item=${encodeURIComponent(itemId)}`, { method: 'DELETE' }).catch(() => {});
    return said;
  },

  dismiss: (itemId) => {
    const was = get().packs[itemId];
    if (!was) return null;
    set((s) => {
      const packs = { ...s.packs };
      delete packs[itemId];
      return { packs };
    });
    // The delete waits out the undo: until it goes, Undo only has to put the
    // pack back in memory, and nothing is ever re-written to the server.
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      void (async () => {
        try {
          const res = await fetch(`/api/ai/prep?item=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(String(res.status));
        } catch {
          // Put it back: a pack that comes back on the next load reads as a ghost.
          set((s) => ({ packs: { ...s.packs, [itemId]: was } }));
        }
      })();
    }, UNDO_MS);
    return () => {
      undone = true;
      clearTimeout(timer);
      set((s) => ({ packs: { ...s.packs, [itemId]: was } }));
    };
  },
}));
