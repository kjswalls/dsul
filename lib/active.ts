/**
 * active.ts — the ONE definition of "is this item live right now?"
 *
 * Written the way lib/overdue.ts was, and for the same reason: that module
 * exists because one predicate had been copied into three surfaces and the
 * copies drifted. Suppression is going to be asked by MORE surfaces than
 * "past due" ever was — the grid, the past-due bar, the EOD review, the
 * braindump, Beacon's context, the agent projections, search — so it gets a
 * single home before the first copy can happen, not after the third.
 *
 * Everything here is pure and string-based. Nothing reads a store and nothing
 * calls `new Date()` for "today" — callers pass the day, which is what makes
 * the whole thing testable and timezone-stable.
 *
 * Three layers answer "is it live": the item's own pause, the routines holding
 * it, and the seasons holding those (or holding it directly). They combine
 * through the path algebra in {@link isItemActiveOn} — read that first; the
 * rest of this file is its supporting cast.
 *
 * See memory/plans/programs-routines.md, locked decisions 3 and 4.
 */

import { isRecurring, isCompletedOnDate, isSkippedOnDate, toDateStr } from './recurrence';
import { toDateOnly } from './overdue';
import type { Item, Routine, Season } from './planner-types';

/**
 * Everything the resolver needs beyond the item and the date.
 *
 * It is an object rather than positional arguments precisely so that growth is
 * additive at every call site — every Phase 1 caller passing `{ userTimezone }`
 * alone still compiles and still gets correct answers, because an item with no
 * containers is unconditionally live (decision 3's "no paths = today's
 * behavior, unchanged").
 */
export interface ActivationContext {
  /** IANA zone — the pause interval's start is a timestamp and must be read in the user's day. */
  userTimezone: string;
  /**
   * The user's LIVE routines. Soft-deleted ones must never appear: decision 3
   * removes trashed containers from resolution *before* the standalone test, so
   * a routine in the trash neither suppresses its members nor keeps them scoped.
   * `fetchRoutines` filters `deleted_at`, so the store's array satisfies this.
   *
   * Omitted (any surface that legitimately has no container context) means "no
   * memberships known" — item-level pause only.
   */
  routines?: readonly Routine[];
  /**
   * The user's LIVE seasons, same soft-delete contract as `routines` and for a
   * sharper reason: a trashed season must not keep suppressing the items it
   * held. Trashing it removes its paths, so a routine it was the only holder of
   * falls back to standalone and its members return — which is what makes
   * "restore within 30 days" restore the suppression too, intact.
   */
  seasons?: readonly Season[];
}

/** The pause columns, on an item or (from Phase 2) a routine. */
export interface Pausable {
  pausedAt?: string;
  pausedUntil?: string;
}

/**
 * Is `x` inside a pause interval on `dateStr`?
 *
 * The interval is [pausedAt's date, pausedUntil), and BOTH bounds matter:
 *
 * - The lower bound is why `pausedAt` is stored at all. Without it, pausing a
 *   habit today would suppress every unmarked occurrence backwards through its
 *   whole history — habits are deliberately un-anchored (they render on every
 *   matching day, forever) precisely so that history stays visible, and a
 *   pause must not retroactively erase a July that actually happened.
 * - The upper bound is EXCLUSIVE: "paused until Sep 1" is live again ON Sep 1.
 *   That makes auto-resume a read-side predicate — no cron, no cleanup write,
 *   and an expired pause still reads correctly as "was paused during […]",
 *   which is what the auto-age sweep's resume grace needs (plan decision 9).
 *
 * A manual resume normalizes to `pausedUntil = today` rather than clearing the
 * pair, so the interval survives on the row.
 */
export function isPausedOn(x: Pausable, dateStr: string, userTimezone: string): boolean {
  if (!x.pausedAt) return false;
  const day = toDateOnly(dateStr);
  const started = pauseStartDate(x.pausedAt, userTimezone);
  // Unparseable timestamp: treat as not-paused. Hiding work is the costlier
  // failure, and a bad value here would otherwise silently swallow items.
  if (!started || started > day) return false;
  if (x.pausedUntil && day >= toDateOnly(x.pausedUntil)) return false;
  return true;
}

