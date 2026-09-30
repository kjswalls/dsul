import type { DragInput } from './sensors';

/**
 * Which drop targets each input type is offered — the one place that answers it.
 *
 * ## What this is for
 *
 * The droppable grammar in lib/dnd/CONTRACT.md was written for a cursor. One
 * entry in it is a target a finger cannot use:
 * `scheduled:{bucket}:{before|after}:{ref}` is an 8px sliver between two timed
 * rows (`h-2 -my-0.5`, `day-buckets.tsx`). Against WCAG 2.5.8's 24px minimum
 * target size that is a third of the floor, on the input with the coarsest
 * pointer.
 *
 * Mechanically it is a MOVE like every other drop — `inferDropTime` resolves it
 * as ±30 min from the reference row's own time — so it is not the
 * drag-to-reorder that `dnd-no-reorder.test.ts` forbids, and it survived that
 * sweep. Kirby's call: remove it for touch, and accept the cost — on a phone
 * there is no longer a way to say "put this just before that one"; you drop the
 * row in the bucket and set its time. Mouse and pen keep it exactly as it was.
 *
 * ## The finger gets the BUCKET in the same place, not nothing
 *
 * `spine:{bucket}:{above|below}:{itemId}` is the touch-only replacement, and it
 * is not a nicety — deleting the sliver outright is a silent wrong-bucket bug.
 * Collision is `closestCenter`, which compares CENTRES, not containment
 * (`tests/e2e/helpers/dnd.ts` says so). Withhold the slivers and the lowest
 * droppable centre a tall bucket card owns jumps up to the card's own middle, so
 * the lower band of that card starts resolving to the NEXT bucket: measured, a
 * drop just under the last timed row in Morning came back as `afternoon`. The
 * band opens once the dragged-over card is taller than the next card plus two
 * gaps — about four timed rows — and grows without bound after that.
 *
 * So the touch rule is a SUBSTITUTION, not a deletion. The same 8px boxes mount
 * for a finger carrying the spine id instead, which keeps every droppable centre
 * exactly where main put it — touch geometry is unchanged to the pixel — while
 * the COMMAND behind them changes from "schedule at that row's time ±30 min" to
 * "assign this bucket, no time", i.e. precisely the fallback Kirby named.
 * `tests/unit/dnd-touch-drop-geometry.test.tsx` pins the band shut.
 *
 * ## Why a table and not an `isTouch &&`
 *
 * Two rules, at two levels, and they answer different questions:
 *
 * - The **view-level rule** — what should this user be OFFERED? That is per
 *   view: it is about geometry and affordance, and only the view knows what it
 *   renders, which is why the substitution above can only happen there.
 * - The **grammar-level rule** — what does this id MEAN for this input? That is
 *   a total function over every id shape in CONTRACT.md and every view that will
 *   ever emit one, and it lives in `resolveDrop`.
 *
 * Neither is redundant and neither is a backstop for the other. What they share
 * is the answer, and that is what this file is: a `Record` keyed by the target
 * KIND, so the rule is stated once instead of at each site (the scattering the
 * registry convention in CLAUDE.md exists to prevent), and so a new kind of drop
 * target fails `tsc` until someone answers "can a thumb hit this?".
 *
 * ### D2 — the view-level rule is currently implemented at ONE mount site
 *
 * `TimedGapDropZone` in `day-buckets.tsx` is the only droppable that consults
 * this table before mounting. `EmptyBucketDropZone`, the week cells, the hour
 * slots, the project blocks and the braindump do not. That is harmless today,
 * because `relative-time` and `bucket-spine` are the only restricted kinds and
 * both live in that one component — but it means withholding some FUTURE kind
 * from an input would fire the grammar-level rule alone, and the drop would
 * become a silent no-op instead of resolving somewhere sensible. Restricting a
 * new kind means giving its mount site the same gate.
 */
