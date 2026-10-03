import { useDragStore } from '@/lib/drag-store';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { isPlannerPreviewing, selectPlannerLoaded } from '@/lib/planner-ready';
import { PREVIEW_MODE } from '@/lib/planner-snapshot';
import { usePlannerStore } from '@/lib/planner-store';
import { bumpSettleEpoch } from '@/lib/settle-epoch';
import {
  EASE_SETTLE,
  SETTLE,
  SETTLE_LIMITS,
  createKeyDeduper,
  planScope,
  type Rect,
  type SettleNode,
  type SettlePlan,
  type SettleRole,
  type SettleSide,
} from '@/lib/settle-plan';
import { useViewStore } from '@/lib/view-store';
import { prefersReducedMotion } from '@/lib/zen-transition';

/**
 * settle.ts — the cached → fresh settle conductor (instant planner, design §9).
 *
 * When the look-only preview (lib/planner-snapshot.ts) gives way to the fresh
 * load, everything on screen that moved glides from where the preview drew it
 * to where the fresh data puts it, in place:
 *
 *  1. CAPTURE (FIRST) inside the landing set(), from a planner-store
 *     subscriber. React has not committed yet — a concurrent root flushes a
 *     sync-lane store update in a microtask — so the DOM still shows the
 *     preview. Whatever the motion setting: the plan also drives the shield.
 *  2. MEASURE (LAST) and PLAN in SettleHost's layout effect: after React's
 *     mutations, before paint (lib/settle-plan.ts decides what each node does).
 *  3. HOLD: every animation is created and paused at 0. Fill is `backwards`,
 *     so the first painted frame still shows the preview geometry. Follow-up
 *     commits (a held capture's addTask, the sweep's batch, useFitHourPx, the
 *     week anytime band's ResizeObserver) re-hold against the same FIRST, and
 *     the run plays once two frames pass quietly — 2 to 8 frames. A landing
 *     that changed nothing still watches those frames: its follow-ups are the
 *     only change, and they settle (or shield) like any other.
 *  4. PLAY, retargeting a scope from where its boxes are DRAWN when a commit
 *     lands mid-glide (at most twice), then FINISH: every animation cancelled.
 *     Fill is never `forwards`, so nothing outlives the run — no resting
 *     transform for dnd-kit, Zen's trace or hover-expand to trip over.
 *
 * A mutation counts as a commit only when it moved something: most records in
 * a scope move nothing (a hover writing a row's --title-mask, the ScrollArea
 * mounting its scrollbar or restyling its thumb each wheel frame), and each
 * would otherwise re-aim the glide — the third snapping it. Positions are
 * compared net of the run's own translates and of scrolling, which moves
 * content without being a change: every rect a pass keeps is carried by the
 * scrollers above it until the next pass, sticky boxes holding their axes.
 *
 * Transform and clip-path only, on the participants' own boxes: no overlay, no
 * opacity, no filter, so lime is never faded (CLAUDE.md) and nothing escapes a
 * scroller's clip. No custom-property writes and nothing on the hover path, so
 * the week recede rule is untouched.
 *
 * THE LANDING SHIELD. A landing that changed what is on screen with nothing
 * holding the old geometry (reduced motion, `static` mode, a veto at play, a
 * scope too changed to follow, a scope snapped mid-run) swallows pointer
 * activations inside those scopes for `shieldMs`: a click aimed at a preview
 * row must never tick — or post to Beeminder — on whatever fresh row is
 * under the cursor now. Each scope keeps its own clock, and a press that
 * began under one keeps it shielded until that press's click has passed.
 * A pointerdown that interrupts a scope still moving shields it the same way.
 * Keyboard is untouched (a click with no pointer count is Enter or Space),
 * and so are text fields, which tick nothing and must take focus.
 *
 * `<html data-planner-settling>` is up from the landing until the run and any
 * shield are over; e2e's waitForAppReady waits it out.
 *
 * Participants are declarative (`data-settle-scope`, `data-settle-key`,
 * `data-settle-role="frame"`), tracked by KEY, never by element: a skipped
 * variant or a remount replaces the node, so every pass re-queries.
 *
 * No module-eval side effects: the planner-store subscription the capture
 * needs is created by the first `registerSettleHost` and dropped with the last.
 */

type PlannerState = ReturnType<typeof usePlannerStore.getState>;

/** On <html> while a run or a shield is live. */
export const SETTLING_ATTR = 'data-planner-settling';

const SCOPE_SELECTOR = '[data-settle-scope]';
const KEY_SELECTOR = '[data-settle-key]';
const FRAME_SELECTOR = '[data-settle-role="frame"]';

/** A row's change signature reads these beside its text. data-selected is deliberately absent. */
const SIG_ATTRS = [
  'data-row-variant',
  'data-completed',
  'data-suppressed',
  'data-bucket',
  'data-start-time',
  'data-start-min',
  'data-duration',
] as const;

/** Clip insets run this far outside the box, so focus rings and shadows aren't shaved mid-reveal. */
const BLEED = `-${SETTLE.clipBleedPx}px`;
const OPEN = `inset(${BLEED})`;
/** Left → right: a row's type-in, the notice-type identity. */
const TYPE_IN = `inset(${BLEED} 100% ${BLEED} ${BLEED})`;
/** Top → down: a frame unfolding. */
const UNFOLD = `inset(${BLEED} ${BLEED} 100% ${BLEED})`;
const REST = 'translateY(0px)';
/** The small lift a new row types in on, and the drop a new frame unfolds from. */
const APPEAR_ROW_PX = 4;
const APPEAR_FRAME_PX = -3;
/** A finish lands this long after the last animation's end, so its last frame is painted first. */
const FINISH_SLACK_MS = 50;
/** A frame's reveal leaves its other edges this far out: whatever glides into it, from anywhere on screen. */
const REACH = '-10000px';
/** Under a pixel is rounding, not motion. */
const PX = 1;
/** After a shielded press's pointerup, its click is waited for this long (a tap's comes a task later). */
const CLICK_GRACE_MS = 100;
/** A shielded press whose pointerup never comes (focus lost mid-press) stops holding its scope after this. */
const PRESS_CAP_MS = 2000;

// ── Module state ────────────────────────────────────────────────────────

