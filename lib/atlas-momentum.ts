import type { AtlasCard } from './atlas-model';
import type { AtlasBand } from './atlas-positions';
import { daysBetween } from './container-schedule';
import { isRecurring } from './recurrence';
import { lastDoneOn } from './goals';
import { formatDay } from './active';
import { toDateOnly } from './overdue';
import { ATLAS_COPY } from './atlas-copy';

/**
 * Momentum (design PR2): the app sorts each card into Now, Soon or Resting
 * from what it can see, and says why on the card. Pure.
 *
 * - **Now**: touched within 7 days, something on today, or the next dated
 *   step within 7 days.
 * - **Soon**: touched within 14 days, or the next dated step within 31 days.
 * - **Resting**: a KNOWN touch older than that, or paused, or ended.
 *
 * Rule 13: "resting" only ever comes from a known date or a known pause. A
 * card whose activity is unknown, with no dated step, goes to Soon with no
 * reason line, never to Resting. No reason counts idle days.
 *
 * A pin wins over the app's band, and the reason then names the app's band,
 * so the user can see what Unpin would hand it back to.
 */

export const MOMENTUM_BANDS: readonly AtlasBand[] = ['now', 'soon', 'resting'];

/** Within this many days is Now. */
export const MOMENTUM_NOW_DAYS = 7;
/** A touch within this many days is Soon. */
export const MOMENTUM_SOON_TOUCH_DAYS = 14;
/** A dated step within this many days is Soon. */
export const MOMENTUM_SOON_DATE_DAYS = 31;

export function bandLabel(band: AtlasBand): string {
  return band === 'now' ? ATLAS_COPY.bandNow : band === 'soon' ? ATLAS_COPY.bandSoon : ATLAS_COPY.bandResting;
}

export function bandHint(band: AtlasBand): string {
  return band === 'now' ? ATLAS_COPY.bandNowHint : band === 'soon' ? ATLAS_COPY.bandSoonHint : ATLAS_COPY.bandRestingHint;
}

/** What Momentum read off the card's own members (store only). */
export interface MomentumCardSignals {
  /** A member was ticked today (a recurring item's date is today). */
  tickedToday: boolean;
  /**
   * Something is on today: a member that is `open` by memberStateOn and is
   * either recurring (so it occurs today) or dated exactly today. An undated
   * one-off is open every day, and a one-off dated before today is a
   * leftover (ghost rows' job, not a reason to be "on today"), so neither
   * makes a card Now on its own; both fall through to the touch rules.
   * A milestone's start date is a target date (long-term-goals.md), never a
   * day it is due, so milestones count for neither signal.
   */
  dueToday: boolean;
  /** The earliest open one-off's start day after today (yyyy-MM-dd). */
  nextDated?: string;
}

function startDay(item: AtlasCard['members'][number]['item']): string | undefined {
  return 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : undefined;
}

export function momentumCardSignals(
  card: AtlasCard,
  todayStr: string,
  milestoneIds?: ReadonlySet<string>,
): MomentumCardSignals {
  const today = toDateOnly(todayStr);
  let tickedToday = false;
  let dueToday = false;
  let nextDated: string | undefined;
  for (const m of card.members) {
    if (!tickedToday && lastDoneOn(m.item) === today) tickedToday = true;
    if (m.state !== 'open') continue;
    if (milestoneIds?.has(m.item.id)) continue;
    if (isRecurring(m.item)) {
      dueToday = true;
      continue;
    }
    const day = startDay(m.item);
    if (!day) continue;
    if (day === today) dueToday = true;
    else if (day > today && (!nextDated || day < nextDated)) nextDated = day;
  }
  return { tickedToday, dueToday, nextDated };
}

export type MomentumReasonKey =
  | 'tickedToday'
  | 'touched'
  | 'dueToday'
  | 'nextDate'
  | 'wrappingUp'
  | 'resting'
  | 'paused'
  | 'ended';

export interface MomentumResult {
  /** Where the card is drawn: the pin when there is one, else the app's band. */
  band: AtlasBand;
  /** The app's own band, whatever the pin says. */
  appBand: AtlasBand;
  pinned: boolean;
  /** Which rule decided the app's band (tests and the reason line). */
  why: MomentumReasonKey | null;
  /** The card's "why" line; null when the app has nothing honest to say. */
  reason: string | null;
}

/**
 * The band and its reason.
 *
 * @param lastTouch the latest known touch (yyyy-MM-dd), merged from the
 *   store's `lastDoneOn` and the activity side channel, or undefined / 'unknown'
 *   when nothing is known.
 */