/**
 * The write counterpart of {@link isPausedOn} — turn the pause VERB into the
 * two columns that express it.
 *
 * It lives here, beside the predicate, because the interval's meaning has to be
 * stated once. The UI writes these columns through planner-store's
 * setItemPaused; the agent API writes them through this. Two callers deriving
 * `pausedAt` independently is exactly how the lower bound would drift out of
 * agreement with the resolver that reads it.
 *
 * Returns the column patch, or a `reason` when the request cannot be honoured.
 * Never returns both, and returns an EMPTY patch for a request that is already
 * satisfied — re-pausing something already paused must not restamp `pausedAt`,
 * which would drag the lower bound forward and un-hide the days between.
 *
 * @param current   the row's existing pause columns
 * @param req       the parsed verb: `paused` and/or `pausedUntil`
 * @param todayStr  today in the USER's zone (the resolver's frame of reference)
 * @param nowIso    the instant a new pause begins
 */
export function resolvePauseWrite(
  current: Pausable,
  req: { paused?: boolean; pausedUntil?: string | null },
  todayStr: string,
  nowIso: string,
  userTimezone: string,
): { patch: Pausable } | { reason: string } {
  const pausedNow = isPausedOn(current, todayStr, userTimezone);
  const until = req.pausedUntil ?? undefined;

  if (req.paused === false) {
    // Already live → nothing to do. Writing pausedUntil = today anyway would be
    // harmless for the resolver but would move the interval the auto-age
    // sweep's resume grace reads, granting a grace nobody earned.
    return { patch: pausedNow ? { pausedUntil: todayStr } : {} };
  }

  if (req.paused === true) {
    // Already paused: honour a new resume date, but leave pausedAt where it is.
    if (pausedNow) {
      return { patch: req.pausedUntil !== undefined ? { pausedUntil: until } : {} };
    }
    // A resume date already in the past would create a pause that is over
    // before it starts — accepted silently, it looks exactly like a pause that
    // failed to apply.
    if (until && until <= todayStr) {
      return {
        reason: `pausedUntil ${until} is not after today (${todayStr}), so the pause would end immediately`,
      };
    }
    return { patch: { pausedAt: nowIso, pausedUntil: until } };
  }

  // pausedUntil alone — move the end of a pause already running.
  if (req.pausedUntil !== undefined) {
    if (!pausedNow) {
      return {
        reason:
          'pausedUntil was sent without paused: true, but this is not currently paused. ' +
          'A resume date on its own would change nothing.',
      };
    }
    return { patch: { pausedUntil: until } };
  }

  return { patch: {} };
}

/** The user-local calendar day a pause began, or null if the stamp is junk. */
function pauseStartDate(pausedAt: string, userTimezone: string): string | null {
  const at = new Date(pausedAt);
  if (Number.isNaN(at.getTime())) return null;
  return toDateStr(at, userTimezone);
}

/**
 * Is this season switched on for `dateStr`?
 *
 * The tri-state exists because a period of life has two different kinds of
 * boundary. `auto` follows the calendar — a summer that starts on Jun 1 should
 * not need a reminder to turn itself on. `active`/`paused` are manual overrides
 * and they ALWAYS win, because a person who flips a season by hand ("we came
 * back early") must never be second-guessed by a date they set weeks ago.
 *
 * Only `auto` is date-resolved. The manual states genuinely have no date
 * history — nothing records when they were flipped — so they apply uniformly to
 * every rendered column, past and future alike. That asymmetry is deliberate:
 * pretending a manual flip had a start date would invent history the row does
 * not contain, and a week view would render a boundary that never happened.
 *
 * The range is INCLUSIVE at both ends, unlike a pause's exclusive upper bound.
 * A pause is written as "until Sep 1" (come back ON the 1st); a season range is
 * written as a period you are inside — "Jun 1 to Aug 31" plainly includes Aug 31.
 * The two read differently in the UI, so they resolve differently here.
 */
