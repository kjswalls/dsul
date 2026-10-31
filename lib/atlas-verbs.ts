import { toast } from 'sonner';
import { usePlannerStore } from './planner-store';
import { ITEM_VERBS, type VerbContext } from './item-verbs';
import { toDateOnly } from './overdue';
import { isRecurring } from './recurrence';
import { ATLAS_COPY } from './atlas-copy';
import type { AtlasMember } from './atlas-model';

/**
 * The card-level verbs Atlas offers on a card's next step, shared by the focus
 * sheet (atlas-focus-sheet.tsx) and Walk (atlas-walk.tsx), so the two ask the
 * same gates (design rule 4). Every write is an ITEM_VERBS verb, re-read and
 * re-checked at click time: the button may have been painted from a snapshot.
 *
 * Atlas has no day of its own, so these act on today (`useToday()`'s day,
 * passed in), never on a formatted `new Date()`.
 */

/**
 * The verb context for today. The Date is the instant the store resolves the
 * write against, read when this is built. `occurrence` is what the card
 * already knows about the row today (AtlasMember.todayState): undefined for a
 * one-off.
 */
export function atlasTodayContext(
  todayStr: string,
  milestoneIds: ReadonlySet<string>,
  occurrence: VerbContext['occurrence']
): VerbContext {
  const tz = usePlannerStore.getState().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { dateStr: todayStr, date: new Date(), todayStr, tz, milestoneIds, occurrence };
}

/**
 * Whether "Put next step on Today" is offered for this row (rule 4): never a
 * milestone (its start date is its target date), the verb's own gate agrees,
 * and the step is not on today already. The caller also asks the card's
 * `nextOffersToday` (never recurring).
 */
export function canPutOnToday(next: AtlasMember, todayStr: string, milestoneIds: ReadonlySet<string>): boolean {
  if (milestoneIds.has(next.item.id)) return false;
  if (isRecurring(next.item as { repeatFrequency?: string })) return false;
  const start = 'startDate' in next.item && next.item.startDate ? toDateOnly(next.item.startDate) : undefined;
  if (start === todayStr) return false;
  return ITEM_VERBS.reschedule.eligible(next.item, atlasTodayContext(todayStr, milestoneIds, 'absent'));
}

/** `ITEM_VERBS.reschedule.run(item, ctx, today)`, re-read and re-checked. */
export function putNextOnToday(itemId: string, todayStr: string, milestoneIds: ReadonlySet<string>): boolean {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (!item || milestoneIds.has(item.id) || isRecurring(item as { repeatFrequency?: string })) return false;
  const ctx = atlasTodayContext(todayStr, milestoneIds, 'absent');
  if (!ITEM_VERBS.reschedule.eligible(item, ctx)) return false;
  ITEM_VERBS.reschedule.run(item, ctx, todayStr);
  toast(ATLAS_COPY.putOnTodayDone(item.title));
  return true;
}

/**
 * Whether the next step can be marked done today: ITEM_VERBS.complete's own
 * gate (one-directional, so it never un-completes), with what the card knows
 * about today (a recurring row on a day it doesn't fall on is not offered).
 */
export function canCompleteStep(next: AtlasMember, todayStr: string, milestoneIds: ReadonlySet<string>): boolean {
  if (next.todayState === 'absent') return false;
  return ITEM_VERBS.complete.eligible(next.item, atlasTodayContext(todayStr, milestoneIds, next.todayState));
}

/** `ITEM_VERBS.complete.run`, re-read and re-checked. */
export function completeStep(
  itemId: string,
  todayStr: string,
  milestoneIds: ReadonlySet<string>,
  occurrence: AtlasMember['todayState']
): boolean {
  if (occurrence === 'absent') return false;
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (!item) return false;
  const ctx = atlasTodayContext(todayStr, milestoneIds, occurrence);
  if (!ITEM_VERBS.complete.eligible(item, ctx)) return false;
  ITEM_VERBS.complete.run(item, ctx);
  return true;
}