/** Live SettleHost mounts. Counted, not flagged, so a StrictMode remount cannot leave it stuck. */
let hosts = 0;
let unsubscribe: (() => void) | null = null;

/**
 * Whether the preview this landing ends actually reached the screen (two
 * frames after it committed). A preview that never painted has nothing on
 * screen to settle FROM, so its landing must not animate.
 */
let previewPainted = false;

/** FIRST, from inside the landing set(); spent by the layout effect that follows. */
let pending: Captured[] | null = null;
let run: Run | null = null;
let shield: Shield | null = null;

// ── Types ───────────────────────────────────────────────────────────────

type Vec = { x: number; y: number };

interface Captured {
  root: Element;
  first: SettleSide;
  scroll: ScrollMarks;
}

/** A scroller whose scrolling carries a box, in the axes it does: a sticky box on the way holds its own. */
interface ScrollLink {
  el: Element;
  x: boolean;
  y: boolean;
}

/** One pass's view of scrolling: each participant's scrollers, and where they stood then. */
interface ScrollMarks {
  links: Map<string, ScrollLink[]>;
  at: Map<Element, Vec>;
}

/** One participant, its key resolved; no geometry yet. */
interface Participant {
  key: string;
  role: SettleRole;
  el: HTMLElement;
  /** What animates: the row's SwipeRow when it has one (mobile), else the participant itself. */
  box: HTMLElement;
  id?: string;
  parent?: string;
}

interface Measured {
  side: SettleSide;
  boxes: Map<string, HTMLElement>;
  /** As resolved for the pass: a mutation that cannot change who takes part is checked against these. */
  parts: Participant[];
  scroll: ScrollMarks;
}

/** left/top/right/bottom, for intersecting. */
interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type AnimKind = 'translate' | 'clip';

interface Live {
  anim: Animation;
  /** Retarget recreates the translates from where they are drawn; the clips keep running. */
  kind: AnimKind;
  box: HTMLElement;
  /** A translate's first keyframe, which it runs down to zero. */
  from: Vec | null;
  /** delay + duration, should the effect not report its own end. */
  span: number;
  /** performance.now() at which it ends; set when it starts playing. */
  end: number;
}

interface ScopeRun {
  root: Element;
  first: SettleSide;
  /** FIRST's scrollers as they stood at the landing: scrolling since carries what the hold shows. */
  firstScroll: ScrollMarks;
  /** The latest LAST: the landing's, then each re-hold's and retarget's. */
  last: Measured;
  plan: SettlePlan;
  live: Live[];
  observer: MutationObserver | null;
  retargets: number;
  shielded: boolean;
  /** Retargeted out, or gone from the document: nothing of it animates any more. */
  done: boolean;
}

interface Run {
  scopes: ScopeRun[];
  /** False when nothing may animate: the run only watches, shielding what its follow-ups move. */
  animate: boolean;
  phase: 'hold' | 'play';
  landedAt: number;
  playedAt: number;
  frames: number;
  quiet: number;
  /** A scope committed since the last frame. */
  mutated: boolean;
  raf: number | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  finishTimer: ReturnType<typeof setTimeout> | null;
  capTimer: ReturnType<typeof setTimeout> | null;
  off: (() => void)[];
}

interface Press {
  root: Element;
  began: number;
  released: number | null;
}

interface Shield {
  /** Each root's own end, so a later shield on another scope never stretches it. */
  until: Map<Element, number>;
  /** Presses that began on a shielded root, by pointerId: each holds that root until its click has passed. */
  presses: Map<number, Press>;
  timer: ReturnType<typeof setTimeout> | null;
}

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Registers a SettleHost for as long as it is mounted; returns its cleanup.
 * The store subscription lives from the first host to the last, so the
 * module does nothing while no planner is mounted.
 */
export function registerSettleHost(): () => void {
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
    pending = null;
    previewPainted = false;
    finishSettle();
    endShield();
  };
}

/** SettleHost's double-rAF after the preview commits: the cached planner is on screen now. */
export function notePreviewPainted(): void {
  previewPainted = isPlannerPreviewing();
}

/**
 * SettleHost's layout effect on the preview → not-preview edge: after the
 * commit's DOM mutations, before paint. Measures LAST against what the
 * landing set() captured, then shields, holds or does nothing.
 */
export function onLandingCommitted(): void {
  try {
    // The rows just moved under a stationary pointer: a ⌘-key aimed at "the
    // hovered row" must not act on whichever fresh row slid in under it. Zen
    // clears it on entry for the same reason.
    setHoveredItemRef(null, null);

    const captured = pending;
    pending = null;
    if (!captured) return;

    const scopes: ScopeRun[] = [];
    for (const { root, first, scroll } of captured) {
      // A scope that remounted under the landing (a mobile tab switch) has
      // nothing on screen to settle from.
      if (!root.isConnected) continue;
      const last = measureScope(root);
      if (!last) continue;
      scopes.push({
        root,
        first,
        firstScroll: rebase(scroll),
        last,
        plan: planScope(first, last.side, SETTLE_LIMITS),
        live: [],
        observer: null,
        retargets: 0,
        shielded: false,
        done: false,
      });
    }
    if (scopes.length === 0) return;

    const animate = motionAllowed();
    // Nothing will hold the old geometry where nothing animates — or where a
    // scope changed too much to follow and only rises into place.
    shieldScopes(scopes.filter((s) => (animate ? s.plan.mode === 'large' : s.plan.changed)));
    // Run even when nothing changed: the held capture's addTask and the
    // sweep's batch land in commits of their own, just after this one.
    startRun(scopes, animate);
  } catch (err) {
    console.warn('[settle] landing skipped', err);
    finishSettle();
  }
}

/**
 * Ends any settle at once: every animation cancelled (fill is never
 * `forwards`, so each element rests at its natural layout), observers,
 * listeners and timers dropped. The attribute stays only for a live shield.
 * Safe to call at any time, from anywhere — a store listener included.
 */
export function finishSettle(): void {
  const r = run;
  run = null;
  if (r) {
    if (r.raf !== null) cancelAnimationFrame(r.raf);
    for (const t of [r.holdTimer, r.finishTimer, r.capTimer]) if (t !== null) clearTimeout(t);
    for (const s of r.scopes) {
      s.observer?.disconnect();
      cancelLive(s.live);
      s.live = [];
    }
    for (const off of r.off) {
      try {
        off();
      } catch {
        /* a listener that is already gone is gone */
      }
    }
  }
  if (!shield && typeof document !== 'undefined') document.documentElement.removeAttribute(SETTLING_ATTR);
}