export function isSeasonActiveOn(season: Season, dateStr: string): boolean {
  if (season.state === 'active') return true;
  if (season.state === 'paused') return false;
  const day = toDateOnly(dateStr);
  if (season.startsOn && day < toDateOnly(season.startsOn)) return false;
  if (season.endsOn && day > toDateOnly(season.endsOn)) return false;
  return true;
}

/**
 * The routines holding `item`, live ones only.
 *
 * Linear in the routine count, which is fine for the single-item callers (a
 * dialog, a sheet). Bulk callers go through {@link inactiveItemIdsOn}, which
 * inverts the membership once instead of scanning per item.
 */
export function routinesForItem(
  itemId: string,
  routines: readonly Routine[] | undefined,
): readonly Routine[] {
  if (!routines?.length) return EMPTY_ROUTINES;
  return routines.filter((r) => r.itemIds.includes(itemId));
}

/** The seasons holding `item` DIRECTLY — not the ones reached through a routine. */
export function seasonsForItem(
  itemId: string,
  seasons: readonly Season[] | undefined,
): readonly Season[] {
  if (!seasons?.length) return EMPTY_SEASONS;
  return seasons.filter((p) => p.itemIds.includes(itemId));
}

const EMPTY_ROUTINES: readonly Routine[] = [];
const EMPTY_SEASONS: readonly Season[] = [];

/**
 * One way an item can be scoped: a routine, a season, or a routine inside a
 * season. Never neither — an item with no paths is unconditionally live and
 * never produces one of these.
 */
export interface ActivationPath {
  routine?: Routine;
  season?: Season;
}

/**
 * Every path that scopes `itemId`, per decision 3.
 *
 * Three shapes, and the third is the one that carries the design:
 *
 *   1. direct      item → P
 *   2. via routine item → R → P   (one path per season holding R)
 *   3. standalone  item → R       (only when R belongs to NO season)
 *
 * The standalone rule is why attaching a routine to its first season is a
 * visible event rather than a no-op: before the attach, the routine answers for
 * itself; after it, the season answers too. Detaching from the last season
 * hands the answer back. The manager's attach flow states this consequence out
 * loud (decision 3's "known discontinuity, accepted") because a join write that
 * silently hides five items would otherwise read as a bug.
 *
 * Soft-deleted containers are already absent — `ctx.routines`/`ctx.seasons`
 * carry live rows only — which is what makes trashing a season restore its
 * routine to standalone rather than stranding its members behind a container
 * nobody can see or resume.
 */
export function activationPathsFor(itemId: string, ctx: ActivationContext): ActivationPath[] {
  const paths: ActivationPath[] = [];
  for (const season of seasonsForItem(itemId, ctx.seasons)) paths.push({ season });
  for (const routine of routinesForItem(itemId, ctx.routines)) {
    const holders = (ctx.seasons ?? []).filter((p) => p.routineIds.includes(routine.id));
    if (holders.length === 0) paths.push({ routine });
    else for (const season of holders) paths.push({ routine, season });
  }
  return paths;
}

/** A path carries the item on `dateStr` iff every container on it is switched on. */
export function isPathLiveOn(path: ActivationPath, dateStr: string, tz: string): boolean {
  if (path.routine && isPausedOn(path.routine, dateStr, tz)) return false;
  if (path.season && !isSeasonActiveOn(path.season, dateStr)) return false;
  return true;
}

/**
 * Is this item live on `dateStr`?
 *
 * Decision 3's path algebra, complete. An item is live if it is not itself
 * paused AND (it has no paths at all, OR at least one path is live).
 *
 * The "no paths" arm is what keeps this backwards-compatible: the overwhelming
 * majority of items belong to nothing, and they behave exactly as they did
 * before any of this existed. Joining a container is what makes an item's
 * visibility answerable by something other than itself.
 *
 * The rule is DISJUNCTIVE across paths and that is a product decision, not an
 * implementation convenience: a second container is an additional reason for an
 * item to appear, never a new way for it to vanish. Put the gym habit in both
 * "Morning" and "Summer" and pausing Morning leaves it on the grid, because
 * Summer still wants it. The alternative (all paths must agree) would make
 * every membership a liability and nobody would ever add the second one.
 *
 * Note this answers "is it live", NOT "should it be hidden" — a suppressed item
 * with a completion mark still renders. Hiding surfaces want
 * {@link isOpenLoopSuppressedOn}.
 */
