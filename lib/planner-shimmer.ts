import { selectPlannerLoaded } from '@/lib/planner-ready';
import { PREVIEW_MODE } from '@/lib/planner-snapshot';
import { usePlannerStore } from '@/lib/planner-store';
import { prefersReducedMotion } from '@/lib/zen-transition';

/**
 * planner-shimmer.ts — the look-only preview's waiting shimmer, and the pass
 * of light that lands it (instant planner, Kirby's ask on 2026-10-07).
 *
 * While the cached planner is up, every open row title is drawn in a muted
 * ink with one band of full ink crossing the planner, the way Claude's own
 * "working" status text shimmers. When the fresh data lands, one last pass of
 * light raises each title back to full ink as it reaches it, alongside the
 * settle's glide. The paint is all CSS ("Planner preview: waiting shimmer" in
 * app/globals.css), keyed off `<html data-planner-shimmer>`; this module
 * decides the phase and supplies the geometry CSS cannot read:
 *
 *  - WAIT, from the preview's commit (SettleHost's layout effect). Each
 *    waiting title gets `--planner-shimmer-x`, its left edge in the viewport,
 *    so its copy of the gradient is a window onto ONE band shared by every
 *    title (and by the sync line's bar, which measures its own track). It is
 *    measured when the title's sweep starts (`animationstart`, at the 300ms
 *    delay, while the band is still parked off the left edge), and again on a
 *    resize or a scroll; a title outside the viewport is marked away instead
 *    (AWAY_ATTR). Every title's mute and sweep and the sync line's bar are
 *    held to one clock, so there are never two lights or two inks out of
 *    step. A title that joins the wait late restarts its animations, so it
 *    is put on the clock in the frame it is first styled, before that frame
 *    paints: one scrolled back into view (in the measure that un-marks it)
 *    and one mounted mid-wait (a mobile tab switch, a view change: a
 *    MutationObserver, which runs before the browser renders).
 *  - The preview's END, inside the landing set() and before React commits
 *    (a store subscriber, after the conductor's capture so its rect reads
 *    never style the switch), so the first frame of the fresh rows is
 *    already styled for the landing and no title snaps:
 *      - a real landing whose ink had settled (LIGHT_AFTER_MS, 660ms on the
 *        shimmer's own clock, which starts with the first frame that styled
 *        the titles; that is 360ms after the shimmer first showed): LAND,
 *        the pass of light. SettleHost's layout effect then measures each
 *        fresh title's x, which delays its rise from the muted ink to full
 *        ink.
 *      - a real landing before that, a failed load or a dropped preview:
 *        EASE, every title up from the ink it was showing, at once. The last
 *        two empty the planner, so the landing's layout effect finds no title
 *        to raise and ends the phase there.
 *      - inside the 300ms delay, or under a motion veto, a hidden tab or an
 *        account change: nothing. The phase ends, and the titles are text.
 *  - The end: when the first rise starts, a timer for its run plus slack
 *    (a backstop if none ever does); then the attribute comes off. Each rise
 *    ends on plain text (app/globals.css), so that changes nothing on screen,
 *    and the titles' inline x goes with it.
 *
 * Off entirely under `static` and `off`, both reduced-motion vetoes, forced
 * colours, and in the Zen room (whose titles are never marked): the wait
 * never starts. The CSS gates itself on both vetoes and forced colours, so
 * the app's animations switch turned off mid-wait drops the shimmer at once,
 * and the next measure ends the phase.
 */

type PlannerState = ReturnType<typeof usePlannerStore.getState>;

/** On <html>: the phase, while there is one. */
export const SHIMMER_ATTR = 'data-planner-shimmer';

export type ShimmerPhase = 'wait' | 'land' | 'ease';