// ── Capture ─────────────────────────────────────────────────────────────

/** Runs INSIDE every planner set(), the landing's included, so nothing may escape it. */
function onPlannerChange(s: PlannerState, prev: PlannerState): void {
  try {
    if (run && interruptsRun(s, prev)) finishSettle();
    if (!prev.isPreview || s.isPreview) return; // only the preview → not-preview edge
    // The completed-sinks hold adopts fresh completions on this edge whatever
    // happens below (hooks/use-sink-hold.ts).
    bumpSettleEpoch();
    finishSettle();
    const painted = previewPainted;
    previewPainted = false;
    // A failed load and a crash drop end the preview too, with nothing fresh
    // to settle onto; an account reset has someone else's rows coming.
    const ok =
      painted &&
      selectPlannerLoaded(s) &&
      s.userId === prev.userId &&
      document.visibilityState === 'visible';
    pending = ok ? captureAll() : null; // FIRST: the DOM still shows the preview
  } catch (err) {
    pending = null;
    console.warn('[settle] capture skipped', err);
  }
}

/** A day or a view change mid-run: the views remount and slide, and the captured geometry means nothing. */
function interruptsRun(s: PlannerState, prev: PlannerState): boolean {
  if (s.navDirection != null) return true;
  const a = s.selectedDate;
  const b = prev.selectedDate;
  return a !== b && a?.getTime?.() !== b?.getTime?.();
}

function captureAll(): Captured[] | null {
  const captured: Captured[] = [];
  for (const root of document.querySelectorAll(SCOPE_SELECTOR)) {
    const m = measureScope(root);
    if (m) captured.push({ root, first: m.side, scroll: m.scroll });
  }
  return captured.length > 0 ? captured : null;
}

// ── Measure ─────────────────────────────────────────────────────────────

/**
 * One scope's participants, keyed, in DOM order (ancestors first), with no
 * geometry read. Null past maxNodesPerScope: a scope that big is not
 * settled at all.
 *
 *  - A row keeps its raw key (`${dateStr}|${id}`), so it is found again in
 *    another group or column; its id pairs it when the key itself changed.
 *  - A frame is qualified by its nearest frame ancestor's full key, else its
 *    day (`[data-date]`): seven week columns each have an `hour:9`.
 *  - Repeats are numbered in DOM order (`k`, `k#2`), the same on both sides.
 */
function resolveScope(root: Element): Participant[] | null {
  const els = root.querySelectorAll<HTMLElement>(KEY_SELECTOR);
  if (els.length > SETTLE.maxNodesPerScope) return null;
  const dedupe = createKeyDeduper();
  const keyOf = new Map<Element, string>();
  const out: Participant[] = [];
  for (const el of els) {
    if (el.closest(SCOPE_SELECTOR) !== root) continue; // a nested scope's own
    const raw = el.getAttribute('data-settle-key');
    if (!raw) continue;
    const role: SettleRole = el.getAttribute('data-settle-role') === 'frame' ? 'frame' : 'row';
    let key: string;
    if (role === 'frame') {
      const outer = el.parentElement?.closest(FRAME_SELECTOR);
      const prefix =
        (outer && keyOf.get(outer)) || el.closest('[data-date]')?.getAttribute('data-date') || '';
      key = dedupe(`${prefix}/${raw}`);
    } else {
      key = dedupe(raw);
    }
    keyOf.set(el, key);

    // On a phone the row slides by its SwipeRow box (overflow-hidden): moving
    // the row inside it would clip it in its own strip.
    let box = el;
    if (role === 'row') {
      const sink = el.closest<HTMLElement>('[data-sink-row]');
      if (sink && root.contains(sink)) box = sink;
    }
    const parentEl = box.parentElement?.closest(KEY_SELECTOR);
    const parent = parentEl ? keyOf.get(parentEl) : undefined;
    const p: Participant = { key, role, el, box };
    const id = role === 'row' ? el.getAttribute('data-item-id') : null;
    if (id) p.id = id;
    if (parent !== undefined) p.parent = parent;
    out.push(p);
  }
  return out;
}

/**
 * One rect read per participant, plus one per clipping ancestor (cached for
 * the pass). Visible = intersects the scope's clip and every clipping
 * ancestor's; only visible rows read a signature.
 */
function measureParticipants(root: Element, parts: Participant[]): Measured {
  const styleOf = styleCache();
  const clip = clipperOf(root, styleOf);
  const scrollers = scrollLinker(styleOf);
  const nodes = new Map<string, SettleNode>();
  const boxes = new Map<string, HTMLElement>();
  const links = new Map<string, ScrollLink[]>();
  for (const p of parts) {
    const r = p.box.getBoundingClientRect();
    const rect: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    const visible = overlaps(rect, clip(p.box.parentElement));
    const node: SettleNode = { key: p.key, role: p.role, rect, visible, topLevel: p.parent === undefined };
    if (p.id) node.id = p.id;
    if (p.parent !== undefined) node.parent = p.parent;
    if (p.role === 'row' && visible) node.sig = signature(p.el);
    nodes.set(p.key, node);
    boxes.set(p.key, p.box);
    links.set(p.key, scrollers.of(p.box));
  }
  return { side: { nodes }, boxes, parts, scroll: { links, at: scrollers.at } };
}

function measureScope(root: Element): Measured | null {
  const parts = resolveScope(root);
  return parts ? measureParticipants(root, parts) : null;
}

/**
 * The visible region at any element under `root`: the scope's own box (its
 * nearest box, since view-root is `display: contents`) ∩ the viewport ∩ every
 * clipping ancestor in between — ScrollArea viewports, the braindump
 * scroller, the week anytime strip, the Zen fold. Memoized per element, so a
 * pass reads each clipping ancestor's style and rect once.
 */
