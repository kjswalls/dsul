import type { Goal } from './planner-types';
import type { AtlasCard } from './atlas-model';
import type { AtlasLayout } from './view-store';
import type { Point } from './atlas-camera';
import { ATLAS_CARD_W } from './atlas-seed';
import { batchHistory, usePlannerStore } from './planner-store';
import { useAtlasStore } from './atlas-store';
import { ATLAS_COPY } from './atlas-copy';
import { formatDay } from './active';
import { toDateOnly } from './overdue';
import { bandLabel, type MomentumResult } from './atlas-momentum';
import { laneAt, type AtlasLayoutResult } from './atlas-layouts';
import { linkableIds, unlinkPatches } from './atlas-by-goal';
import { TIMELINE_DAY_PX, dateForX, targetAllowed } from './atlas-timeline';

/**
 * What a card drop means, per layout (design 2.3): a drag always means
 * something, or it springs back with a reason. Returns what to say; the card
 * springs back by itself whenever nothing moved it (the glide).
 *
 * | Your map | move the card (atlas-store `place`) |
 * | Momentum | into a column pins it there; into the app's own column unpins |
 * | By goal  | into a goal's lane links, into "Not feeding a goal" unlinks, lane to lane moves (one undo) |
 * | Timeline | a goal's target date, snapped to a day (one undo); anything else springs back |
 *
 * Pins are a view preference (no undo, like places). Item and goal writes go
 * through planner-store, so they are in history and the undo strip offers
 * Undo (lib/atlas-copy.ts words each, with a prefix use-undo-toast counts).
 */

export interface DropArgs {
  layout: AtlasLayout;
  card: AtlasCard;
  /** Where the card was let go (world px, its top-left). */
  to: Point;
  result: AtlasLayoutResult;
  /** Momentum: the card's band as drawn. */
  band?: MomentumResult;
  /** Momentum: where the card sits on Your map, for a pin on a placeless row. */
  mapAt?: Point;
  /** By goal: the card's lane now (a goal id, or null). */
  lane?: string | null;
  /** By goal and Timeline: the goals shown (gated by the Goals extension). */
  goals: readonly Goal[];
  goalsShown: boolean;
}

export interface DropOutcome {
  /** Something was written. */
  wrote: boolean;
  /** A line to show (a spring-back reason, or a pin said out loud). */
  message?: string;
}

const NOTHING: DropOutcome = { wrote: false };

export function dropCard(a: DropArgs): DropOutcome {
  const { card } = a;
  if (a.layout === 'map') {
    useAtlasStore.getState().place(card.kind, card.id, a.to.x, a.to.y);
    return { wrote: true };
  }
  if (a.layout === 'momentum') return dropMomentum(a);
  if (a.layout === 'goal') return dropByGoal(a);
  return dropTimeline(a);
}

function dropMomentum(a: DropArgs): DropOutcome {
  const lane = laneAt(a.result, 'momentum', a.to);
  if (!lane || lane.kind !== 'band') return { wrote: false, message: ATLAS_COPY.dropInColumn };
  const band = lane.id as MomentumResult['band'];
  const now = a.band;
  if (now && band === now.band) return NOTHING;
  const store = useAtlasStore.getState();
  // Into the app's own column: the pin is handed back, not stored twice.
  if (now && band === now.appBand) {
    store.pin(a.card.kind, a.card.id, null);
    return { wrote: true, message: ATLAS_COPY.unpinned(a.card.name) };
  }
  store.pin(a.card.kind, a.card.id, band, a.mapAt);
  return { wrote: true, message: ATLAS_COPY.pinned(a.card.name, bandLabel(band)) };
}

function dropByGoal(a: DropArgs): DropOutcome {
  if (!a.goalsShown) return NOTHING;
  const { card } = a;
  if (card.kind === 'goal') return { wrote: false, message: ATLAS_COPY.goalsStay };
  const lane = laneAt(a.result, 'goal', a.to);
  if (!lane) return { wrote: false, message: ATLAS_COPY.dropInLane };
  const target = lane.kind === 'goal' ? lane.id : null;
  const from = a.lane ?? null;
  if (target === from) return NOTHING;

  const store = usePlannerStore.getState();
  const goals = store.goals;
  const goalNamed = (id: string) => goals.find((g) => g.id === id);

  if (target === null) {
    // Unlink: from EVERY goal whose feeders hold the card's items, feeders
    // only, so milestones and check-ins stay. One undo.
    const patches = unlinkPatches(card, goals);
    if (patches.length === 0) return NOTHING;
    const label =
      patches.length === 1
        ? ATLAS_COPY.unlinked(card.name, goalNamed(patches[0].goalId)?.name ?? '')
        : ATLAS_COPY.unlinkedMany(card.name, patches.length);
    batchHistory(label, card.members.length, () => {
      for (const p of patches) usePlannerStore.getState().updateGoal(p.goalId, { memberIds: p.memberIds });
    });
    return { wrote: true };
  }

  const goal = goalNamed(target);
  if (!goal) return NOTHING;
  const ids = linkableIds(card);
  if (ids.length === 0) return { wrote: false, message: ATLAS_COPY.nothingToLink };

  if (from === null) {
    batchHistory(ATLAS_COPY.linked(ids.length, goal.name), ids.length, () => {
      usePlannerStore.getState().setItemsGoal(ids, goal.id, true);
    });
    return { wrote: true };
  }

  // Lane to lane: off the source goal's feeders, onto the target's, one undo.
  const source = goalNamed(from);
  batchHistory(ATLAS_COPY.moved(card.name, goal.name), ids.length, () => {
    if (source) {
      const held = new Set(card.members.map((m) => m.item.id));
      usePlannerStore.getState().updateGoal(source.id, { memberIds: source.memberIds.filter((id) => !held.has(id)) });
    }
    usePlannerStore.getState().setItemsGoal(ids, goal.id, true);
  });
  return { wrote: true };
}

/** The day a goal card's diamond points at, for its top-left `x`. */
export function goalDayAt(result: AtlasLayoutResult, x: number): string | null {
  const tl = result.timeline;
  if (!tl) return null;
  return dateForX(tl.window, x + ATLAS_CARD_W / 2 - TIMELINE_DAY_PX / 2);
}

function dropTimeline(a: DropArgs): DropOutcome {
  const { card } = a;
  if (card.kind === 'routine') return { wrote: false, message: ATLAS_COPY.routineNoDate };
  if (card.kind === 'season') return { wrote: false, message: ATLAS_COPY.seasonsFollowDates };
  if (card.kind !== 'goal') return { wrote: false, message: ATLAS_COPY.projectsFollowDates };
  if (!a.goalsShown) return NOTHING;
  const tl = a.result.timeline;
  if (!tl) return NOTHING;
  const goal = usePlannerStore.getState().goals.find((g) => g.id === card.id);
  if (!goal) return NOTHING;
  // An undated goal takes a date only when let go above "No dates".
  if (!goal.targetOn && a.to.y + 40 >= tl.noDatesY) return { wrote: false, message: ATLAS_COPY.dropAboveNoDates };
  const day = goalDayAt(a.result, a.to.x);
  if (!day) return NOTHING;
  if (goal.targetOn && toDateOnly(goal.targetOn) === day) return NOTHING;
  if (!targetAllowed(goal, day)) {
    return { wrote: false, message: ATLAS_COPY.cantEndBeforeStart(formatDay(goal.startsOn!)) };
  }
  batchHistory(ATLAS_COPY.targetMoved(goal.name, formatDay(day)), 1, () => {
    usePlannerStore.getState().updateGoal(goal.id, { targetOn: day });
  });
  return { wrote: true };
}