export function isItemActiveOn(item: Item, dateStr: string, ctx: ActivationContext): boolean {
  if (isPausedOn(item, dateStr, ctx.userTimezone)) return false;
  const paths = activationPathsFor(item.id, ctx);
  if (paths.length === 0) return true;
  return paths.some((p) => isPathLiveOn(p, dateStr, ctx.userTimezone));
}

/**
 * Does this item still want doing on `dateStr` — i.e. is it an OPEN LOOP there?
 *
 * A recurring item's obligation on a date is discharged by any mark: a
 * completion, a skip, or (for a counted habit) a tally. A one-shot item's is
 * discharged by leaving `pending` — which covers 'completed' and, deliberately,
 * 'cancelled', matching selectOverdue's reasoning that a cancelled item must
 * never resurface in a surface whose exits assume it can be completed.
 */
export function isOpenLoopOn(item: Item, dateStr: string): boolean {
  const day = toDateOnly(dateStr);
  if (isRecurring(item)) {
    if (isCompletedOnDate(item, day)) return false;
    if (isSkippedOnDate(item, day)) return false;
    // A counted habit is discharged by REACHING its target, not by being
    // touched. This read `> 0`, which meant one tally of a 3×-a-day habit
    // closed the day — while the row still drew 1/3 and the stepper still
    // wanted two more. Every surface that asks this question was therefore
    // disagreeing with the grid: the reminder went quiet, the EOD review
    // stopped listing it, Beacon stopped mentioning it, and the streak still
    // broke at midnight.
    //
    // `timesPerDay ?? 1` is what keeps this from being a behavior change for
    // anything else: an ordinary habit has no target, so any count still
    // discharges it exactly as before. Only habits with a real target move.
    const counts = (item as { dailyCounts?: Record<string, number> }).dailyCounts;
    if (counts) {
      const target = (item as { timesPerDay?: number }).timesPerDay ?? 1;
      if ((counts[day] ?? 0) >= Math.max(1, target)) return false;
    }
    return true;
  }
  return item.status === 'pending';
}

/**
 * THE predicate every hiding surface asks: suppressed AND still an open loop.
 *
 * This is locked decision 4 in one function — "suppression hides open loops,
 * never history". A paused habit you already ticked today keeps its row in the
 * EOD review, in Beacon's narration and in the agent projection; only the
 * unanswered obligations disappear. Get this wrong in the hiding direction and
 * pausing quietly rewrites the past.
 */
export function isOpenLoopSuppressedOn(
  item: Item,
  dateStr: string,
  ctx: ActivationContext,
): boolean {
  return !isItemActiveOn(item, dateStr, ctx) && isOpenLoopOn(item, dateStr);
}

/**
 * Ids of every item that must be hidden on `dateStr`.
 *
 * The pure derivations downstream (deriveDayItems, selectOverdue) take this Set
 * rather than the containers themselves: they are store-free by design, and
 * from Phase 2 resolving an item would mean walking item → routine → season.
 * Resolving once per rendered date and passing ids keeps that walk in one place.
 */