function clipperOf(root: Element, styleOf: StyleOf): (el: Element | null) => Bounds | null {
  let outer: Element | null = root;
  while (outer && styleOf(outer).display === 'contents') outer = outer.parentElement;
  const viewport: Bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const scopeClip = outer ? intersect(viewport, boundsOf(outer)) : null;
  const memo = new Map<Element, Bounds | null>();
  const at = (el: Element | null): Bounds | null => {
    if (!el || el === outer || el === document.documentElement) return scopeClip;
    const known = memo.get(el);
    if (known !== undefined) return known;
    const above = at(el.parentElement);
    const own = above && clipsOverflow(styleOf(el)) ? intersect(above, boundsOf(el)) : above;
    memo.set(el, own);
    return own;
  };
  return at;
}

type StyleOf = (el: Element) => CSSStyleDeclaration;

/** One computed style per element per pass: the clip walk and the scroll walk share it. */
function styleCache(): StyleOf {
  const memo = new Map<Element, CSSStyleDeclaration>();
  return (el) => {
    let cs = memo.get(el);
    if (!cs) {
      cs = getComputedStyle(el);
      memo.set(el, cs);
    }
    return cs;
  };
}

function clipsOverflow(cs: CSSStyleDeclaration): boolean {
  return `${cs.overflowX} ${cs.overflowY} ${cs.overflow}`
    .split(/\s+/)
    .some((v) => v !== '' && v !== 'visible');
}

/** Can be scrolled, by the user or by script: `clip` cannot. */
function scrolls(cs: CSSStyleDeclaration): boolean {
  return [cs.overflowX, cs.overflowY].some((v) => v === 'auto' || v === 'scroll' || v === 'hidden' || v === 'overlay');
}

const inset = (v: string) => v !== '' && v !== 'auto';

/**
 * Which scrollers carry each element when they scroll, memoized per element
 * for a pass, and where each stood. Every scroll container above it counts
 * (the document's too: the phone shell scrolls it), except in the axes a
 * sticky box on the way holds against its own scroller — the week's pinned
 * heads (Anytime) and hour gutter stay put while the grid scrolls past.
 * A sticky box is taken as stuck: the week's are from the first pixel.
 */
function scrollLinker(styleOf: StyleOf): { of: (el: Element) => ScrollLink[]; at: Map<Element, Vec> } {
  const at = new Map<Element, Vec>();
  const memo = new Map<Element, ScrollLink[]>();
  const link = (el: Element): ScrollLink => {
    if (!at.has(el)) at.set(el, { x: el.scrollLeft, y: el.scrollTop });
    return { el, x: true, y: true };
  };
  const of = (el: Element): ScrollLink[] => {
    const known = memo.get(el);
    if (known) return known;
    const parent = el.parentElement;
    let links: ScrollLink[];
    if (!parent) {
      const doc = document.scrollingElement;
      links = doc ? [link(doc)] : [];
    } else {
      links = of(parent);
      // <html>'s own overflow is the document's scroll, already counted.
      if (parent !== document.documentElement && scrolls(styleOf(parent))) links = [...links, link(parent)];
    }
    const cs = styleOf(el);
    const port = links[links.length - 1];
    if (cs.position === 'sticky' && port) {
      const x = port.x && !(inset(cs.left) || inset(cs.right));
      const y = port.y && !(inset(cs.top) || inset(cs.bottom));
      links = [...links.slice(0, -1), { el: port.el, x, y }];
    }
    memo.set(el, links);
    return links;
  };
  return { of, at };
}

/** The same scrollers, where they stand now. */
function rebase(marks: ScrollMarks): ScrollMarks {
  const at = new Map<Element, Vec>();
  for (const el of marks.at.keys()) at.set(el, { x: el.scrollLeft, y: el.scrollTop });
  return { links: marks.links, at };
}

/** How far each scroller has scrolled since the marks were taken; null when none has. */
function scrolledSince(marks: ScrollMarks): Map<Element, Vec> | null {
  let moved: Map<Element, Vec> | null = null;
  for (const [el, then] of marks.at) {
    if (!el.isConnected) continue;
    const dx = el.scrollLeft - then.x;
    const dy = el.scrollTop - then.y;
    if (dx !== 0 || dy !== 0) (moved ??= new Map()).set(el, { x: dx, y: dy });
  }
  return moved;
}

/** Where scrolling since has carried one box: content goes up as its scroller scrolls down. */
function scrollShift(links: ScrollLink[] | undefined, moved: Map<Element, Vec> | null): Vec {
  let x = 0;
  let y = 0;
  if (moved && links) {
    for (const l of links) {
      const d = moved.get(l.el);
      if (!d) continue;
      if (l.x) x -= d.x;
      if (l.y) y -= d.y;
    }
  }
  return { x, y };
}

/** A side as it would be drawn now with no layout change: every rect carried by whatever has scrolled since. */
function asScrolled(side: SettleSide, marks: ScrollMarks): SettleSide {
  const moved = scrolledSince(marks);
  if (!moved) return side;
  const nodes = new Map<string, SettleNode>();
  for (const [key, node] of side.nodes) {
    const d = scrollShift(marks.links.get(key), moved);
    const rect = { ...node.rect, left: node.rect.left + d.x, top: node.rect.top + d.y };
    nodes.set(key, d.x === 0 && d.y === 0 ? node : { ...node, rect });
  }
  return { nodes };
}