/** Every number the shimmer runs on. app/globals.css repeats them, and a test pins each pair. */
export const SHIMMER = {
  /** Invisible this long: the sync line's own delay, so a warm load never sees either. */
  delayMs: 300,
  /**
   * The ink easing down to the waiting level, on --ease-roll: slow at both
   * ends, so a load that lands early catches the ink only a little way down
   * and the plain ease up is a small step, not a dip and a pop.
   */
  inkMs: 360,
  /** One pass of the band, shared with the sync line's bar. */
  periodMs: 1200,
  /** Passes before the band stops and the ink holds at the waiting level. */
  passes: 3,
  /** The landing's light, crossing the viewport left to right. */
  spreadMs: 180,
  /** Each title's rise from the muted ink once the light reaches it. */
  riseMs: 150,
  /** The plain ease-up, with no light. */
  easeMs: 170,
  /** Past a rise's end before the attribute comes off. */
  slackMs: 60,
  /** The end, if no rise ever reports its start (no titles on screen). */
  backstopMs: 1500,
} as const;

/**
 * From here on the ink has settled, so a real landing gets the pass of light;
 * before it, a plain ease. Counted on the shimmer's clock, from the first frame
 * that styled the titles, NOT from when the shimmer showed: the light needs a
 * muted ink to rise from, which is there 360ms after the shimmer first shows.
 */
export const LIGHT_AFTER_MS = SHIMMER.delayMs + SHIMMER.inkMs;

/** --ease-roll, the ink's curve, as numbers: the ease's starting ink is computed from it. */
export const INK_CURVE = [0.45, 0, 0.55, 1] as const;

/** The CSS animations this module listens for or holds to the clock (app/globals.css). */
export const MUTE_ANIMATION = 'planner-shimmer-mute';
export const SWEEP_ANIMATION = 'planner-shimmer-sweep';
export const RISE_ANIMATION = 'planner-shimmer-rise';
/** The sync line's travelling bar (components/shell/planner-sync-line.tsx), held to the same clock. */
export const SYNC_BAR_ANIMATION = 'planner-sync-travel';
const SYNC_BAR_SELECTOR = '.planner-sync-line__bar';

/** A row title that shimmers. A title that rests muted carries data-row-title="muted" and never does. */
export const TITLE_SELECTOR = "[data-row-title='open']";
/**
 * On a waiting title outside the viewport: it holds the muted ink with no
 * animation, and sits the landing out in plain full ink. A CSS animation
 * ticks (and paints) off screen too, so a long braindump would pay for every
 * row nobody can see, every frame, and again to start each one's landing.
 */
export const AWAY_ATTR = 'data-shimmer-away';
/** Each waiting title's left edge in the viewport, inline, for its band (app/globals.css). */
export const X_PROPERTY = '--planner-shimmer-x';
const PREVIEW_ROOT = "[data-preview='true']";
const WAITING_TITLES = `${PREVIEW_ROOT} ${TITLE_SELECTOR}`;
const LANDING_TITLES = `:is([data-settle-scope='canvas'], [data-settle-scope='braindump']) ${TITLE_SELECTOR}:not([${AWAY_ATTR}])`;

let hosts = 0;
let unsubscribe: (() => void) | null = null;
let phase: ShimmerPhase | null = null;
/** performance.now() at the commit that started the wait. */
let waitAt = 0;
/** The first pass's start time on the document timeline: every band and bar is held to it. */
let clock: number | null = null;
/** The event time of the start that set the clock. */
let clockAt: number | null = null;
/** Starts dispatched this close to the clock's own are in its frame. */
const SAME_FRAME_MS = 8;
let endTimer: ReturnType<typeof setTimeout> | null = null;
let measureFrame = 0;
/** The ease's starting depth, as a rule for the titles (see begin). */
let depthRule: HTMLStyleElement | null = null;
const queued = new Set<Element>();
/** Every title given an inline x, so the end can take it off again. */
const placed = new Set<HTMLElement>();
let off: (() => void)[] = [];

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Registers a host (SettleHost) for as long as it is mounted; returns its
 * cleanup. The store subscription lives from the first host to the last, and
 * the last one's cleanup ends any phase, its timers and listeners included.
 */