export function inactiveItemIdsOn(
  items: readonly Item[],
  dateStr: string,
  ctx: ActivationContext,
): Set<string> {
  // Invert the membership ONCE. Calling activationPathsFor per item would be
  // O(items × routines × seasons) on every rendered column of every week view;
  // this is O(total memberships + items). The value is the item's live-path
  // count on this date, which is all the algebra needs: >0 live, or 0 with no
  // paths at all.
  const pathsByItem = new Map<string, { total: number; live: number }>();
  const bump = (itemId: string, total: number, live: number) => {
    const tally = pathsByItem.get(itemId);
    if (tally) {
      tally.total += total;
      tally.live += live;
    } else {
      pathsByItem.set(itemId, { total, live });
    }
  };

  // Resolve each season's state ONCE — a season held by four routines would
  // otherwise be re-resolved four times per column.
  const seasons = ctx.seasons ?? [];
  const seasonLive = new Map<string, boolean>();
  for (const season of seasons) seasonLive.set(season.id, isSeasonActiveOn(season, dateStr));

  // Direct item → season paths.
  for (const season of seasons) {
    const live = seasonLive.get(season.id) ? 1 : 0;
    for (const itemId of season.itemIds) bump(itemId, 1, live);
  }

  const holdersByRoutine = new Map<string, string[]>();
  for (const season of seasons) {
    for (const routineId of season.routineIds) {
      const holders = holdersByRoutine.get(routineId);
      if (holders) holders.push(season.id);
      else holdersByRoutine.set(routineId, [season.id]);
    }
  }

  // Routine paths. A routine's contribution is IDENTICAL for every one of its
  // members, so it is computed once per routine rather than once per membership.
  for (const routine of ctx.routines ?? []) {
    const holders = holdersByRoutine.get(routine.id);
    const routinePaused = isPausedOn(routine, dateStr, ctx.userTimezone);
    // No holder ⇒ standalone: one path, governed by the routine alone.
    const total = holders?.length ?? 1;
    const live = routinePaused
      ? 0
      : (holders?.filter((id) => seasonLive.get(id)).length ?? 1);
    for (const itemId of routine.itemIds) bump(itemId, total, live);
  }

  const ids = new Set<string>();
  for (const item of items) {
    const tally = pathsByItem.get(item.id);
    const active =
      !isPausedOn(item, dateStr, ctx.userTimezone) && (!tally || tally.total === 0 || tally.live > 0);
    if (!active && isOpenLoopOn(item, dateStr)) ids.add(item.id);
  }
  return ids;
}

/**
 * Why an item is suppressed, for the surfaces that must SAY so — the item
 * panel's activation line, the /item/[id] header, the braindump's Paused
 * section. Returns null when the item is live, so `!reason` doubles as the
 * liveness check.
 *
 * A discriminated union rather than a pre-rendered string: the copy differs per
 * surface (a chip has room for "Hidden with Summer", a list subtitle does not)
 * and only the caller knows which.
 */
export type SuppressionReason =
  | { kind: 'paused'; until?: string }
  | { kind: 'routine'; routine: Routine; until?: string }
  | { kind: 'season'; season: Season; routine?: Routine; until?: string };

/**
 * The date an inactive season switches itself back on, if it will.
 *
 * Only an `auto` season with a future start has one. A manually paused season
 * has no scheduled return by construction, and one past its `endsOn` is over —
 * both correctly answer "no date", which the ranking below reads as "returns
 * last" rather than inventing a reassurance the row cannot support.
 *
 * Exported for the scope rail, which has to rank a routine's blocking seasons
 * by the same rule. A second copy of this over there is precisely how the
 * binding-constraint reasoning would drift out of agreement with itself.
 */
export function seasonResumeDate(season: Season, dateStr: string): string | undefined {
  if (season.state !== 'auto' || !season.startsOn) return undefined;
  // An INVERTED range (startsOn after endsOn) is never live on any date, so its
  // start is not a return date — it is a date on which nothing will happen.
  // Promising it would be the exact failure the binding-constraint rule exists
  // to prevent, one layer down: the user waits for Sep 1 and Sep 1 does nothing.
  if (season.endsOn && toDateOnly(season.startsOn) > toDateOnly(season.endsOn)) return undefined;
  return toDateOnly(dateStr) < toDateOnly(season.startsOn) ? season.startsOn : undefined;
}