export type DropTargetKind =
  /** `scheduled:{bucket}:{before|after}:{refType}:{refId}` — the 8px sliver. */
  | 'relative-time'
  /** `spine:{bucket}:{above|below}:{itemId}` — the same box, for a finger. */
  | 'bucket-spine'
  /** `scheduled:{bucket}:empty` — the labelled tray in an empty timed section. */
  | 'bucket-timed'
  /** `unscheduled:{bucket}` and the bare `{bucket}` fallback. */
  | 'bucket-untimed'
  /** `week:{date}:{bucket}` — a week-view day cell, Anytime strip included. */
  | 'week-cell'
  /** `hour:{H}` and `weekhour:{date}:{H}` — a schedule-grid hour slot. */
  | 'hour-slot'
  /** `projectblock:{name}`. */
  | 'project-block'
  /** `sidebar` — the braindump. */
  | 'braindump'
  /** `list:{date}` — a list-layout day: the Day × List body, a Week × List section. */
  | 'list-day';

const EVERY_INPUT: readonly DragInput[] = ['pointer', 'touch'];
/** Mouse and pen only — a target a fingertip cannot aim. */
const POINTER_ONLY: readonly DragInput[] = ['pointer'];
/** A finger only — the substitute that stands in the aimable one's place. */
const TOUCH_ONLY: readonly DragInput[] = ['touch'];

/**
 * The rule itself. Everything is offered to everything, except the one pair
 * that swaps: in each 8px gap between two timed rows, a cursor gets
 * `relative-time` and a finger gets `bucket-spine`. Exactly one of the two is
 * offered to any given input — `dnd-touch-drop-targets.test.tsx` asserts it,
 * because mounting two would double the centres in the spine and mounting
 * neither opens the wrong-bucket band described above.
 *
 * Note what is NOT restricted, because the boundary is the point: every other
 * mobile drag Kirby kept lands here — row → another bucket (`bucket-untimed`),
 * row → another day (`week-cell`), row → an hour on the schedule grid
 * (`hour-slot`), row → a project block, braindump → grid, and the labelled
 * "Drop here to schedule with time" tray (`bucket-timed`), which is a 40px box
 * with a label, not a sliver between rows.
 */
export const OFFERED_TO: Record<DropTargetKind, readonly DragInput[]> = {
  'relative-time': POINTER_ONLY,
  'bucket-spine': TOUCH_ONLY,
  'bucket-timed': EVERY_INPUT,
  'bucket-untimed': EVERY_INPUT,
  'week-cell': EVERY_INPUT,
  'hour-slot': EVERY_INPUT,
  'project-block': EVERY_INPUT,
  braindump: EVERY_INPUT,
  'list-day': EVERY_INPUT,
};

const BARE_BUCKETS = new Set(['anytime', 'morning', 'afternoon', 'evening']);

/**
 * Parse a droppable id into its kind, or `null` if the grammar does not know it.
 *
 * This mirrors `resolveDrop`'s parse rather than sharing it, because the mount
 * site needs the answer while the drop is still hypothetical — there is no
 * command to classify yet. `dnd-touch-drop-targets.test.tsx` runs the same id
 * list through both, so the two cannot drift apart silently.
 */
export function dropTargetKind(targetId: string): DropTargetKind | null {
  if (targetId.startsWith('scheduled:')) {
    const position = targetId.split(':')[2];
    if (position === 'empty') return 'bucket-timed';
    if (position === 'before' || position === 'after') return 'relative-time';
    return null;
  }
  if (targetId.startsWith('spine:')) return 'bucket-spine';
  if (targetId.startsWith('unscheduled:')) return 'bucket-untimed';
  if (BARE_BUCKETS.has(targetId)) return 'bucket-untimed';
  if (targetId.startsWith('weekhour:') || targetId.startsWith('hour:')) return 'hour-slot';
  if (targetId.startsWith('week:')) return 'week-cell';
  if (targetId.startsWith('projectblock:')) return 'project-block';
  if (targetId === 'sidebar') return 'braindump';
  if (targetId.startsWith('list:')) return 'list-day';
  return null;
}

/**
 * May this input type reach this drop target?
 *
 * An id the grammar does not recognise answers YES — permissive, so a droppable
 * added without a kind keeps behaving as it always did rather than vanishing for
 * half the users. The test that keeps that honest is the one asserting every id
 * in CONTRACT.md § Droppable IDs classifies to a non-null kind: a new grammar
 * entry that nobody classified fails there, not in production.
 */
export function isDropTargetOffered(targetId: string, input: DragInput): boolean {
  const kind = dropTargetKind(targetId);
  return kind === null || OFFERED_TO[kind].includes(input);
}