export function registerShimmerHost(): () => void {
  hosts += 1;
  if (hosts === 1) unsubscribe = usePlannerStore.subscribe?.(onPlannerChange) ?? null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hosts = Math.max(0, hosts - 1);
    if (hosts > 0) return;
    unsubscribe?.();
    unsubscribe = null;
    endShimmer();
  };
}

/** The current phase, or null. */
export function shimmerPhase(): ShimmerPhase | null {
  return phase;
}

/**
 * SettleHost's layout effect while the preview is committed (its first
 * commit, or a host mounting under a preview already up). Starts the wait,
 * before the browser styles the cached rows, so every title's animations and
 * the sync line's start in one frame. Only when the shimmer may move at all
 * (shimmerAllowed): `static` keeps the preview still but for its sync line,
 * and under a veto the CSS would show nothing, so the attribute, the observer
 * and the scroll measures would be work for nothing. The animations switch
 * turned back on mid-wait therefore shows no shimmer for that preview; turned
 * off mid-wait, the CSS drops it at once and the next measure ends it.
 */
export function shimmerPreviewCommitted(): void {
  if (phase === 'wait' || typeof document === 'undefined' || !shimmerAllowed()) return;
  endShimmer();
  phase = 'wait';
  waitAt = performance.now();
  document.documentElement.setAttribute(SHIMMER_ATTR, 'wait');
  const onStart = (e: Event) => onWaitAnimationStart(e as AnimationEvent);
  const onMove = () => queueMeasure(document.querySelectorAll(WAITING_TITLES));
  document.addEventListener('animationstart', onStart, true);
  window.addEventListener('resize', onMove);
  document.addEventListener('scroll', onMove, { capture: true, passive: true });
  off = [
    () => document.removeEventListener('animationstart', onStart, true),
    () => window.removeEventListener('resize', onMove),
    () => document.removeEventListener('scroll', onMove, { capture: true }),
  ];
  // Titles mounted mid-wait. Mutation records are delivered as a microtask
  // after React's commit, before the browser renders, so they join the clock
  // in their first frame. The preview's own commit is already done here.
  if (typeof MutationObserver === 'function' && document.body) {
    const observer = new MutationObserver(onMounted);
    observer.observe(document.body, { childList: true, subtree: true });
    off.push(() => observer.disconnect());
  }
}

/**
 * SettleHost's layout effect on every way the preview ends, BEFORE the
 * conductor holds (lib/settle.ts): the fresh rows as laid out, with no glide
 * transform yet. With no title left to raise (a failed load and a dropped
 * preview empty the planner) the phase ends here. For the light, delays each
 * title's rise by its left edge as a fraction of the viewport, so the light
 * crosses left to right in SHIMMER.spreadMs. One read pass, then one write
 * pass to animation timing only, which moves nothing the conductor measures.
 */
export function shimmerLandingCommitted(): void {
  // Still waiting: the preview ended before this host's subscription was up
  // (a host mounting under the preview, landing before its passive effects).
  if (phase === 'wait') {
    endShimmer();
    return;
  }
  if (phase !== 'land' && phase !== 'ease') return;
  try {
    const titles = [...document.querySelectorAll<HTMLElement>(LANDING_TITLES)];
    if (titles.length === 0) {
      endShimmer();
      return;
    }
    if (phase !== 'land') return;
    const width = window.innerWidth || document.documentElement.clientWidth || 1;
    const at = titles.map((el) => el.getBoundingClientRect().left / width);
    // On each title's own rise animation, not through a custom property: a
    // property would style every title a second time inside the landing,
    // where a long braindump made that tens of milliseconds.
    titles.forEach((el, i) => {
      const delay = Math.round(Math.min(1, Math.max(0, at[i])) * SHIMMER.spreadMs);
      if (delay === 0) return;
      for (const anim of el.getAnimations?.() ?? []) {
        if ((anim as CSSAnimation).animationName === RISE_ANIMATION) anim.effect?.updateTiming({ delay });
      }
    });
  } catch (err) {
    console.warn('[shimmer] landing skipped', err);
    endShimmer();
  }
}