export function momentumBand(
  card: AtlasCard,
  lastTouch: string | 'unknown' | undefined,
  todayStr: string,
  pin: AtlasBand | null = null,
  milestoneIds?: ReadonlySet<string>,
): MomentumResult {
  const app = appBandOf(card, lastTouch, todayStr, milestoneIds);
  if (pin && pin !== app.band) {
    return { band: pin, appBand: app.band, pinned: true, why: app.why, reason: ATLAS_COPY.pinnedHere(bandLabel(app.band)) };
  }
  // A pin to the band the app would pick anyway is drawn as the app's own,
  // with the app's reason; Unpin is still offered while the pin is stored.
  return { band: app.band, appBand: app.band, pinned: !!pin, why: app.why, reason: app.reason };
}

function appBandOf(
  card: AtlasCard,
  lastTouch: string | 'unknown' | undefined,
  todayStr: string,
  milestoneIds?: ReadonlySet<string>,
): { band: AtlasBand; why: MomentumReasonKey | null; reason: string | null } {
  const t = card.touch;
  // A known pause or an end: Resting, said the way the footer says it.
  if (t.kind === 'paused') {
    return {
      band: 'resting',
      why: 'paused',
      reason: t.until ? ATLAS_COPY.pausedTill(formatDay(t.until)) : ATLAS_COPY.paused,
    };
  }
  if (t.kind === 'ended') {
    const day = t.on ? formatDay(t.on) : undefined;
    const reason =
      t.reason === 'setAside'
        ? ATLAS_COPY.setAside
        : t.reason === 'achieved'
          ? day
            ? ATLAS_COPY.achievedOn(day)
            : ATLAS_COPY.achieved
          : day
            ? ATLAS_COPY.seasonEnded(day)
            : null;
    return { band: 'resting', why: 'ended', reason };
  }

  const today = toDateOnly(todayStr);
  const sig = momentumCardSignals(card, today, milestoneIds);
  const touch = lastTouch && lastTouch !== 'unknown' ? toDateOnly(lastTouch) : undefined;
  const touchDays = touch ? Math.max(0, daysBetween(touch, today)) : undefined;
  const dateDays = sig.nextDated ? daysBetween(today, sig.nextDated) : undefined;
  const wrapping = card.allDone;

  if (sig.tickedToday) return { band: 'now', why: 'tickedToday', reason: wrapping ? ATLAS_COPY.wrappingUp : ATLAS_COPY.tickedToday };
  if (sig.dueToday) return { band: 'now', why: 'dueToday', reason: ATLAS_COPY.dueToday };
  if (touchDays !== undefined && touchDays <= MOMENTUM_NOW_DAYS) {
    return { band: 'now', why: wrapping ? 'wrappingUp' : 'touched', reason: wrapping ? ATLAS_COPY.wrappingUp : touchedLine(touchDays, touch!) };
  }
  if (dateDays !== undefined && dateDays <= MOMENTUM_NOW_DAYS) {
    return { band: 'now', why: 'nextDate', reason: ATLAS_COPY.nextDate(formatDay(sig.nextDated!)) };
  }
  if (touchDays !== undefined && touchDays <= MOMENTUM_SOON_TOUCH_DAYS) {
    return { band: 'soon', why: wrapping ? 'wrappingUp' : 'touched', reason: wrapping ? ATLAS_COPY.wrappingUp : touchedLine(touchDays, touch!) };
  }
  if (dateDays !== undefined && dateDays <= MOMENTUM_SOON_DATE_DAYS) {
    return { band: 'soon', why: 'nextDate', reason: ATLAS_COPY.nextDate(formatDay(sig.nextDated!)) };
  }
  if (touch) return { band: 'resting', why: 'resting', reason: ATLAS_COPY.restingSince(formatDay(touch)) };
  // Unknown activity and nothing dated soon: neutral, never Resting.
  if (wrapping) return { band: 'soon', why: 'wrappingUp', reason: ATLAS_COPY.wrappingUp };
  if (sig.nextDated) return { band: 'soon', why: 'nextDate', reason: ATLAS_COPY.nextDate(formatDay(sig.nextDated)) };
  return { band: 'soon', why: null, reason: null };
}

/** A date, never a tally of idle days (rule 13). */
function touchedLine(days: number, touch: string): string {
  return days === 0 ? ATLAS_COPY.touchedToday : days === 1 ? ATLAS_COPY.touchedYesterday : ATLAS_COPY.touchedOn(formatDay(touch));
}