function boundsOf(el: Element): Bounds {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

function intersect(a: Bounds, b: Bounds): Bounds | null {
  const out = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return out.right > out.left && out.bottom > out.top ? out : null;
}

/** A box with no size at all is not rendered (display: none). A hairline still counts. */
function overlaps(r: Rect, c: Bounds | null): boolean {
  if (!c || (r.width <= 0 && r.height <= 0)) return false;
  return r.left < c.right && r.left + r.width > c.left && r.top < c.bottom && r.top + r.height > c.top;
}

function signature(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return [text, ...SIG_ATTRS.map((a) => el.getAttribute(a) ?? '')].join('|');
}

// ── Motion ──────────────────────────────────────────────────────────────

/**
 * Every veto, asked at landing and again at play — never cached, since the
 * animations toggle can land from the server mid-hold. prefersReducedMotion()
 * is both vetoes (the OS query and `data-reduce-motion`); the CSS clamp never
 * reaches element.animate().
 */
function motionAllowed(): boolean {
  return (
    PREVIEW_MODE === 'on' &&
    !prefersReducedMotion() &&
    document.visibilityState === 'visible' &&
    typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.animate === 'function' &&
    // dnd-kit measures droppables at drag start, through any moving ancestor.
    !useDragStore.getState?.()?.activeId &&
    // The nav slide is a transform on the keyed container that remounts at +600ms.
    (usePlannerStore.getState?.()?.navDirection ?? null) === null &&
    !useViewStore.getState?.()?.zenMoving
  );
}

const translate = (dx: number, dy: number) => `translate(${dx}px, ${dy}px)`;

/**
 * One scope's plan as WAAPI animations, §9.6's table exactly. A retarget
 * passes its own glide length and asks for reveals without their lead: what
 * it re-aims is already on its way.
 */
function buildAnimations(
  plan: SettlePlan,
  boxes: Map<string, HTMLElement>,
  { moveMs = SETTLE.moveMs, immediate = false }: { moveMs?: number; immediate?: boolean } = {}
): Live[] {
  const out: Live[] = [];
  const add = (
    key: string,
    from: Vec | null,
    keyframes: Keyframe[],
    duration: number,
    delay: number,
    composite: CompositeOperation
  ) => {
    const box = boxes.get(key);
    if (!box || typeof box.animate !== 'function') return;
    // `backwards` only: a delayed reveal shows its first frame through the
    // delay, and nothing is left behind once it ends.
    const anim = box.animate(keyframes, { duration, delay, easing: EASE_SETTLE, fill: 'backwards', composite });
    out.push({ anim, kind: from ? 'translate' : 'clip', box, from, span: delay + duration, end: 0 });
  };
  const lift = (key: string, y: number, duration: number, delay: number) =>
    add(key, { x: 0, y }, [{ transform: `translateY(${y}px)` }, { transform: REST }], duration, delay, 'add');

  for (const m of plan.moves) {
    // `add`: on top of the box's own transform (the gutter live-time's -translate-y-1/2).
    if (Math.abs(m.dx) >= PX || Math.abs(m.dy) >= PX) {
      const keyframes = [{ transform: translate(m.dx, m.dy) }, { transform: translate(0, 0) }];
      add(m.key, { x: m.dx, y: m.dy }, keyframes, moveMs, 0, 'add');
    }
    if (m.grow) {
      // The box's new extent is revealed as it glides: it starts clipped to its old size.
      const right = m.grow.dw > 1 ? `${m.grow.dw}px` : BLEED;
      const bottom = m.grow.dh > 1 ? `${m.grow.dh}px` : BLEED;
      const keyframes = [{ clipPath: `inset(${BLEED} ${right} ${bottom} ${BLEED})` }, { clipPath: OPEN }];
      add(m.key, null, keyframes, moveMs, 0, 'replace');
    }
    if (m.reveal) {
      // A frame's new height is uncovered as its rows glide in, on their curve,
      // so the card edge travels with them. Only the bottom edge cuts: the
      // others reach past anything gliding in from elsewhere.
      const keyframes = [
        { clipPath: `inset(${REACH} ${REACH} ${m.reveal}px ${REACH})` },
        { clipPath: `inset(${REACH} ${REACH} ${BLEED} ${REACH})` },
      ];
      add(m.key, null, keyframes, moveMs, 0, 'replace');
    }
  }
  for (const a of plan.appears) {
    const row = a.role === 'row';
    // A new row waits for the gap it lands in to open, then cascades by rank.
    const lead = row
      ? SETTLE.appearLead + Math.min(a.rank, SETTLE.appearMaxRank) * SETTLE.appearStagger
      : SETTLE.frameAppearLead;
    const delay = immediate ? 0 : lead;
    add(a.key, null, [{ clipPath: row ? TYPE_IN : UNFOLD }, { clipPath: OPEN }], SETTLE.appearMs, delay, 'replace');
    lift(a.key, row ? APPEAR_ROW_PX : APPEAR_FRAME_PX, SETTLE.appearMs, delay);
  }
  // Changed in place: the new content types in once. Fully clipped through
  // the hold, which reads as the start of the rewrite.
  for (const key of plan.retypes) {
    add(key, null, [{ clipPath: TYPE_IN }, { clipPath: OPEN }], SETTLE.retypeMs, 0, 'replace');
  }
  for (const rise of plan.rises) {
    lift(rise.key, SETTLE.riseOffsetPx, SETTLE.riseMs, Math.min(rise.rank, SETTLE.riseMaxRank) * SETTLE.riseStagger);
  }
  return out;
}

function cancelLive(live: Live[]): void {
  for (const l of live) {
    try {
      l.anim.cancel();
    } catch {
      /* already gone with its element */
    }
  }
}

function endTimeOf(l: Live): number {
  const end = l.anim.effect?.getComputedTiming?.().endTime;
  return typeof end === 'number' && Number.isFinite(end) ? end : l.span;
}

/**
 * What the run's own translates add to each box this instant. Computed
 * progress is the EASED progress, and null once an effect is over (fill is
 * never forwards) or cancelled; held at 0 or in its delay, a translate adds
 * its whole first keyframe.
 */
function runningOffsets(live: Live[]): Map<Element, Vec> {
  const own = new Map<Element, Vec>();
  for (const l of live) {
    if (!l.from) continue;
    const p = l.anim.effect?.getComputedTiming?.().progress;
    if (typeof p !== 'number') continue;
    const was = own.get(l.box) ?? { x: 0, y: 0 };
    own.set(l.box, { x: was.x + l.from.x * (1 - p), y: was.y + l.from.y * (1 - p) });
  }
  return own;
}

/** Attributes a participant is resolved from: only these, or a node added or removed, change who takes part. */
const RESOLVE_ATTRS = new Set([
  'data-settle-key',
  'data-settle-role',
  'data-settle-scope',
  'data-item-id',
  'data-sink-row',
  'data-date',
]);

const recasts = (m: MutationRecord) =>
  m.type === 'childList' || (m.type === 'attributes' && RESOLVE_ATTRS.has(m.attributeName ?? ''));

/**
 * Whether a scope's mutation left everything a settle follows where the last
 * pass found it: the same participants, each laid out within a pixel once the
 * run's own translates (on the box and every box above it) and any scrolling
 * since are taken off — and, mid-hold, saying the same thing. A commit moves
 * something; a hover's --title-mask, a scrollbar mounting or the thumb
 * restyling on a wheel frame moves nothing.
 */
function unmoved(s: ScopeRun, records: MutationRecord[], sigs: boolean): boolean {
  const last = s.last;
  let parts = last.parts;
  if (records.some(recasts)) {
    const now = resolveScope(s.root);
    if (!now || now.length !== parts.length) return false;
    for (let i = 0; i < now.length; i += 1) {
      if (now[i].key !== parts[i].key || now[i].box !== parts[i].box) return false;
    }
    parts = now;
  }
  const moved = scrolledSince(last.scroll);
  const own = runningOffsets(s.live);
  const memo = new Map<Element, Vec>();
  const drawnBy = (el: Element | null): Vec => {
    if (!el || el === s.root || own.size === 0) return { x: 0, y: 0 };
    const known = memo.get(el);
    if (known) return known;
    const above = drawnBy(el.parentElement);
    const mine = own.get(el);
    const total = mine ? { x: above.x + mine.x, y: above.y + mine.y } : above;
    memo.set(el, total);
    return total;
  };
  for (const p of parts) {
    const was = last.side.nodes.get(p.key);
    if (!was || !p.box.isConnected) return false;
    const r = p.box.getBoundingClientRect();
    const off = drawnBy(p.box);
    const shift = scrollShift(last.scroll.links.get(p.key), moved);
    if (
      Math.abs(r.left - off.x - (was.rect.left + shift.x)) >= PX ||
      Math.abs(r.top - off.y - (was.rect.top + shift.y)) >= PX ||
      Math.abs(r.width - was.rect.width) >= PX ||
      Math.abs(r.height - was.rect.height) >= PX
    ) {
      return false;
    }
    if (sigs && was.sig !== undefined && signature(p.el) !== was.sig) return false;
  }
  return true;
}

// ── The run ─────────────────────────────────────────────────────────────

const raise = () => document.documentElement.setAttribute(SETTLING_ATTR, 'true');

/** `animate` false: nothing may move, so the run only watches for follow-ups to shield. */
function startRun(scopes: ScopeRun[], animate: boolean): void {
  const r: Run = {
    scopes,
    animate,
    phase: 'hold',
    landedAt: performance.now(),
    playedAt: 0,
    frames: 0,
    quiet: 0,
    mutated: false,
    raf: null,
    holdTimer: null,
    finishTimer: null,
    capTimer: null,
    off: [],
  };
  run = r;
  listen(r);
  for (const s of scopes) {
    if (typeof MutationObserver === 'function') {
      s.observer = new MutationObserver((records) => onScopeMutation(s, records));
      s.observer.observe(s.root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    if (animate) hold(s); // the LAST just measured is current: no DOM has changed since
  }
  // rAF starving (a frozen main thread) must not leave the planner held.
  r.holdTimer = setTimeout(() => {
    if (run !== r) return;
    const roots = r.scopes.filter((s) => s.plan.changed);
    finishSettle();
    shieldScopes(roots);
  }, SETTLE.holdTimeoutMs);
  r.capTimer = setTimeout(finishSettle, SETTLE.runTimeoutMs);
  r.raf = requestAnimationFrame(holdTick);
}

/**
 * The interrupts: anything that says the user is acting, or that the
 * geometry under the run is about to be thrown away. NOT scroll or wheel —
 * every animation is relative to its own box, so scrolling cannot misplace
 * one, and the app scrolls programmatically (clamping, anchoring, the
 * quick-add's scroll-to-bottom).
 */
function listen(r: Run): void {
  const onPointer = (e: Event) => {
    const root = scopeOf(e.target);
    // Only a scope still moving drew what this press aimed at somewhere else.
    const moving = root !== null && r.scopes.some((s) => s.root === root && !s.done && isMoving(s));
    finishSettle();
    // This press already hit what the user saw; after the snap, its click
    // would land on whatever moved in under it.
    if (moving) startShield([root], e);
  };
  const onInterrupt = () => finishSettle();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') finishSettle();
  };
  const pointerOpts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointerdown', onPointer, pointerOpts);
  window.addEventListener('keydown', onInterrupt, true);
  window.addEventListener('resize', onInterrupt);
  document.addEventListener('visibilitychange', onVisibility);
  r.off.push(
    () => window.removeEventListener('pointerdown', onPointer, pointerOpts),
    () => window.removeEventListener('keydown', onInterrupt, true),
    () => window.removeEventListener('resize', onInterrupt),
    () => document.removeEventListener('visibilitychange', onVisibility)
  );
  const offDrag = useDragStore.subscribe?.((s, prev) => {
    if (s.activeId && !prev.activeId) finishSettle();
  });
  const offView = useViewStore.subscribe?.((s, prev) => {
    if (s.zenOpen !== prev.zenOpen || (s.zenMoving && !prev.zenMoving)) finishSettle();
  });
  if (offDrag) r.off.push(offDrag);
  if (offView) r.off.push(offView);
  // The planner's own edges (navDirection, selectedDate) are watched by the
  // conductor's existing subscription: interruptsRun.
}

/** (Re)builds a scope's animations, paused at 0 — the first painted frame still shows FIRST. */
function hold(s: ScopeRun): void {
  cancelLive(s.live);
  s.live = buildAnimations(s.plan, s.last.boxes);
  for (const l of s.live) l.anim.pause();
  if (s.live.length > 0) raise();
}

/** A follow-up commit mid-hold: measure LAST again and re-plan against the same FIRST, as scrolled since. */
function rehold(s: ScopeRun): void {
  cancelLive(s.live);
  s.live = [];
  const last = s.root.isConnected ? measureScope(s.root) : null;
  if (!last) {
    endScope(s);
    return;
  }
  s.last = last;
  s.plan = planScope(asScrolled(s.first, s.firstScroll), last.side, SETTLE_LIMITS);
  hold(s);
}

function holdTick(): void {
  const r = run;
  if (!r || r.phase !== 'hold') return;
  r.raf = null;
  try {
    r.frames += 1;
    r.quiet = r.mutated ? 0 : r.quiet + 1;
    r.mutated = false;
    const quiet = r.frames >= SETTLE.holdMinFrames && r.quiet >= SETTLE.quietFrames;
    if (quiet || r.frames >= SETTLE.holdMaxFrames) play(r);
    else r.raf = requestAnimationFrame(holdTick);
  } catch (err) {
    console.warn('[settle] hold abandoned', err);
    finishSettle();
  }
}

/**
 * A scope's DOM changed. Most such records move nothing (unmoved), and are
 * let be. A commit mid-hold re-holds at once — in the observer's microtask,
 * so no frame is ever painted with a hold aimed from the wrong layout — and
 * resets the quiet count; mid-play it retargets. With motion vetoed, it snaps.
 */
function onScopeMutation(s: ScopeRun, records: MutationRecord[]): void {
  const r = run;
  if (!r || s.done) return;
  try {
    if (unmoved(s, records, r.phase === 'hold')) return;
    if (!r.animate || !motionAllowed()) {
      snap(r, s);
    } else if (r.phase === 'hold') {
      r.mutated = true;
      rehold(s);
    } else {
      retarget(r, s);
    }
  } catch (err) {
    console.warn('[settle] run abandoned', err);
    finishSettle();
  }
}

/**
 * A commit moved something with no motion to hold it. A veto that landed
 * mid-run (the animations toggle from the server, a Zen wave) snaps the whole
 * run, as play() would; a run that never animated keeps watching. Either way
 * what moved is shielded from now.
 */
function snap(r: Run, s: ScopeRun): void {
  if (r.animate) {
    const roots = r.scopes.filter((x) => x === s || x.plan.changed).map((x) => x.root);
    finishSettle();
    startShield(roots);
    return;
  }
  r.mutated = true;
  const last = s.root.isConnected ? measureScope(s.root) : null;
  // The next mutation is checked against this layout.
  if (last) s.last = last;
  else endScope(s, false);
  if (s.root.isConnected) startShield([s.root]);
}

function play(r: Run): void {
  if (!r.animate || !motionAllowed()) {
    const roots = r.scopes.filter((s) => s.plan.changed);
    finishSettle();
    shieldScopes(roots);
    return;
  }
  // The landing and every follow-up the hold watched changed nothing.
  if (r.scopes.every((s) => s.live.length === 0)) {
    finishSettle();
    return;
  }
  if (r.holdTimer !== null) clearTimeout(r.holdTimer);
  r.holdTimer = null;
  r.phase = 'play';
  r.playedAt = performance.now();
  // A scope that grew into large mode during the hold rises rather than
  // glides; nothing holds its old geometry either.
  shieldScopes(r.scopes.filter((s) => s.plan.mode === 'large'));
  for (const s of r.scopes) {
    for (const l of s.live) {
      l.end = r.playedAt + endTimeOf(l);
      l.anim.play();
    }
  }
  scheduleFinish(r);
}

/** The finish lands after the last animation, never past runTimeoutMs from the landing. */
function scheduleFinish(r: Run): void {
  if (r.finishTimer !== null) clearTimeout(r.finishTimer);
  let end = performance.now();
  for (const s of r.scopes) for (const l of s.live) end = Math.max(end, l.end);
  const due = Math.min(end + FINISH_SLACK_MS, r.landedAt + SETTLE.runTimeoutMs);
  r.finishTimer = setTimeout(finishSettle, Math.max(0, due - performance.now()));
}

/**
 * A commit landed mid-glide: re-aim this scope from where its boxes are
 * DRAWN. A box the commit moved was painted last frame at its old layout plus
 * its running offset, so it glides on from there instead of jumping by the
 * commit's delta. Reveals (clip-path) keep running; translates are recreated.
 * At most maxRetargets per scope — past that, the scope snaps and is shielded.
 */
function retarget(r: Run, s: ScopeRun): void {
  if (s.retargets >= SETTLE.maxRetargets || !s.root.isConnected) {
    endScope(s);
    return;
  }
  s.retargets += 1;
  const parts = resolveScope(s.root);
  if (!parts) {
    endScope(s);
    return;
  }
  const moving = isMoving(s);
  // VISUAL: with the running transforms (clip-path never moves a rect).
  const drawn = new Map<string, DOMRect>();
  for (const p of parts) drawn.set(p.key, p.box.getBoundingClientRect());
  const kept: Live[] = [];
  for (const l of s.live) {
    if (l.kind === 'translate') cancelLive([l]);
    else kept.push(l);
  }
  // LAYOUT: where the commit put them.
  const now = measureParticipants(s.root, parts);
  // Where the last pass found each box, carried by any scrolling since: what the user saw scrolls too.
  const prev = asScrolled(s.last.side, s.last.scroll).nodes;
  const elapsed = performance.now() - r.playedAt;
  const moveMs = Math.max(SETTLE.retargetMinMs, SETTLE.moveMs - elapsed);

  // total(k) = painted − layout; a box new to the scope rides its parent.
  const totals = new Map<string, { dx: number; dy: number }>();
  const totalOf = (key: string | undefined): { dx: number; dy: number } => {
    if (key === undefined) return { dx: 0, dy: 0 };
    const known = totals.get(key);
    if (known) return known;
    const node = now.side.nodes.get(key)!;
    const was = prev.get(key);
    const vis = drawn.get(key);
    let t: { dx: number; dy: number };
    if (was && vis) {
      t = {
        dx: was.rect.left + (vis.left - node.rect.left) - node.rect.left,
        dy: was.rect.top + (vis.top - node.rect.top) - node.rect.top,
      };
    } else {
      t = totalOf(node.parent);
    }
    totals.set(key, t);
    return t;
  };

  const plan: SettlePlan = { mode: 'fine', moves: [], appears: [], retypes: [], rises: [], changed: true };
  for (const [key, node] of now.side.nodes) {
    const was = prev.get(key);
    if (!was) {
      // New since the last LAST: it types in at once, unless a new parent's reveal carries it.
      const up = node.parent === undefined ? undefined : now.side.nodes.get(node.parent);
      const parentIsNew = !!up && up.visible && !prev.has(node.parent!);
      if (node.visible && !parentIsNew) plan.appears.push({ key, role: node.role, rank: 0 });
      continue;
    }
    if (!was.visible && !node.visible) continue;
    const t = totalOf(key);
    const base = totalOf(node.parent);
    const dx = t.dx - base.dx;
    const dy = t.dy - base.dy;
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) plan.moves.push({ key, fromKey: key, dx, dy });
  }
  if (plan.moves.length + plan.appears.length > SETTLE.maxAnimationsPerScope) {
    s.live = kept;
    endScope(s, moving);
    return;
  }

  const fresh = buildAnimations(plan, now.boxes, { moveMs, immediate: true });
  const t0 = performance.now();
  for (const l of fresh) l.end = t0 + endTimeOf(l);
  s.live = [...kept, ...fresh];
  s.last = now;
  scheduleFinish(r);
}

/** Still held (no end yet) or still playing: snapping it moves something under the pointer. */
function isMoving(s: ScopeRun): boolean {
  const t = performance.now();
  return s.live.some((l) => l.end === 0 || l.end > t);
}

/** Retargeted out or gone: this scope snaps (shielded, if anything was still moving); the others play on. */
function endScope(s: ScopeRun, moving = isMoving(s)): void {
  s.done = true;
  s.observer?.disconnect();
  s.observer = null;
  cancelLive(s.live);
  s.live = [];
  if (moving && s.root.isConnected) {
    // From the snap, on its own clock, whether or not it was shielded before.
    s.shielded = true;
    startShield([s.root]);
  }
  if (run && run.scopes.every((x) => x.done)) finishSettle();
}

// ── The landing shield ──────────────────────────────────────────────────

const SHIELDED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'auxclick'] as const;
const PRESS_ENDS = ['pointerup', 'pointercancel'] as const;