/** Ends any phase at once: attribute, timers and listeners. The titles are text again. Safe at any time. */
export function endShimmer(): void {
  for (const drop of off) {
    try {
      drop();
    } catch {
      /* a listener that is already gone is gone */
    }
  }
  off = [];
  if (endTimer !== null) clearTimeout(endTimer);
  endTimer = null;
  if (measureFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(measureFrame);
  measureFrame = 0;
  queued.clear();
  phase = null;
  waitAt = 0;
  clock = null;
  clockAt = null;
  depthRule?.remove();
  depthRule = null;
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute(SHIMMER_ATTR);
  clearMarks();
}

/**
 * How far the ink had gone down `elapsed` ms into the wait, 0 to 1, on the
 * same curve and delay as the CSS: the plain ease starts from exactly the ink
 * on screen, so a landing mid-way down never dips or jumps.
 */
export function inkDepth(elapsed: number): number {
  const t = (elapsed - SHIMMER.delayMs) / SHIMMER.inkMs;
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return cubicBezier(INK_CURVE, t);
}

/** Whether the shimmer may move at all: `on` mode, neither reduced-motion veto, no forced colours. */
export function shimmerAllowed(): boolean {
  if (PREVIEW_MODE !== 'on' || typeof window === 'undefined') return false;
  if (prefersReducedMotion()) return false;
  return window.matchMedia?.('(forced-colors: active)').matches !== true;
}

// ── The wait ────────────────────────────────────────────────────────────

/** A sweep or the sync line's bar started: hold it to the shared clock, and measure a title for its band. */
function onWaitAnimationStart(e: AnimationEvent): void {
  const name = e.animationName;
  if (name !== SWEEP_ANIMATION && name !== SYNC_BAR_ANIMATION) return;
  const el = e.target;
  if (!(el instanceof Element)) return;
  // A title's mute started with its sweep, so it goes to the clock with it.
  const names = name === SWEEP_ANIMATION ? [SWEEP_ANIMATION, MUTE_ANIMATION] : [name];
  // Reading an animation flushes style, so it is read once, for the clock,
  // and again only for a start in a later frame: everything the preview's
  // commit styled starts in one frame, on the clock already.
  if (clockAt === null) {
    holdToClock(el, names);
    if (clock !== null) clockAt = e.timeStamp;
  } else if (e.timeStamp - clockAt > SAME_FRAME_MS) {
    holdToClock(el, names);
  }
  if (name === SWEEP_ANIMATION) queueMeasure([el]);
}

/**
 * Titles mounted mid-wait under a preview root (a mobile tab switch, a view
 * change): measured, and put on the clock, before their first frame paints.
 */
function onMounted(records: MutationRecord[]): void {
  if (phase !== 'wait') return;
  const found = new Set<Element>();
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(TITLE_SELECTOR)) found.add(node);
      for (const el of node.querySelectorAll(TITLE_SELECTOR)) found.add(el);
    }
  }
  const waiting = [...found].filter((el) => el.isConnected && el.closest(PREVIEW_ROOT) !== null);
  if (waiting.length > 0) writeX(waiting, true);
}

/**
 * One read pass and one write pass for the whole batch, in the next frame:
 * every title that started together reports in the same frame, before its
 * rAF callbacks, and a resize or a scroll measures once however often it fires.
 */
function queueMeasure(els: Iterable<Element>): void {
  for (const el of els) queued.add(el);
  if (measureFrame || typeof requestAnimationFrame !== 'function') return;
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    const batch = [...queued];
    queued.clear();
    writeX(batch);
  });
}

/**
 * The first start seen sets the clock (every animation the preview's commit
 * styled shares it); any later one is moved onto it, so a late title shows
 * the band where every other title shows it, its ink where theirs is, and the
 * cap ends it with them.
 */
function holdToClock(el: Element, names: string[]): void {
  try {
    for (const anim of el.getAnimations?.() ?? []) {
      if (!names.includes((anim as CSSAnimation).animationName)) continue;
      const at = anim.startTime;
      if (typeof at !== 'number') continue;
      if (clock === null) clock = at;
      else if (Math.abs(at - clock) > 1) anim.startTime = clock;
    }
  } catch {
    /* without the Web Animations API a late title keeps its own phase */
  }
}

