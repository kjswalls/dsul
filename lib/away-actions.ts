import { toast } from 'sonner';
import { usePlannerStore } from './planner-store';
import { useAwayStore, type AwayInputs } from './away-store';
import { useUIStore } from './ui-store';
import { useExtensionsStore } from './extensions-store';
import { EXT_BEEMINDER } from './extension-registry';
import { goalForTitle } from './stakes/goal-map';
import { isRecurring, toDateStr } from './recurrence';
import { currentAway, isDayBound, isKeptOn, suggestKeeps, upcomingAway, type AwayKeep, type AwayPeriod } from './away';
import { shortAwayDay } from './away-dates';
import type { Item, Routine } from './planner-types';

/**
 * away-actions.ts — vacation mode's verbs as the screens call them.
 *
 * Every surface that starts or ends a trip (the ⌘K line, the card, the line
 * beside the date) comes through here, so the toast, the default keep list and
 * the inputs the store needs are decided once. The rule is lib/away.ts; the
 * store is lib/away-store.ts.
 */

type KeepItem = Item & { projectId?: string; parentItemId?: string };

/** What the store's verbs need, read from the planner now. */
export function awayInputsNow(): AwayInputs {
  const p = usePlannerStore.getState();
  const tz = p.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { items: p.items, routines: p.routines, todayStr: toDateStr(new Date(), tz) };
}

/** The trip the card and the line are about: the one you are on, else the one coming. */
export function activeTrip(periods: readonly AwayPeriod[], todayStr: string): AwayPeriod | undefined {
  return currentAway(periods, todayStr) ?? upcomingAway(periods, todayStr);
}

/** The keep list a new trip starts with: what you have done every day this month. */
export function defaultKeep(items: readonly Item[], todayStr: string): AwayKeep {
  return { itemIds: suggestKeeps(items, todayStr), routineIds: [], projectIds: [] };
}

/** The habits and routines the keep picker offers, in the order it shows them. */
export function keepChoices(items: readonly Item[]): Item[] {
  return items
    .filter((i) => isRecurring(i as Item & { repeatFrequency?: string }) && !(i as KeepItem).parentItemId)
    .filter((i) => i.status !== 'cancelled' && !(i as { archivedAt?: string }).archivedAt)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Names of what keeps going, as a sentence's subject: "Take meds and Water the plants". */
export function keepNames(keep: AwayKeep, items: readonly Item[], routines: readonly Routine[]): string[] {
  const names: string[] = [];
  for (const r of routines) if (keep.routineIds.includes(r.id)) names.push(r.name);
  for (const i of items) if (keep.itemIds.includes(i.id) && isRecurring(i as Item & { repeatFrequency?: string })) names.push(i.title);
  return names;
}

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** "Take meds and Water the plants keep going. Everything else rests." */
export function keepSentence(keep: AwayKeep, items: readonly Item[], routines: readonly Routine[]): string {
  const names = keepNames(keep, items, routines);
  if (names.length === 0) return 'Everything rests.';
  return `${joinNames(names)} ${names.length === 1 ? 'keeps' : 'keep'} going. Everything else rests.`;
}

/** How many things still run today on this trip: day-bound items the keep list holds. */
export function stillRunning(trip: AwayPeriod, items: readonly Item[], routines: readonly Routine[]): number {
  return items.filter((i) => isDayBound(i) && i.status !== 'cancelled' && isKeptOn(i as KeepItem, trip, routines)).length;
}

/**
 * The paused habits wired to a Beeminder goal. A held habit sends no
 * datapoint, and Beeminder needs a week's notice to take a break, so the card
 * says so before the trip starts.
 */
export function beeminderHeld(keep: AwayKeep, items: readonly Item[], routines: readonly Routine[]): string[] {
  const ext = useExtensionsStore.getState();
  if (!ext.available || !ext.isEnabled(EXT_BEEMINDER)) return [];
  const config = ext.configs[EXT_BEEMINDER] ?? {};
  const probe: AwayPeriod = { id: '', startsOn: '', keep, returns: {}, fromTrip: {} };
  return items
    .filter((i) => isRecurring(i as Item & { repeatFrequency?: string }))
    .filter((i) => !isKeptOn(i as KeepItem, probe, routines))
    .filter((i) => !!goalForTitle(config, i.title))
    .map((i) => i.title);
}

export function openVacationCard(opts: { editKeep?: boolean } = {}): void {
  useUIStore.getState().openDialog({ type: 'vacation', editKeep: opts.editKeep });
}

/**
 * Start a trip from today (or `startsOn`) until `endsOn`, keeping `keep` (the
 * month's every-day habits when omitted), and say so with an Undo.
 */
export function startVacation(endsOn: string, keep?: AwayKeep, startsOn?: string): void {
  const inputs = awayInputsNow();
  const away = useAwayStore.getState();
  const replacing = !!activeTrip(away.periods, inputs.todayStr);
  const first = startsOn ?? inputs.todayStr;
  away.start({ startsOn: first, endsOn, keep: keep ?? defaultKeep(inputs.items, inputs.todayStr) }, inputs);
  const until = shortAwayDay(endsOn, inputs.todayStr);
  const said =
    first > inputs.todayStr
      ? `Vacation mode starts ${shortAwayDay(first, inputs.todayStr)}, until ${until}.`
      : `Vacation mode is on until ${until}. Have a good trip.`;
  toast(replacing ? `Vacation mode changed. Back ${until}.` : said, {
    action: replacing
      ? undefined
      : {
          label: 'Undo',
          onClick: () => {
            const now = awayInputsNow();
            const trip = activeTrip(useAwayStore.getState().periods, now.todayStr);
            // Only the trip this toast started, and only while it has not
            // begun or begins today: end() then removes it outright.
            if (trip && trip.startsOn >= now.todayStr) useAwayStore.getState().end(now);
          },
        },
    cancel: { label: 'Change what’s paused', onClick: () => openVacationCard({ editKeep: true }) },
    duration: 8000,
  });
}

/** "I'm back": end the trip today. Habits still ease back in over the coming days. */
export function endVacation(): void {
  const inputs = awayInputsNow();
  useAwayStore.getState().end(inputs);
}