/** Inputs that are pressed rather than typed into: a checkbox ticks, so it stays shielded. */
const PRESSED_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'color', 'file']);

function scopeOf(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.(SCOPE_SELECTOR) ?? null;
}

/** jsdom and older engines dispatch some activations as plain MouseEvents: they share one id. */
function pointerIdOf(e: Event): number {
  const id = (e as PointerEvent).pointerId;
  return typeof id === 'number' ? id : -1;
}

/** A text field ticks nothing, and a press that cannot focus it hands the typing to the single-key shortcuts. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el?.closest) return false;
  if (el.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
  return el instanceof HTMLInputElement && !PRESSED_INPUTS.has(el.type);
}

function shieldScopes(scopes: { root: Element; shielded?: boolean }[]): void {
  const roots: Element[] = [];
  for (const s of scopes) {
    if (s.shielded) continue;
    s.shielded = true;
    roots.push(s.root);
  }
  startShield(roots);
}

/**
 * Swallows pointer activations inside each of `roots` for shieldMs from now,
 * on its own clock. Capture phase on window, so it runs before React's root
 * listeners and dnd-kit's onPointerDown; preventing mousedown also keeps
 * focus where it was. `press` is a pointerdown already under way (the one
 * that interrupted a settle), held like any press the shield swallows.
 */