/**
 * Where a routine actually stands on `dateStr` — its own switch, and what the
 * rest of the app is doing about it.
 *
 * THE SPLIT IS THE POINT. A routine has a switch of its own AND can sit inside
 * seasons that answer for it, so "is this routine on?" has two different true
 * answers and each is correct for a different job. `localOn` is what the user
 * set and what a control must write back; `effectiveOn` is what the resolver
 * obeys and therefore what the rest of the screen has to agree with. A surface
 * that resolves only the local pause shows `Active` with un-greyed members while
 * a season holds the whole thing off — which is exactly what the console did,
 * one column away from a ScopeRail reporting the opposite.
 *
 * DISJUNCTIVE, matching {@link isItemActiveOn}: a standalone routine answers for
 * itself, and one held by several seasons is live while ANY holder is. Read the
 * `blockers.length < holders.length` test as "at least one holder is carrying
 * it" — counting rather than `.some()` because `blockers` is wanted anyway.
 *
 * Shared with the scope rail rather than re-derived there. Two copies of this
 * rule is precisely how the two surfaces came to disagree in the first place,
 * and the disagreement is invisible until someone has both open.
 */
export interface RoutineStanding {
  /** The routine's own switch — what the segmented control shows and writes. */
  localOn: boolean;
  /** What the resolver obeys, and so what the member list must grey on. */
  effectiveOn: boolean;
  /** Every season holding this routine, on or off. */
  holders: readonly Season[];
  /** Holders that are switched off on this date. */
  blockers: readonly Season[];
  /**
   * The blocker that comes back first — undefined only when nothing blocks.
   *
   * Ranked by {@link seasonResumeDate}, with "no return date" sorting LAST: a
   * manually paused season has no scheduled return by construction, and letting
   * it win the ranking would name it as the thing to wait for when it is the one
   * thing that will never arrive on its own.
   */
  soonestBlocker?: Season;
}

