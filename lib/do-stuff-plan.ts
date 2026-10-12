import { guessSize, itemSizeOf, type ItemSize } from './item-size';
import { addDaysStr } from './container-schedule';

/**
 * Do stuff's plan: the braindump sorted into lanes (memory/plans/power-mode.md).
 *
 * Where a row lands is decided by plain rules first (Kirby's call, 2026-10-12):
 * the size the user gave it, or the guess its title earns, and whether the
 * agent could take it. The user moves any row with its lane chip, the number
 * keys or a swipe; that choice is memory only, like the rest of the mode, and
 * nothing is written until "make it so". Pure: no store, no React.
 */

export type Lane = 'done' | 'now' | 'calendar' | 'handoff' | 'leave';

export interface LaneDef {
  key: Lane;
  /** The lane header and the chip's word. */
  label: string;
  /** The key that moves a row here. Fixed, so muscle memory survives new lanes. */
  digit: '1' | '2' | '3' | '4' | '5';
  /** The header dot: a token, so it follows the theme. */
  color: string;
}

/**
 * In the order the plan draws them. "Done for you" is the prep packs' lane
 * (build order 3, lib/prep-packs.ts): a row lands there once the AI has got it
 * ready, and only such a row is offered it.
 */
export const LANES: readonly LaneDef[] = [
  { key: 'done', label: 'done for you', digit: '1', color: 'var(--lime-solid)' },
  { key: 'now', label: 'do now', digit: '2', color: 'var(--foreground)' },
  { key: 'calendar', label: 'on the calendar', digit: '3', color: 'var(--size-errand)' },
  { key: 'handoff', label: 'handed off', digit: '4', color: 'var(--size-fuzzy)' },
  { key: 'leave', label: 'left alone', digit: '5', color: 'var(--muted-foreground)' },
];

const BY_KEY = new Map(LANES.map((l) => [l.key, l]));

export function laneDef(lane: Lane): LaneDef {
  return BY_KEY.get(lane)!;
}

export function laneForDigit(key: string): Lane | undefined {
  return LANES.find((l) => l.digit === key)?.key;
}

/** What one row can be, asked of the caller (the gates live elsewhere). */
export interface LaneFacts {
  /** A task-like that takes a size; a habit recurs and is left alone. */
  plannable: boolean;
  /** `canHandOff` (lib/agent-handoff.ts), asked at render time. */
  canHandOff: boolean;
  /** The agent already holds it: queued, working, or waiting on you. */
  handedOff: boolean;
  /** The AI got it ready: a prep pack written for its current title. */
  hasPack?: boolean;
}

/** May the user put this row in this lane? */
export function laneOffered(lane: Lane, facts: LaneFacts): boolean {
  switch (lane) {
    case 'done':
      return !!facts.hasPack && facts.plannable && !facts.handedOff;
    case 'handoff':
      return facts.handedOff || facts.canHandOff;
    case 'leave':
      return true;
    default:
      return facts.plannable && !facts.handedOff;
  }
}

/** The size the rules read: the user's own, else the title's guess. */
export function sizeForPlan(item: { title: string; size?: unknown }): ItemSize | undefined {
  return itemSizeOf(item) ?? guessSize(item.title);
}

/**
 * The rule. Anything the AI got ready is done for you; quick things are done now; errands and big ones go on a day;
 * fuzzy ones go to the agent when it can take them (a first step is exactly
 * what it is for), and are left alone otherwise. Anything the rules cannot
 * read is left alone rather than pushed at the user.
 */
export function ruleLane(item: { title: string; size?: unknown }, facts: LaneFacts): Lane {
  if (facts.handedOff) return 'handoff';
  if (!facts.plannable) return 'leave';
  if (facts.hasPack) return 'done';
  switch (sizeForPlan(item)) {
    case 'quick':
      return 'now';
    case 'errand':
    case 'big':
      return 'calendar';
    case 'fuzzy':
      return facts.canHandOff ? 'handoff' : 'leave';
    default:
      return 'leave';
  }
}

/** The row's lane: the user's move if it is still offered, else the rule's. */
export function laneOf(
  item: { id: string; title: string; size?: unknown },
  facts: LaneFacts,
  moved: Readonly<Record<string, Lane>>
): Lane {
  const pick = moved[item.id];
  if (pick && laneOffered(pick, facts)) return pick;
  return ruleLane(item, facts);
}

/** The next offered lane up (-1) or down (+1) from this one: a swipe's move. */
export function stepLane(lane: Lane, dir: -1 | 1, facts: LaneFacts): Lane {
  const keys = LANES.map((l) => l.key);
  for (let i = keys.indexOf(lane) + dir; i >= 0 && i < keys.length; i += dir) {
    if (laneOffered(keys[i], facts)) return keys[i];
  }
  return lane;
}

/**
 * Which day each calendar row lands on, until a free-slot finder exists: on a
 * day, not at a time. Errands batch, so they share tomorrow; everything else
 * takes a day of its own from tomorrow on, so a pile of big things is spread
 * out rather than stacked. Rows come in the plan's order.
 */
export function placeOnDays(
  rows: readonly { id: string; title: string; size?: unknown }[],
  todayStr: string
): Map<string, string> {
  const days = new Map<string, string>();
  let next = 1;
  for (const row of rows) {
    if (sizeForPlan(row) === 'errand') days.set(row.id, addDaysStr(todayStr, 1));
    else days.set(row.id, addDaysStr(todayStr, next++));
  }
  return days;
}

/**
 * The first open row in the "do now" lane, passing over what was skipped;
 * once only skipped ones are left they come round again in the order they
 * were skipped, so "skip" means "later", never "gone".
 */
export function nextNow<R extends { item: { id: string } }>(
  rows: readonly R[],
  isOpen: (row: R) => boolean,
  skipped: readonly string[]
): R | undefined {
  const open = rows.filter(isOpen);
  const fresh = open.find((r) => !skipped.includes(r.item.id));
  if (fresh) return fresh;
  for (const id of skipped) {
    const again = open.find((r) => r.item.id === id);
    if (again) return again;
  }
  return undefined;
}