function startShield(roots: Element[], press?: Event): void {
  if (roots.length === 0) return;
  const now = performance.now();
  if (!shield) {
    shield = { until: new Map(), presses: new Map(), timer: null };
    for (const type of SHIELDED_EVENTS) window.addEventListener(type, onShielded, true);
    for (const type of PRESS_ENDS) window.addEventListener(type, onPressEnd, true);
  }
  for (const root of roots) shield.until.set(root, Math.max(shield.until.get(root) ?? 0, now + SETTLE.shieldMs));
  if (press && !isTextEntry(press.target)) {
    shield.presses.set(pointerIdOf(press), { root: roots[0], began: now, released: null });
  }
  raise();
  reviewShield();
}

/** Whether `root` is shielded now: its own clock is running, or a press that began on it is still out. */
function shields(s: Shield, root: Element, now: number): boolean {
  if ((s.until.get(root) ?? 0) > now) return true;
  for (const p of s.presses.values()) if (p.root === root) return true;
  return false;
}

function onShielded(e: Event): void {
  const s = shield;
  const root = scopeOf(e.target);
  if (!s || !root || !shields(s, root, performance.now())) return;
  // Enter or Space on a focused control is a click with no pointer count:
  // aimed at the focus ring, never at something that moved.
  if (e.type === 'click' && (e as MouseEvent).detail === 0) return;
  if (isTextEntry(e.target)) return;
  if (e.type === 'pointerdown') {
    // Pressed inside the window: its click, whenever it comes, is swallowed too.
    s.presses.set(pointerIdOf(e), { root, began: performance.now(), released: null });
    // Swallowed before the run's own interrupt can hear it; a press still
    // means "stop moving", so a rise still in flight ends here too.
    if (run) finishSettle();
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click' || e.type === 'auxclick') {
    // The click a let-go press was waiting on.
    for (const [id, p] of s.presses) if (p.root === root && p.released !== null) s.presses.delete(id);
    reviewShield();
  }
}