export function routineStandingOn(
  routine: Routine,
  seasons: readonly Season[] | undefined,
  dateStr: string,
  tz: string,
): RoutineStanding {
  const localOn = !isPausedOn(routine, dateStr, tz);
  const holders = (seasons ?? EMPTY_SEASONS).filter((p) => p.routineIds.includes(routine.id));
  const blockers = holders.filter((p) => !isSeasonActiveOn(p, dateStr));
  const effectiveOn = localOn && (holders.length === 0 || blockers.length < holders.length);

  const ranked = [...blockers].sort((a, b) => {
    const da = seasonResumeDate(a, dateStr);
    const db = seasonResumeDate(b, dateStr);
    if (da === db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? -1 : 1;
  });

  return { localOn, effectiveOn, holders, blockers, soonestBlocker: ranked[0] };
}

/**
 * Of `memberIds`, which would come back onto the day if `routineId` did not
 * exist — the resolver DELTA, not the routine's own state.
 *
 * WHY A DELTA AND NOT A FLAG. "Is this routine carrying anything" and "is this
 * ITEM on the grid" are different questions, and a surface that answers the
 * first while phrasing the second is wrong exactly when an item has a second
 * live path — which the disjunctive rule exists to create. The Organize console
 * shipped that mistake in a delete confirm: a routine held off by a switched-
 * off season promised "and they come back into view" for items another
 * routine was carrying the whole time, and for items the same season also held
 * directly. Nothing left; nothing came back.
 *
 * `wouldHide` in the console's seasons section already reasons this way — the
 * shared shape, so it stops being copied.
 *
 * Cost is two `inactiveItemIdsOn` passes, linear in items + memberships, on a
 * pane rendering at most a few dozen members.
 */
export function membersRevealedByRemoving(
  routineId: string,
  memberIds: readonly string[],
  items: readonly Item[],
  ctx: ActivationContext,
  dateStr: string,
): string[] {
  const before = inactiveItemIdsOn(items, dateStr, ctx);
  const after = inactiveItemIdsOn(items, dateStr, {
    ...ctx,
    routines: (ctx.routines ?? EMPTY_ROUTINES).filter((r) => r.id !== routineId),
  });
  return memberIds.filter((id) => before.has(id) && !after.has(id));
}

/**
 * For a path that is NOT carrying the item: when it would, and which of its
 * containers to blame.
 *
 * "Which to blame" is the whole difficulty. A path through a paused routine
 * inside a switched-off season is blocked twice, and naming the one that
 * clears FIRST would promise a return date the item will not honour — the user
 * resumes the routine on the strength of the note and nothing appears. So the
 * binding constraint wins: whichever clears last, with an unknown return
 * counting as latest of all.
 */
function deadPathExplanation(
  path: ActivationPath,
  dateStr: string,
  tz: string,
): { returnsOn?: string; reason: SuppressionReason } {
  const routineBlocks = !!path.routine && isPausedOn(path.routine, dateStr, tz);
  const seasonBlocks = !!path.season && !isSeasonActiveOn(path.season, dateStr);
  const routineReturns = routineBlocks ? path.routine!.pausedUntil : undefined;
  const seasonReturns = seasonBlocks ? seasonResumeDate(path.season!, dateStr) : undefined;

  const nameSeason =
    seasonBlocks &&
    (!routineBlocks ||
      !seasonReturns ||
      (!!routineReturns && seasonReturns >= routineReturns));

  // The path clears only when BOTH constraints do, so an unknown on either side
  // makes the whole path's return unknown.
  const returnsOn =
    (routineBlocks && !routineReturns) || (seasonBlocks && !seasonReturns)
      ? undefined
      : [routineReturns, seasonReturns].filter(Boolean).sort().pop();

  if (nameSeason) {
    return {
      returnsOn,
      reason: {
        kind: 'season',
        season: path.season!,
        routine: path.routine,
        until: seasonReturns,
      },
    };
  }
  return {
    returnsOn,
    reason: { kind: 'routine', routine: path.routine!, until: routineReturns },
  };
}

/**
 * The one place suppression is put into words.
 *
 * Three surfaces render this — the item panel's activation line, the /item/[id]
 * header chip, and the braindump's Paused section — and they were already
 * drifting at two. The `long` variant has room for the article-and-noun copy
 * rule ("your Summer season", never a bare "Season") and a return date; the
 * short one is for chips, where the container's name is the whole message.
 *
 * Never a warning colour and never an apology, per the guilt-free law
 * (overlap-blocks decision 1): this states where the work went, and that is all.
 */
export function suppressionLabel(reason: SuppressionReason, opts: { long?: boolean } = {}): string {
  const back = reason.until ? ` until ${formatDay(reason.until)}` : '';
  switch (reason.kind) {
    case 'paused':
      return reason.until ? `Paused until ${formatDay(reason.until)}` : 'Paused';
    case 'routine':
      return opts.long
        ? `Hidden with your ${reason.routine.name} routine${back}`
        : `Hidden with ${reason.routine.name}`;
    case 'season':
      return opts.long
        ? `Hidden with your ${reason.season.name} season${back}`
        : `Hidden with ${reason.season.name}`;
  }
}

/** `2026-09-01` → `Sep 1`. Parsed as a plain calendar day, never as an instant. */
export function formatDay(dateStr: string): string {
  const [y, m, d] = toDateOnly(dateStr).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${MONTHS[m - 1]} ${d}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function suppressionReason(
  item: Item,
  dateStr: string,
  ctx: ActivationContext,
): SuppressionReason | null {
  // The item's own pause wins the explanation when both are true. It is the one
  // the user set on this row and the one the row's own Resume undoes — naming a
  // container instead would send them to a control that leaves the item hidden.
  if (isPausedOn(item, dateStr, ctx.userTimezone)) {
    return { kind: 'paused', until: item.pausedUntil };
  }
  const paths = activationPathsFor(item.id, ctx);
  if (paths.length === 0) return null;
  if (paths.some((p) => isPathLiveOn(p, dateStr, ctx.userTimezone))) return null;

  // Every path is dead. Across paths the item returns as soon as the FIRST one
  // clears (they are disjunctive), so the soonest-returning path is both the
  // honest date and the one whose control is worth naming.
  const explanations = paths.map((p) => deadPathExplanation(p, dateStr, ctx.userTimezone));
  explanations.sort((a, b) => {
    if (a.returnsOn === b.returnsOn) return 0;
    if (!a.returnsOn) return 1;
    if (!b.returnsOn) return -1;
    return a.returnsOn < b.returnsOn ? -1 : 1;
  });
  return explanations[0].reason;
}