/**
 * Each title's left edge in the viewport, the offset its gradient is drawn
 * from; a title outside the viewport is marked away instead. A title that
 * comes back into view, or was just `mounted`, joins the clock.
 */
function writeX(els: Element[], mounted = false): void {
  if (phase !== 'wait') return;
  // A veto that arrived mid-wait (the animations switch, synced from the
  // server): the CSS already shows nothing, so nothing is measured for it.
  if (!shimmerAllowed()) {
    endShimmer();
    return;
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rects = els.map((el) => (el.isConnected ? el.getBoundingClientRect() : null));
  const joining: Element[] = [];
  els.forEach((el, i) => {
    const r = rects[i];
    if (r === null || !(el instanceof HTMLElement)) return;
    const away = r.bottom <= 0 || r.top >= height || r.right <= 0 || r.left >= width;
    const wasAway = el.hasAttribute(AWAY_ATTR);
    if (away !== wasAway) el.toggleAttribute(AWAY_ATTR, away);
    if (away) return;
    el.style.setProperty(X_PROPERTY, `${Math.round(r.left * 100) / 100}px`);
    placed.add(el);
    if (wasAway || mounted) joining.push(el);
  });
  joinClock(joining);
}

/**
 * Titles that join the wait after it began. Each one's animations start from
 * scratch (away had dropped them, or it is new), and a fresh mute would show
 * full ink through its 300ms delay, then ease down out of step with every
 * title beside it; a fresh sweep would wait out the same delay. So both are
 * set to the clock's start here, in the frame the title is first styled,
 * before it paints. One read pass (a single style flush), then the writes.
 */
function joinClock(els: Element[]): void {
  if (els.length === 0) return;
  try {
    const at = clock ?? referenceClock(els);
    if (at === null) return;
    const anims = els.flatMap((el) => el.getAnimations?.() ?? []);
    for (const anim of anims) {
      const name = (anim as CSSAnimation).animationName;
      if ((name === MUTE_ANIMATION || name === SWEEP_ANIMATION) && anim.startTime !== at) anim.startTime = at;
    }
  } catch {
    /* without the Web Animations API a late title keeps its own phase */
  }
}

/**
 * A join before any sweep has reported its start (inside the delay): the
 * start of a sweep already running on another waiting title, which every
 * title the preview's commit styled shares, or with none left (a phone tab
 * switch inside the delay replaces every title) the sync line's bar, which
 * mounted with them and outlives the tab. It becomes the clock.
 */
function referenceClock(joining: Element[]): number | null {
  const skip = new Set(joining);
  for (const el of document.querySelectorAll(WAITING_TITLES)) {
    if (skip.has(el) || el.hasAttribute(AWAY_ATTR)) continue;
    const at = startOf(el, SWEEP_ANIMATION);
    if (at !== null) return (clock = at);
  }
  const bar = document.querySelector(SYNC_BAR_SELECTOR);
  const at = bar ? startOf(bar, SYNC_BAR_ANIMATION) : null;
  if (at !== null) clock = at;
  return at;
}

/** The start time of `el`'s CSS animation `name`, or null when it has none yet. */
function startOf(el: Element, name: string): number | null {
  const anim = el.getAnimations?.().find((a) => (a as CSSAnimation).animationName === name);
  return typeof anim?.startTime === 'number' ? anim.startTime : null;
}

/** The end leaves no title marked away and none carrying an inline x. */
function clearMarks(): void {
  for (const el of document.querySelectorAll(`[${AWAY_ATTR}]`)) el.removeAttribute(AWAY_ATTR);
  for (const el of placed) el.style.removeProperty(X_PROPERTY);
  placed.clear();
}

// ── The end of the preview ──────────────────────────────────────────────

/** Runs INSIDE every planner set(), the landing's included: nothing may escape it. */
function onPlannerChange(s: PlannerState, prev: PlannerState): void {
  if (!prev.isPreview || s.isPreview || phase !== 'wait') return;
  try {
    previewEnded(s, prev);
  } catch (err) {
    console.warn('[shimmer] ended plainly', err);
    endShimmer();
  }
}

function previewEnded(s: PlannerState, prev: PlannerState): void {
  const elapsed = waitElapsed();
  const seen = elapsed >= SHIMMER.delayMs;
  // Another account's rows are coming, and nothing of this one's survives.
  const sameAccount = s.userId === prev.userId;
  if (!seen || !sameAccount || !shimmerAllowed() || document.visibilityState !== 'visible') {
    endShimmer();
    return;
  }
  const fresh = selectPlannerLoaded(s) && elapsed >= LIGHT_AFTER_MS;
  begin(fresh ? 'land' : 'ease', fresh ? 1 : inkDepth(elapsed));
}

/**
 * How long the shimmer's own clock has run: from the first frame that styled
 * the waiting titles, which can trail the preview's commit by a long first
 * frame. The thresholds then match the ink on screen. Before any sweep has
 * started, from the commit.
 */
function waitElapsed(): number {
  const now = performance.now();
  if (clock !== null) return now - clock;
  try {
    const el = document.querySelector(WAITING_TITLES);
    const at = el ? startOf(el, SWEEP_ANIMATION) : null;
    if (at !== null) return now - at;
  } catch {
    /* the commit's moment is close enough */
  }
  return now - waitAt;
}

/**
 * Switches the phase before React commits the fresh rows. The waiting rule
 * and the landing rule share the sweep, so a band mid-crossing carries on
 * (CSS keeps an animation whose name stays in the list) until the rising ink
 * overtakes it; the mute gives way to the rise, which starts from the depth
 * the ink had reached.
 */
function begin(next: 'land' | 'ease', depth: number): void {
  for (const drop of off) drop();
  off = [];
  queued.clear();
  if (measureFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(measureFrame);
  measureFrame = 0;
  phase = next;
  // A rise starts from the full waiting ink unless told otherwise. Anything
  // less is told to the titles alone, by a rule: a custom property on <html>
  // re-styles every element in the document, inside the landing, and at a 4x
  // CPU throttle that held the fresh planner back by about 150ms.
  if (depth < 1) {
    depthRule = document.createElement('style');
    depthRule.textContent = `${TITLE_SELECTOR} { --planner-shimmer-depth: ${Math.round(depth * 1000) / 10}%; }`;
    document.head.appendChild(depthRule);
  }
  document.documentElement.setAttribute(SHIMMER_ATTR, next);
  const run = next === 'land' ? SHIMMER.spreadMs + SHIMMER.riseMs : SHIMMER.easeMs;
  // The rises start with the first frame after the commit, which can be a
  // long way off after a big landing: timed from here, the attribute could
  // come off before the light had shown at all. So the end follows the first
  // rise's start, the event's own time (reading the animation would flush
  // style in the landing's first frame); the backstop covers a landing with
  // no titles.
  const onStart = (e: Event) => {
    const ev = e as AnimationEvent;
    if (ev.animationName !== RISE_ANIMATION || phase !== next) return;
    document.removeEventListener('animationstart', onStart, true);
    const startedAt = Math.min(performance.now(), ev.timeStamp || Infinity);
    arm(startedAt + run + SHIMMER.slackMs - performance.now());
  };
  document.addEventListener('animationstart', onStart, true);
  off = [() => document.removeEventListener('animationstart', onStart, true)];
  arm(SHIMMER.backstopMs);
}

function arm(ms: number): void {
  if (endTimer !== null) clearTimeout(endTimer);
  endTimer = setTimeout(endShimmer, Math.max(0, ms));
}

// ── Curve ───────────────────────────────────────────────────────────────

/** y at x on a CSS cubic-bezier(x1, y1, x2, y2): Newton steps, then bisection. */
function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number], x: number): number {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const err = sx(t) - x;
    if (Math.abs(err) < 1e-6) return sy(t);
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i += 1) {
    const v = sx(t);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sy(t);
}