/** A held press let go: its click comes next (a tap's a task later); a cancelled one has none. */
function onPressEnd(e: Event): void {
  const s = shield;
  const id = pointerIdOf(e);
  const p = s?.presses.get(id);
  if (!s || !p) return;
  if (e.type === 'pointercancel') s.presses.delete(id);
  else p.released = performance.now();
  reviewShield();
}

/**
 * Keeps the shield up while any root's own clock runs or a held press has
 * yet to deliver its click, re-armed for whichever ends first. Once none
 * does it drops — the listeners, and the attribute when no run is live.
 */
function reviewShield(): void {
  const s = shield;
  if (!s) return;
  const now = performance.now();
  let next = Infinity;
  for (const [id, p] of s.presses) {
    const due = p.released === null ? p.began + PRESS_CAP_MS : p.released + CLICK_GRACE_MS;
    if (due <= now) s.presses.delete(id);
    else next = Math.min(next, due);
  }
  for (const [root, until] of s.until) {
    if (until <= now) s.until.delete(root);
    else next = Math.min(next, until);
  }
  if (s.timer !== null) clearTimeout(s.timer);
  s.timer = null;
  if (next === Infinity) endShield();
  else s.timer = setTimeout(reviewShield, next - now);
}

function endShield(): void {
  const s = shield;
  if (!s) return;
  shield = null;
  if (s.timer !== null) clearTimeout(s.timer);
  for (const type of SHIELDED_EVENTS) window.removeEventListener(type, onShielded, true);
  for (const type of PRESS_ENDS) window.removeEventListener(type, onPressEnd, true);
  if (!run && typeof document !== 'undefined') document.documentElement.removeAttribute(SETTLING_ATTR);
}
