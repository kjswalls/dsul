import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, createEvent } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import { create } from 'zustand';

/**
 * The settle conductor (lib/settle.ts, instant planner design §9): when the
 * fresh planner lands over the look-only preview, everything that moved
 * glides from where the preview drew it, in place, transform and clip-path
 * only — and where nothing holds the old geometry, a 250ms landing shield
 * swallows the click that was aimed at a preview row.
 *
 * Driven end to end through the real planner store and the real SettleHost:
 * the capture runs inside the landing setState (before React commits), the
 * plan in SettleHost's layout effect. jsdom has no layout and no WAAPI, so
 * both are faked here:
 *
 *  - a tiny block-layout engine behind getBoundingClientRect, steered by
 *    data-h / data-x / data-w / data-top / data-center on the harness's own
 *    elements, scrollTop, and an inline `position: sticky; top` — which also
 *    adds every running fake animation's translate (so "where it is DRAWN"
 *    can be measured mid-glide);
 *  - a fake Animation with pause/play/cancel/currentTime and
 *    effect.getComputedTiming, on the fake clock, which reports `ready` and
 *    `startTime` and waits `startLag` once played before it starts (as a
 *    compositor does), and whose box-shadow fade getComputedStyle reads as
 *    drawn mid-fade;
 *  - requestAnimationFrame under the test's hand: frame() is one frame.
 */

const mode = vi.hoisted(() => ({ value: 'on' as 'on' | 'static' | 'off' }));
vi.mock('@/lib/planner-snapshot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get PREVIEW_MODE() {
      return mode.value;
    },
  };
});

/** When set, the curve moves run on (EASE_MOVE) reads this instead: proves which animations read it. */
const easeMove = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('@/lib/settle-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settle-plan')>();
  return {
    ...actual,
    get EASE_MOVE() {
      return easeMove.value ?? actual.EASE_MOVE;
    },
  };
});

import { SettleHost } from '@/components/shell/settle-host';
import { RowTitleText } from '@/components/primitives/row-title-text';
import { useDragStore } from '@/lib/drag-store';
import { hoveredItem, setHoveredItemRef } from '@/lib/hovered-item';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';
import { SETTLING_ATTR } from '@/lib/settle';
import { settleEpoch } from '@/lib/settle-epoch';
import { EASE_MOVE, EASE_SET_DOWN, EASE_SETTLE, EASE_TYPE, LIFT_SHADOW, SETTLE } from '@/lib/settle-plan';
import { useViewStore } from '@/lib/view-store';

// ── Fake WAAPI ──────────────────────────────────────────────────────────

type Vec = { x: number; y: number };

function parseTranslate(v: unknown): Vec {
  if (typeof v !== 'string') return { x: 0, y: 0 };
  let m = /^translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)$/.exec(v);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  m = /^translateY\((-?[\d.e-]+)px\)$/.exec(v);
  if (m) return { x: 0, y: Number(m[1]) };
  return { x: 0, y: 0 };
}

/** When set, every effect claims to end this late (the runTimeoutMs cap). */
let endTimeOverride: number | null = null;

/**
 * How long a played animation waits for the engine to start it: `composited`
 * for a transform that replaces (what Chromium hands the compositor), `main`
 * for the rest. Chromium starts what was played together at one moment, the
 * compositor's, which a test says by giving both the same lag.
 */
let startLag = { composited: 0, main: 0 };
/** False: an engine that reports neither `ready` nor `startTime`. */
let reportsStart = true;

class FakeAnimation {
  playState: 'running' | 'paused' | 'idle' = 'running';
  /** Its start on the timeline; null while paused, or played and still waiting to start. */
  private started: number | null = null;
  private held = 0;
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private readyNow!: Promise<FakeAnimation>;
  private settle: { resolve: () => void; reject: () => void } | null = null;
  readonly effect: { target: Element; getComputedTiming: () => { endTime: number; progress: number | null } };

  constructor(
    readonly target: HTMLElement,
    readonly keyframes: Keyframe[],
    readonly options: KeyframeAnimationOptions
  ) {
    this.effect = {
      target,
      getComputedTiming: () => ({ endTime: endTimeOverride ?? this.delay + this.duration, progress: this.progress() }),
    };
    this.play();
  }

  get delay(): number {
    return this.options.delay ?? 0;
  }
  get duration(): number {
    return Number(this.options.duration);
  }
  get lag(): number {
    const composited = 'transform' in this.from && (this.options.composite ?? 'replace') === 'replace';
    return composited ? startLag.composited : startLag.main;
  }
  get currentTime(): number {
    return this.playState === 'running' && this.started !== null ? performance.now() - this.started : this.held;
  }
  get cancelled(): boolean {
    return this.playState === 'idle';
  }
  get ready(): Promise<FakeAnimation> | undefined {
    return reportsStart ? this.readyNow : undefined;
  }
  get startTime(): number | null | undefined {
    return reportsStart ? this.started : undefined;
  }
  /** A pending ready, kept until the engine starts it (or it is cancelled first). */
  private pend() {
    if (this.settle) return;
    let settle: { resolve: () => void; reject: () => void } | null = null;
    this.readyNow = new Promise<FakeAnimation>((resolve, reject) => {
      settle = { resolve: () => resolve(this), reject: () => reject(new DOMException('cancelled', 'AbortError')) };
    });
    this.readyNow.catch(() => {}); // handled, as an engine's is
    this.settle = settle;
  }
  private begin() {
    this.waiting = null;
    this.started = performance.now() - this.held;
    this.settle?.resolve();
    this.settle = null;
  }
  pause() {
    this.held = this.currentTime;
    this.started = null;
    if (this.waiting !== null) clearTimeout(this.waiting);
    this.waiting = null;
    this.playState = 'paused';
  }
  play() {
    if (this.playState === 'running' && (this.started !== null || this.waiting !== null)) return;
    this.playState = 'running';
    this.pend();
    if (this.lag > 0) this.waiting = setTimeout(() => this.begin(), this.lag);
    else this.begin();
  }
  cancel() {
    if (this.waiting !== null) clearTimeout(this.waiting);
    this.waiting = null;
    this.started = null;
    this.playState = 'idle';
    this.settle?.reject();
    this.settle = null;
  }
  get from(): Keyframe {
    return this.keyframes[0];
  }
  /**
   * Linear here, eased in a browser. Before its delay, 0 where it fills
   * backwards, else null; after its end, 1 where it fills forwards, else
   * null; null once cancelled.
   */
  progress(): number | null {
    if (this.cancelled) return null;
    const t = this.currentTime;
    const fill = this.options.fill ?? 'none';
    if (t < this.delay) return fill === 'backwards' || fill === 'both' ? 0 : null;
    if (t >= this.delay + this.duration) return fill === 'forwards' || fill === 'both' ? 1 : null;
    return (t - this.delay) / this.duration;
  }
  /** A box-shadow fade's value as drawn now: its keyframes at the ends, tagged with its progress between them. */
  shadow(): string | null {
    const p = this.progress();
    if (p === null || !('boxShadow' in this.from)) return null;
    const to = this.keyframes[this.keyframes.length - 1].boxShadow;
    if (p <= 0) return String(this.from.boxShadow);
    if (p >= 1) return String(to);
    return `${String(this.from.boxShadow)} @ ${p.toFixed(3)}`;
  }
  /** The translate this animation adds right now: fill backwards through the delay, nothing after the end. */
  offset(): Vec {
    const p = this.progress();
    if (p === null || !('transform' in this.from)) return { x: 0, y: 0 };
    const a = parseTranslate(this.keyframes[0].transform);
    const b = parseTranslate(this.keyframes[this.keyframes.length - 1].transform);
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }
}

let animations: FakeAnimation[] = [];
const animsOn = new Map<Element, FakeAnimation[]>();

/** A computed style whose box-shadow reads `value`: what a running fade draws. */
function withShadow(cs: CSSStyleDeclaration, value: string): CSSStyleDeclaration {
  return new Proxy(cs, {
    get(target, prop) {
      if (prop === 'boxShadow') return value;
      if (prop === 'getPropertyValue') return (name: string) => (name === 'box-shadow' ? value : target.getPropertyValue(name));
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function fakeAnimate(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const anim = new FakeAnimation(this, keyframes, options);
  animations.push(anim);
  animsOn.set(this, [...(animsOn.get(this) ?? []), anim]);
  return anim;
}

const live = () => animations.filter((a) => !a.cancelled);
const keyOf = (a: FakeAnimation) => a.target.getAttribute('data-settle-key');
const on = (key: string, list = live()) => list.filter((a) => keyOf(a) === key);
/** A move's glide is `translate(x, y)`; the lift an appear or a rise comes in on is `translateY(…)`. */
const kind = (a: FakeAnimation) =>
  'transform' in a.from ? (String(a.from.transform).startsWith('translateY') ? 'lift' : 'glide') : 'clip';
/** What a keyframe animates: its offset and easing say when and how, not what. */
const animated = (kf: Keyframe) => Object.keys(kf).filter((k) => k !== 'offset' && k !== 'easing');

// ── Fake layout ─────────────────────────────────────────────────────────

const VIEW_W = 1024;
const num = (el: Element, name: string): number | undefined => {
  const v = el.getAttribute(name);
  return v === null ? undefined : Number(v);
};
const hidden = (el: Element) => /display:\s*none/.test(el.getAttribute('style') ?? '');
const inFlow = (el: Element) => !hidden(el) && !el.hasAttribute('data-top');

function heightOf(el: Element): number {
  if (hidden(el)) return 0;
  const h = num(el, 'data-h');
  if (h !== undefined) return h;
  let sum = 0;
  for (const c of el.children) if (inFlow(c)) sum += heightOf(c);
  return sum;
}

function contentTop(parent: Element): number {
  const base = topOf(parent) - parent.scrollTop;
  if (!parent.hasAttribute('data-center')) return base;
  let content = 0;
  for (const c of parent.children) if (inFlow(c)) content += heightOf(c);
  return base + (heightOf(parent) - content) / 2;
}

function topOf(el: Element): number {
  const parent = el.parentElement;
  if (!parent || el === document.body) return 0;
  const abs = num(el, 'data-top');
  if (abs !== undefined) return topOf(parent) + abs;
  let y = contentTop(parent);
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (inFlow(s)) y += heightOf(s);
  // Sticky, top only: held at its scroller's top + `top` once scrolled past it.
  const sticky = /position:\s*sticky;\s*top:\s*(-?[\d.]+)px/.exec(el.getAttribute('style') ?? '');
  if (sticky) {
    let port: Element | null = parent;
    while (port && !/overflow/.test(port.getAttribute('style') ?? '')) port = port.parentElement;
    if (port) y = Math.max(y, topOf(port) + Number(sticky[1]));
  }
  return y;
}

function leftOf(el: Element): number {
  if (!el.parentElement || el === document.body) return 0;
  return leftOf(el.parentElement) + (num(el, 'data-x') ?? 0);
}

function widthOf(el: Element): number {
  if (!el.parentElement || el === document.body) return VIEW_W;
  return num(el, 'data-w') ?? widthOf(el.parentElement) - (num(el, 'data-x') ?? 0);
}

/** Every running animation's translate on the element and its ancestors: where it is DRAWN. */
function drawnOffset(el: Element): Vec {
  let x = 0;
  let y = 0;
  for (let e: Element | null = el; e; e = e.parentElement) {
    for (const a of animsOn.get(e) ?? []) {
      const o = a.offset();
      x += o.x;
      y += o.y;
    }
  }
  return { x, y };
}

let rectCalls: Element[] = [];
let throwNextRect = false;

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

function layoutOf(el: Element): DOMRect {
  if (hidden(el)) return rect(0, 0, 0, 0);
  const o = drawnOffset(el);
  return rect(leftOf(el) + o.x, topOf(el) + o.y, widthOf(el), heightOf(el));
}

function fakeRect(this: HTMLElement): DOMRect {
  rectCalls.push(this);
  if (throwNextRect) {
    throwNextRect = false;
    throw new Error('layout exploded');
  }
  return layoutOf(this);
}

/** The fake text layout a retype measures: CH px per character, from the left of its text node's element. */
const CH = 8;

// ── Frames, microtasks ──────────────────────────────────────────────────

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

/** One frame: 16ms of clock, then every queued rAF callback. */
function frame() {
  act(() => {
    vi.advanceTimersByTime(16);
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(performance.now());
  });
}

/** jsdom delivers MutationObserver records as microtasks. */
async function microtasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A follow-up commit, and the observer records it produces. */
async function commit(fn: () => void) {
  act(fn);
  await microtasks();
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

// ── Harness ─────────────────────────────────────────────────────────────

const U = 'user-a';
const DAY = '2026-10-03';
const SELECTED = new Date('2026-10-03T12:00:00Z');

/**
 * `rail`: a second text node, right of the title (a duration). `railHidden`
 * draws it `display: none`. `done`: data-completed. `sink`: wrapped in a
 * SwipeRow-shaped box, which is what animates on a phone. `bg`, `image`,
 * `shadow` and `fades` (a 150ms transition on the named properties) are the
 * row's own inline style. `plate`: its content drawn on a child surface of
 * that colour (`data-settle-plate`, a schedule block's pane), which casts
 * `plateShadow`.
 */
type Row = Item & {
  h?: number;
  bucket?: string;
  bg?: string;
  image?: string;
  shadow?: string;
  fades?: string;
  plate?: string;
  plateShadow?: string;
  rail?: string;
  railHidden?: boolean;
  done?: boolean;
  sink?: boolean;
  /** The title as the planner draws it: marked `data-row-title`, each emoji in its own span (RowTitleText). */
  titled?: boolean;
};

/** Only what is given: a row with none of it carries no style attribute at all. */
function ownStyle(o: { bg?: string; image?: string; shadow?: string; fades?: string }): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (o.bg) style.backgroundColor = o.bg;
  if (o.image) style.backgroundImage = o.image;
  if (o.shadow) style.boxShadow = o.shadow;
  if (o.fades) {
    style.transitionProperty = o.fades;
    style.transitionDuration = '150ms';
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
const item = (id: string, title = id, extra: Partial<Row> = {}): Row =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [], ...extra }) as Row;

/**
 * Harness-only state: a non-participant band above the groups, a key that
 * remounts the braindump, and a band above the planner outside every scope.
 */
const useHarness = create<{ band: number; tab: string; above: number }>(() => ({ band: 0, tab: 'a', above: 0 }));

const onRowClick = vi.fn();
const onRowMouseDown = vi.fn();
const onOutsideClick = vi.fn();

function groupsOf(items: Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const it of items) {
    const name = it.project ?? 'inbox';
    groups.set(name, [...(groups.get(name) ?? []), it]);
  }
  return [...groups];
}

/** Where a row's text is drawn, across from its left edge: the checkbox stand-in takes 8–24. */
const TITLE_X = 32;
const RAIL_X = 600;

function TaskRow({ it }: { it: Row }) {
  const content = (
    <>
      <span data-top="0" data-x="8" data-w="16" data-h="16" />
      {it.titled ? (
        <span data-top="0" data-x={TITLE_X} data-h="20" data-row-title="open">
          <RowTitleText text={it.title} />
        </span>
      ) : (
        <span data-top="0" data-x={TITLE_X} data-h="20">
          {it.title}
        </span>
      )}
      {it.rail !== undefined && (
        <span data-top="0" data-x={RAIL_X} data-h="20" style={it.railHidden ? { display: 'none' } : undefined}>
          {it.rail}
        </span>
      )}
    </>
  );
  const row = (
    <div
      data-settle-key={`${DAY}|${it.id}`}
      data-item-id={it.id}
      data-h={it.h ?? 40}
      data-completed={it.done ? 'true' : 'false'}
      style={ownStyle(it)}
      onClick={onRowClick}
      onMouseDown={onRowMouseDown}
    >
      {it.plate ? (
        <div
          data-settle-plate=""
          data-testid={`plate-${it.id}`}
          data-h={it.h ?? 40}
          style={ownStyle({ bg: it.plate, shadow: it.plateShadow })}
        >
          {content}
        </div>
      ) : (
        content
      )}
    </div>
  );
  return it.sink ? (
    <div data-sink-row="" data-testid={`sink-${it.id}`} data-h={it.h ?? 40}>
      {row}
    </div>
  ) : (
    row
  );
}

/** The canvas: view-root is `display: contents` under a 600px box (painted, outside the scope), groups are frames. */
function Canvas() {
  const items = usePlannerStore((s) => s.items) as Row[];
  const band = useHarness((s) => s.band);
  return (
    <div data-testid="canvas-box" data-h={600} style={{ backgroundColor: 'rgb(9, 9, 9)' }}>
      <div data-testid="canvas-scope" data-settle-scope="canvas" style={{ display: 'contents' }}>
        {band > 0 && <div data-testid="band" data-h={band} />}
        {groupsOf(items).map(([name, rows]) => (
          <div key={name} data-settle-key={`group:${name}`} data-settle-role="frame">
            {rows.map((it) => (
              <TaskRow key={it.id} it={it} />
            ))}
          </div>
        ))}
      </div>
      <button type="button" data-testid="outside" onClick={onOutsideClick}>
        outside
      </button>
    </div>
  );
}

/** The braindump: the scope is the SECTION; the scroller clips; quick-add is a frame below it. */
function Braindump({ scrollH }: { scrollH?: number }) {
  const items = usePlannerStore((s) => s.items) as Row[];
  const tab = useHarness((s) => s.tab);
  return (
    <section key={tab} data-testid="braindump-scope" data-settle-scope="braindump">
      <div data-testid="scroller" style={{ overflowY: 'auto' }} data-h={scrollH}>
        {items.map((it) => (
          <div key={it.id} data-settle-key={`|${it.id}`} data-item-id={it.id} data-h={30}>
            {it.title}
          </div>
        ))}
      </div>
      <div data-testid="quickadd" data-settle-key="braindump:quickadd" data-settle-role="frame" data-h={36}>
        <input data-testid="quickadd-input" aria-label="Add" />
      </div>
    </section>
  );
}

/**
 * Day × Buckets: each card root is `relative isolate` — a stacking context, as
 * BucketCard's is — and the card body under its 20px caption paints the ground.
 * A row's bucket is `bucket` (morning by default); its key stays `${DAY}|id`.
 *
 * `wrap` reproduces the real nesting: day-buckets.tsx puts each card in its own
 * static div[data-dnd-bucket], the only thing in it, inside a flex column
 * (`flex`). `block` makes the list a plain block, so a wrapper's z-index needs
 * a position; `anchoring` also gives each wrapper an absolutely positioned
 * child, which a position on the wrapper would re-anchor. `cardBg` paints
 * each card root.
 */
function Buckets({ wrap, cardBg }: { wrap?: 'flex' | 'block' | 'anchoring'; cardBg?: string }) {
  const items = usePlannerStore((s) => s.items) as Row[];
  const band = useHarness((s) => s.band);
  const card = (b: string) => (
    <section
      key={b}
      data-testid={`bucket-${b}`}
      data-settle-key={`bucket:${b}`}
      data-settle-role="frame"
      style={{ position: 'relative', isolation: 'isolate', ...(cardBg ? { backgroundColor: cardBg } : null) }}
    >
      <header data-testid={`caption-${b}`} data-h={20}>
        {b}
      </header>
      <div data-testid={`card-${b}`} style={{ backgroundColor: 'rgb(250, 250, 250)' }}>
        {items
          .filter((it) => (it.bucket ?? 'morning') === b)
          .map((it) => (
            <TaskRow key={it.id} it={it} />
          ))}
      </div>
    </section>
  );
  return (
    <div data-testid="buckets-box" data-h={600} style={{ backgroundColor: 'rgb(9, 9, 9)' }}>
      <div data-testid="buckets-scope" data-settle-scope="canvas" style={{ display: 'contents' }}>
        {band > 0 && <div data-h={band} />}
        <div data-testid="bucket-list" style={wrap === 'flex' ? { display: 'flex', flexDirection: 'column' } : undefined}>
          {['morning', 'afternoon'].map((b) =>
            wrap ? (
              <div key={b} data-testid={`wrap-${b}`} data-dnd-bucket={b}>
                {wrap === 'anchoring' && <span data-top="0" data-h="0" style={{ position: 'absolute' }} />}
                {card(b)}
              </div>
            ) : (
              card(b)
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Zen: <main> centres the hero and the ledger, so the hero moves when the ledger changes length. */
function Zen() {
  const items = usePlannerStore((s) => s.items) as Row[];
  const [hero, ...ledger] = items;
  return (
    <div data-testid="zen-scope" data-settle-scope="zen" style={{ overflowY: 'auto' }} data-h={768}>
      <main data-center="" data-h={600}>
        <section data-testid="hero" data-settle-key="zen:hero" data-settle-role="frame" data-h={100}>
          <h1 data-settle-key={hero ? `zen:hero:${hero.id}` : 'zen:hero:none'} data-h={60}>
            {hero?.title}
          </h1>
        </section>
        <div data-settle-key="zen:ledger" data-settle-role="frame" data-h={20}>
          Next
        </div>
        <ul>
          {ledger.map((it) => (
            <li key={it.id} data-settle-key={`zen:${it.id}`} data-h={30}>
              {it.title}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

/** Above the planner and outside every scope: the header row growing, the docked Ask rail recentring the canvas. */
function Above({ children }: { children: ReactNode }) {
  const above = useHarness((s) => s.above);
  return (
    <>
      <div data-testid="above" data-h={above} />
      {children}
    </>
  );
}

function Host({ children }: { children: ReactNode }) {
  return (
    <>
      <SettleHost />
      {children}
    </>
  );
}

const READY = { userId: U, error: null, loadFailedUserId: null, navDirection: null, selectedDate: SELECTED };

/** The cached planner is up, and has reached the screen (SettleHost's two frames). */
function startPreview(ui: ReactNode, cached: Row[]) {
  act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: cached }));
  const view = render(<Host>{ui}</Host>);
  frame();
  frame();
  return view;
}

type PlannerState = ReturnType<typeof usePlannerStore.getState>;

/** The success landing: fresh rows, isPreview and isLoading cleared, in ONE set(). */
function land(fresh: Row[], extra: Partial<PlannerState> = {}) {
  act(() => usePlannerStore.setState({ isLoading: false, isPreview: false, items: fresh, ...extra }));
}

const settling = () => document.documentElement.getAttribute(SETTLING_ATTR);
const row = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;

/** A pointer's click: it carries a click count. Enter or Space on a focused control dispatches detail 0. */
const click = (el: Element) => fireEvent.click(el, { detail: 1 });

/** a b c d → b a e d': two rows swap, c exits, e appears, d changes in place. */
const CACHED = () => [item('a'), item('b'), item('c'), item('d')];
const FRESH = () => [item('b'), item('a'), item('e'), item('d', 'd renamed')];

function reduceMotionOS() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
}

let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  mode.value = 'on';
  easeMove.value = null;
  animations = [];
  animsOn.clear();
  endTimeOverride = null;
  startLag = { composited: 0, main: 0 };
  reportsStart = true;
  rectCalls = [];
  throwNextRect = false;
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(fakeRect);
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = fakeAnimate;
  // A box-shadow fade under way is drawn part-way down, and getComputedStyle says how far, as a browser's would.
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const cs = computed(el, pseudo);
    const fades = animsOn.get(el) ?? [];
    for (let i = fades.length - 1; i >= 0; i -= 1) {
      const drawn = fades[i].shadow();
      if (drawn !== null) return withShadow(cs, drawn);
    }
    return cs;
  });
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onRowClick.mockClear();
  onRowMouseDown.mockClear();
  onOutsideClick.mockClear();
  useHarness.setState({ band: 0, tab: 'a', above: 0 });
  useDragStore.setState({ activeId: null, input: null });
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  usePlannerStore.setState({ ...READY, isLoading: false, isPreview: false, items: [] });
  setHoveredItemRef(null, null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.removeAttribute(SETTLING_ATTR);
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('animation shape', () => {
  it('animates transform and clip-path ONLY — never opacity or filter — fill backwards, moves on EASE_MOVE, the rest on ease-out-soft', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    expect(animations.length).toBeGreaterThan(0);
    for (const a of animations) {
      for (const kf of a.keyframes) {
        for (const prop of animated(kf)) expect(['transform', 'clipPath']).toContain(prop);
      }
      expect(a.options.fill).toBe('backwards');
      const glide = [`${DAY}|a`, `${DAY}|b`].includes(keyOf(a)!);
      expect(a.options.easing).toBe(glide ? EASE_MOVE : EASE_SETTLE);
    }
  });

  it('plays §9.6 exactly: move, appear (clip type-in + 4px lift), retype; exits and still nodes get nothing', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());

    const [moveA] = on(`${DAY}|a`);
    expect(moveA.keyframes).toEqual([{ transform: 'translate(0px, -40px)' }, { transform: 'translate(0px, 0px)' }]);
    // No transform of its own to add to: a replace, which the compositor can run.
    expect(moveA.options).toMatchObject({ duration: 420, delay: 0, composite: 'replace' });
    expect(on(`${DAY}|b`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' });

    const appear = on(`${DAY}|e`);
    expect(appear).toHaveLength(2);
    const clip = appear.find((a) => kind(a) === 'clip')!;
    const lift = appear.find((a) => kind(a) === 'lift')!;
    expect(clip.keyframes).toEqual([{ clipPath: 'inset(-8px 100% -8px -8px)' }, { clipPath: 'inset(-8px)' }]);
    expect(clip.options).toMatchObject({ duration: 380, delay: 100, composite: 'replace' });
    expect(lift.keyframes).toEqual([{ transform: 'translateY(4px)' }, { transform: 'translateY(0px)' }]);
    expect(lift.options).toMatchObject({ duration: 380, delay: 100, composite: 'replace' });

    const [retype] = on(`${DAY}|d`);
    expect(retype.keyframes).toEqual([{ clipPath: 'inset(-8px 100% -8px -8px)' }, { clipPath: 'inset(-8px)' }]);
    expect(retype.options).toMatchObject({ duration: 340, delay: 0, composite: 'replace' });

    expect(on('group:inbox')).toEqual([]);
    expect(animations).toHaveLength(5);
  });

  it('a translate adds to a box’s own transform, and replaces where there is none to add to', () => {
    startPreview(<Canvas />, CACHED());
    row('a').style.transform = 'rotate(1deg)'; // a transform of its own, which a replace would drop for the glide
    land(FRESH());
    expect(on(`${DAY}|a`)[0].options.composite).toBe('add');
    expect(on(`${DAY}|b`)[0].options.composite).toBe('replace');
  });

  it('cascades new rows by rank (capped at 6), unfolds a new frame, and reveals a grown row as it lands', () => {
    startPreview(<Canvas />, [item('a'), item('z')]);
    const news = Array.from({ length: 8 }, (_, i) => item(`n${i}`));
    land([item('a', 'a', { h: 80 }), ...news, item('z'), item('w1', 'w1', { project: 'work' })]);

    const delays = news.map((n) => on(`${DAY}|${n.id}`).find((a) => kind(a) === 'clip')!.options.delay);
    expect(delays).toEqual([100, 124, 148, 172, 196, 220, 244, 244]);

    const frame = on('group:work');
    expect(frame.map((a) => a.keyframes)).toEqual([
      [{ clipPath: 'inset(-8px -8px 100% -8px)' }, { clipPath: 'inset(-8px)' }],
      [{ transform: 'translateY(-3px)' }, { transform: 'translateY(0px)' }],
    ]);
    expect(frame.every((a) => a.options.delay === 80 && a.options.duration === 380)).toBe(true);
    // Its row rides the frame's unfold.
    expect(on(`${DAY}|w1`)).toEqual([]);

    // a grew 40 → 80 in place: the new extent is revealed, nothing translates.
    const grown = on(`${DAY}|a`);
    expect(grown).toHaveLength(1);
    expect(grown[0].keyframes).toEqual([{ clipPath: 'inset(-8px -8px 40px -8px)' }, { clipPath: 'inset(-8px)' }]);
    expect(grown[0].options).toMatchObject({ duration: 420, delay: 0, composite: 'replace' });
  });

  it('a change too broad to follow rises the visible top-level blocks in a short cascade, and shields', () => {
    const old = Array.from({ length: 26 }, (_, i) => item(`o${i}`, `o${i}`, { project: 'old', h: 20 }));
    startPreview(<Canvas />, old);
    land([
      item('x1', 'x1', { project: 'x' }),
      item('y1', 'y1', { project: 'y' }),
      item('z1', 'z1', { project: 'z' }),
    ]);
    const rises = live();
    expect(rises.map((a) => [keyOf(a), a.keyframes[0], a.options.delay, a.options.duration])).toEqual([
      ['group:x', { transform: 'translateY(6px)' }, 0, 320],
      ['group:y', { transform: 'translateY(6px)' }, 24, 320],
      ['group:z', { transform: 'translateY(6px)' }, 48, 320],
    ]);
    // A rise holds nothing where it was: the scope is shielded too.
    click(row('x1'));
    expect(onRowClick).not.toHaveBeenCalled();
    // A press there is swallowed before the run's own interrupt hears it, and still ends the rises.
    fireEvent.pointerDown(row('y1'));
    expect(rises.every((a) => a.cancelled)).toBe(true);
    expect(settling()).toBe('true'); // the shield's
  });

  it('never appends an element outside the scopes — there is no overlay', async () => {
    startPreview(<Canvas />, CACHED());
    const added: Node[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) added.push(...r.addedNodes);
    });
    watch.observe(document.documentElement, { childList: true, subtree: true });
    const bodyChildren = document.body.childElementCount;

    land(FRESH());
    frame();
    frame();
    await commit(() => useHarness.setState({ band: 30 }));
    advance(2000);
    await microtasks();
    watch.disconnect();

    expect(document.body.childElementCount).toBe(bodyChildren);
    const outside = added.filter((n) => {
      const el = n instanceof Element ? n : n.parentElement;
      return !el?.closest('[data-settle-scope]');
    });
    expect(outside).toEqual([]);
  });
});

describe('hold, play, retarget', () => {
  it('holds every animation paused at 0 — the first paint shows the preview — and plays after two quiet frames', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    expect(live().every((a) => a.playState === 'paused' && a.currentTime === 0)).toBe(true);
    frame();
    expect(live().every((a) => a.playState === 'paused')).toBe(true);
    frame();
    expect(live().length).toBeGreaterThan(0);
    expect(live().every((a) => a.playState === 'running')).toBe(true);
  });

  it('re-holds against the same FIRST on a follow-up commit, and plays only once two frames pass quietly', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    const held = live();
    frame();
    // A band grows above the groups mid-hold (the anytime strip's ResizeObserver, a held capture).
    await commit(() => useHarness.setState({ band: 50 }));
    expect(held.every((a) => a.cancelled)).toBe(true);
    const reheld = live();
    expect(reheld.every((a) => a.playState === 'paused')).toBe(true);
    // Re-planned from the ORIGINAL first: the group now glides down from where the preview drew it.
    expect(on('group:inbox')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -50px)' });
    expect(on(`${DAY}|a`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });

    frame(); // the mutation's frame: quiet resets
    frame(); // quiet 1
    expect(reheld.every((a) => a.playState === 'paused')).toBe(true);
    frame(); // quiet 2
    expect(reheld.every((a) => a.playState === 'running')).toBe(true);
  });

  it('plays by frame 8 however busy the commits', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    for (let f = 1; f <= 7; f++) {
      await commit(() => useHarness.setState({ band: f * 10 }));
      frame();
      expect(live().every((a) => a.playState === 'paused')).toBe(true);
    }
    await commit(() => useHarness.setState({ band: 80 }));
    frame();
    expect(live().length).toBeGreaterThan(0);
    expect(live().every((a) => a.playState === 'running')).toBe(true);
  });

  it('gives up the hold if frames starve for holdTimeoutMs: everything rests at its fresh place, shielded', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    const held = live();
    advance(SETTLE.holdTimeoutMs - 1);
    expect(held.some((a) => a.cancelled)).toBe(false);
    advance(1);
    expect(held.every((a) => a.cancelled)).toBe(true);
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('retargets a mid-glide commit from where boxes are DRAWN: glides recreated, clip reveals and lifts kept', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame(); // playing
    const first = live();
    const clips = first.filter((a) => kind(a) === 'clip');
    const glides = first.filter((a) => kind(a) === 'glide');
    const lifts = first.filter((a) => kind(a) === 'lift');
    expect(lifts.map(keyOf)).toEqual([`${DAY}|e`]);
    advance(100);

    // a is drawn 40·(1 − 100/420) above its layout box right now.
    const aDrawn = row('a').getBoundingClientRect().top;
    await commit(() => useHarness.setState({ band: 50 }));

    expect(glides.every((a) => a.cancelled)).toBe(true);
    expect(clips.every((a) => !a.cancelled)).toBe(true);
    expect(lifts.every((a) => !a.cancelled)).toBe(true); // e's lift stays paired with its type-in
    // The group was painted 50px higher than its new layout: it glides down for what is left of a move.
    const [group] = on('group:inbox');
    expect(group.keyframes[0]).toEqual({ transform: 'translate(0px, -50px)' });
    expect(group.options).toMatchObject({ duration: SETTLE.moveMs - 100, delay: 0, composite: 'replace' });
    // a keeps its own offset, net of the group's: no jump at the commit.
    const [a] = on(`${DAY}|a`);
    expect(parseTranslate(a.keyframes[0].transform).y).toBeCloseTo(-40 * (1 - 100 / 420), 5);
    expect(row('a').getBoundingClientRect().top).toBeCloseTo(aDrawn, 5);
    // The reveals already running are untouched; nothing new is created for them.
    expect(on(`${DAY}|d`).filter((x) => kind(x) === 'clip')).toEqual(clips.filter((x) => keyOf(x) === `${DAY}|d`));
  });

  it('never re-aims shorter than retargetMinMs, types in a box new since the landing at once, and stops after 2', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    advance(300);

    await commit(() => useHarness.setState({ band: 20 })); // retarget 1
    expect(on('group:inbox')[0].options.duration).toBe(SETTLE.retargetMinMs);

    await commit(() => usePlannerStore.setState({ items: [...FRESH(), item('late')] })); // retarget 2
    const late = on(`${DAY}|late`);
    expect(late.map((a) => a.options.delay)).toEqual([0, 0]);
    expect(late.map(kind).sort()).toEqual(['clip', 'lift']);

    await commit(() => useHarness.setState({ band: 40 })); // past maxRetargets: the scope snaps
    expect(live()).toEqual([]);
    expect(settling()).toBe('true'); // shielded where it snapped
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('vetoes', () => {
  const vetoes: [string, () => void][] = [
    ['the OS reduced-motion preference', reduceMotionOS],
    ['the in-app animations toggle (data-reduce-motion)', () => document.documentElement.setAttribute('data-reduce-motion', 'true')],
    ['an active drag', () => useDragStore.setState({ activeId: 'x' })],
    ['a nav slide in flight', () => usePlannerStore.setState({ navDirection: 'left' })],
    ['the Zen wave in flight', () => useViewStore.setState({ zenMoving: true })],
    ['static mode', () => (mode.value = 'static')],
    ['no element.animate', () => delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate],
  ];

  it.each(vetoes)('no animation under %s — the swap is instant and the landing shield takes the click', (_, veto) => {
    startPreview(<Canvas />, CACHED());
    act(veto);
    const spy = vi.fn();
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    if (proto.animate) proto.animate = spy;
    land(FRESH());
    expect(spy).not.toHaveBeenCalled();
    expect(animations).toEqual([]);
    expect(settling()).toBe('true');
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('a hidden tab captures nothing at all: no animation, no shield', () => {
    startPreview(<Canvas />, CACHED());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    land(FRESH());
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
  });

  it('is asked again at play: a veto that lands mid-hold snaps and shields', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    const held = live();
    frame();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    frame();
    expect(held.every((a) => a.cancelled)).toBe(true);
    expect(settling()).toBe('true');
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('interrupts', () => {
  async function playing() {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    const running = live();
    expect(running.length).toBeGreaterThan(0);
    return running;
  }

  it('a pointerdown inside a scope cancels everything, and its click is swallowed for shieldMs', async () => {
    const running = await playing();
    fireEvent.pointerDown(row('a'));
    expect(running.every((a) => a.cancelled)).toBe(true);
    fireEvent.pointerUp(row('a'));
    click(row('a')); // that press's own click
    click(row('d'));
    expect(onRowClick).not.toHaveBeenCalled();
    advance(SETTLE.shieldMs);
    click(row('d'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(settling()).toBeNull();
  });

  it('a pointerdown outside every scope cancels without shielding', async () => {
    const running = await playing();
    fireEvent.pointerDown(document.body);
    expect(running.every((a) => a.cancelled)).toBe(true);
    expect(settling()).toBeNull();
    click(row('a'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  const interrupts: [string, () => void][] = [
    ['keydown', () => fireEvent.keyDown(document.body, { key: 'j' })],
    ['resize', () => window.dispatchEvent(new Event('resize'))],
    [
      'the tab going hidden',
      () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      },
    ],
    ['a drag starting', () => useDragStore.setState({ activeId: 'a' })],
    ['Zen opening', () => useViewStore.setState({ zenOpen: true })],
    ['the Zen wave starting', () => useViewStore.setState({ zenMoving: true })],
    ['a nav slide', () => usePlannerStore.setState({ navDirection: 'right' })],
    ['another day selected', () => usePlannerStore.setState({ selectedDate: new Date('2026-10-04T12:00:00Z') })],
  ];

  it.each(interrupts)('%s cancels every animation and ends the run', async (_, interrupt) => {
    const running = await playing();
    act(interrupt);
    expect(running.every((a) => a.cancelled)).toBe(true);
    expect(settling()).toBeNull();
  });

  it('scroll and wheel are NOT interrupts — every animation is relative to its own box', async () => {
    const running = await playing();
    fireEvent.scroll(window);
    fireEvent.scroll(row('a'));
    fireEvent.wheel(row('a'));
    expect(running.every((a) => !a.cancelled && a.playState === 'running')).toBe(true);
    expect(settling()).toBe('true');
  });

  it('a selectedDate re-set to the same instant is not a change', async () => {
    const running = await playing();
    act(() => usePlannerStore.setState({ selectedDate: new Date(SELECTED.getTime()) }));
    expect(running.every((a) => !a.cancelled)).toBe(true);
  });
});

describe('the landing shield', () => {
  it('under reduced motion, swallows every pointer activation inside a changed scope for 250ms, then lets them through', () => {
    startPreview(<Canvas />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(FRESH());
    expect(animations).toEqual([]);
    expect(settling()).toBe('true');

    const target = row('a');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'auxclick']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 });
      target.dispatchEvent(ev);
      if (type !== 'pointerup') expect(ev.defaultPrevented, type).toBe(true);
    }
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowMouseDown).not.toHaveBeenCalled();

    // Keyboard is untouched.
    const key = createEvent.keyDown(target, { key: 'Enter' });
    fireEvent(target, key);
    expect(key.defaultPrevented).toBe(false);

    advance(SETTLE.shieldMs - 1);
    click(target);
    expect(onRowClick).not.toHaveBeenCalled();
    advance(1);
    click(target);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(settling()).toBeNull();
  });

  it('lets clicks outside the scopes through while it is up', () => {
    startPreview(<Canvas />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(FRESH());
    click(document.querySelector('[data-testid="outside"]')!);
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('a landing that changed nothing animates nothing, raises no attribute and shields nothing', () => {
    startPreview(<Canvas />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(CACHED());
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
    click(row('a'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('a fine scope that is animating is NOT shielded: its rows are drawn where the eye aims', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    click(row('a'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle', () => {
  it('raises html[data-planner-settling] at landing and drops it when the last animation ends', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    expect(settling()).toBe('true');
    frame();
    frame(); // playing; the latest end is e's reveal, 100 + 380
    advance(100 + 380 + 50 - 1);
    expect(settling()).toBe('true');
    advance(1);
    expect(settling()).toBeNull();
    expect(live()).toEqual([]); // cancelled: nothing rests on a transform or a clip
  });

  it('never outlives runTimeoutMs from the landing', () => {
    endTimeOverride = 10_000;
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    advance(SETTLE.runTimeoutMs - 32 - 1);
    expect(settling()).toBe('true');
    advance(1);
    expect(settling()).toBeNull();
    expect(live()).toEqual([]);
  });

  it('clears the hovered-row ref at landing: the rows moved under a still pointer', () => {
    startPreview(<Canvas />, CACHED());
    setHoveredItemRef('a', 'task');
    land(FRESH());
    expect(hoveredItem).toEqual({ id: null, type: null });
  });

  it('drops a scope that remounted under the landing (a mobile tab switch); the others still settle', () => {
    startPreview(
      <>
        <Canvas />
        <Braindump />
      </>,
      CACHED()
    );
    act(() => {
      useHarness.setState({ tab: 'b' });
      usePlannerStore.setState({ isLoading: false, isPreview: false, items: FRESH() });
    });
    const braindump = document.querySelector('[data-testid="braindump-scope"]')!;
    expect(animations.some((a) => braindump.contains(a.target))).toBe(false);
    expect(on(`${DAY}|a`)).toHaveLength(1);
  });

  it('a failed load and a crash drop end the preview with nothing captured — but the sink-hold epoch still moves', () => {
    startPreview(<Canvas />, CACHED());
    let epoch = settleEpoch();
    act(() =>
      usePlannerStore.setState({ isLoading: false, isPreview: false, items: [], error: 'offline', loadFailedUserId: U })
    );
    expect(settleEpoch()).toBe(epoch + 1);
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();

    act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: CACHED() }));
    frame();
    frame();
    epoch = settleEpoch();
    act(() => usePlannerStore.setState({ isPreview: false, items: [] })); // dropPreview: still loading
    expect(settleEpoch()).toBe(epoch + 1);
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
  });

  it('a landing for another account, or before the preview painted, captures nothing', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH(), { userId: 'user-b' });
    expect(animations).toEqual([]);
    cleanup();

    act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: CACHED() }));
    render(
      <Host>
        <Canvas />
      </Host>
    );
    frame(); // one frame: not on screen yet
    land(FRESH());
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
  });

  it('a throw in capture never escapes the landing set()', () => {
    startPreview(<Canvas />, CACHED());
    throwNextRect = true;
    expect(() => land(FRESH())).not.toThrow();
    expect(usePlannerStore.getState().isPreview).toBe(false);
    expect(usePlannerStore.getState().items.map((i) => i.id)).toEqual(['b', 'a', 'e', 'd']);
    expect(consoleWarn).toHaveBeenCalledWith('[settle] capture skipped', expect.any(Error));
    expect(animations).toEqual([]);
  });

  it('subscribes to the planner store only while a SettleHost is mounted', () => {
    const edge = () => {
      act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true }));
      act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
    };
    let epoch = settleEpoch();
    edge();
    expect(settleEpoch()).toBe(epoch); // importing the module subscribed to nothing

    const one = render(<SettleHost />);
    const two = render(<SettleHost />);
    edge();
    expect(settleEpoch()).toBe(epoch + 1);

    one.unmount();
    epoch = settleEpoch();
    edge();
    expect(settleEpoch()).toBe(epoch + 1); // the second host still holds it

    two.unmount();
    epoch = settleEpoch();
    edge();
    expect(settleEpoch()).toBe(epoch);
  });
});

describe('scale', () => {
  it('measures an 800-row braindump (not skipped) at one rect read per participant per side, and animates only what is on screen', () => {
    const rows = Array.from({ length: 800 }, (_, i) => item(`r${i}`));
    startPreview(<Braindump scrollH={300} />, rows);
    const participants = () => document.querySelectorAll('[data-settle-key]').length;
    const before = participants();
    rectCalls = [];

    land([item('new'), ...rows]);
    const after = participants();
    expect(before).toBe(801);
    expect(after).toBe(802);

    const perElement = new Map<Element, number>();
    for (const el of rectCalls) perElement.set(el, (perElement.get(el) ?? 0) + 1);
    for (const el of document.querySelectorAll('[data-settle-key]')) expect(perElement.get(el) ?? 0).toBeLessThanOrEqual(2);
    // Beyond the participants: each pass reads the scope's box and its one clipping scroller.
    const clipReads = rectCalls.filter((el) => !el.hasAttribute('data-settle-key')).length;
    expect(clipReads).toBe(4);
    expect(rectCalls.length).toBe(before + after + clipReads);

    // 30px rows in a 300px port: ten were on screen. They glide down; the new one types in.
    const animated = new Set(animations.map((a) => a.target));
    const scroller = document.querySelector('[data-testid="scroller"]')!;
    const index = [...animated].map((el) => [...scroller.children].indexOf(el)).sort((x, y) => x - y);
    expect(index).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(on('|r0')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -30px)' });
    expect(on('|new').map(kind).sort()).toEqual(['clip', 'lift']);
  });
});

describe('frames that move with their rows', () => {
  it('braindump: an appended row moves the quick-add card down with a glide', () => {
    startPreview(<Braindump />, [item('a'), item('b'), item('c')]);
    land([item('a'), item('b'), item('c'), item('d')]);
    const quickadd = live().filter((a) => a.target.getAttribute('data-testid') === 'quickadd');
    expect(quickadd).toHaveLength(1);
    expect(quickadd[0].keyframes).toEqual([{ transform: 'translate(0px, -30px)' }, { transform: 'translate(0px, 0px)' }]);
    expect(on('|d').map(kind).sort()).toEqual(['clip', 'lift']);
  });

  it('zen: a ledger row removed elsewhere re-centres the hero with a glide, and its title rides along', () => {
    startPreview(<Zen />, [item('h'), item('l1'), item('l2'), item('l3'), item('l4')]);
    land([item('h'), item('l1'), item('l3'), item('l4')]);
    const hero = on('zen:hero');
    expect(hero).toHaveLength(1);
    expect(hero[0].keyframes[0]).toEqual({ transform: 'translate(0px, -15px)' });
    expect(on('zen:hero:h')).toEqual([]);
    expect(on('zen:ledger')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -15px)' });
    // Below the gap the rows close it: net of nothing (no frame parent), +15.
    expect(on('zen:l3')[0].keyframes[0]).toEqual({ transform: 'translate(0px, 15px)' });
  });
});

// ── Review fixes ────────────────────────────────────────────────────────

/** Fresh rows have landed and two quiet frames have passed: everything is gliding. */
function playingCanvas() {
  startPreview(<Canvas />, CACHED());
  land(FRESH());
  frame();
  frame();
  const running = live();
  expect(running.length).toBeGreaterThan(0);
  return running;
}

describe('a mutation that moves nothing is not a commit', () => {
  it("a hover's --title-mask, a scrollbar mounting and its <style> neither re-aim nor spend a retarget", async () => {
    const running = playingCanvas();
    const created = animations.length;
    advance(60);
    // TaskRow's mouseenter → measureTitle → style.setProperty('--title-mask', …), on three rows.
    for (const id of ['b', 'a', 'e']) await commit(() => row(id).style.setProperty('--title-mask', 'none'));
    // The ScrollArea mounts its scrollbar (absolutely placed) and re-sets its <style>.
    const scope = document.querySelector('[data-testid="canvas-scope"]')!;
    const style = document.createElement('style');
    await commit(() => {
      const bar = document.createElement('div');
      bar.setAttribute('data-top', '0');
      bar.setAttribute('data-h', '600');
      scope.append(bar, style);
      style.textContent = '[data-radix-scroll-area-viewport]{scrollbar-width:none}';
    });
    await commit(() => (style.textContent += ' '));

    expect(animations).toHaveLength(created);
    expect(running.every((a) => !a.cancelled && a.playState === 'running')).toBe(true);
    // Nothing snapped, so nothing is shielded: the row is drawn where the eye aims.
    click(row('a'));
    expect(onRowClick).toHaveBeenCalledTimes(1);

    // The retarget budget is untouched: two real commits still re-aim rather than snap.
    await commit(() => useHarness.setState({ band: 20 }));
    await commit(() => useHarness.setState({ band: 40 }));
    // Both bands landed in the same instant, so the second re-aims from the first's whole offset.
    expect(on('group:inbox')).toHaveLength(1);
    expect(on('group:inbox')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });
  });

  it('mid-hold, a hover write neither re-holds nor holds the play back', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    const held = live();
    frame();
    await commit(() => row('a').style.setProperty('--title-mask', 'none'));
    frame(); // the second quiet frame: plays on time
    expect(held.every((a) => !a.cancelled && a.playState === 'running')).toBe(true);
  });

  it('mid-hold, a row whose text changed in place is still a commit: it re-holds with a retype', async () => {
    startPreview(<Canvas />, CACHED());
    land(CACHED()); // nothing changed: the run only watches
    expect(animations).toEqual([]);
    await commit(() => usePlannerStore.setState({ items: [item('a'), item('b'), item('c', 'c renamed'), item('d')] }));
    expect(on(`${DAY}|c`).map((a) => a.keyframes[0])).toEqual([{ clipPath: 'inset(-8px 100% -8px -8px)' }]);
  });
});

describe('scrolling while it settles', () => {
  it('a scroll then a no-layout mutation leaves everything where the scroll put it (no jump back)', async () => {
    startPreview(<Braindump scrollH={300} />, [item('a'), item('b'), item('c')]);
    land([item('b'), item('a'), item('c')]);
    frame();
    frame();
    advance(100);
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    const c = row('c').getBoundingClientRect().top;
    const a = row('a').getBoundingClientRect().top;
    scroller.scrollTop = 50; // a wheel: no DOM mutation
    const created = animations.length;

    await commit(() => row('c').style.setProperty('--title-mask', 'none'));
    expect(animations).toHaveLength(created);
    expect(on('|c')).toEqual([]);
    expect(row('c').getBoundingClientRect().top).toBeCloseTo(c - 50, 5);
    expect(row('a').getBoundingClientRect().top).toBeCloseTo(a - 50, 5);
  });

  it('a real commit after a scroll re-aims from where the boxes are drawn, scrolled', async () => {
    startPreview(<Braindump scrollH={300} />, [item('a'), item('b'), item('c')]);
    land([item('b'), item('a'), item('c')]);
    frame();
    frame();
    advance(100);
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    scroller.scrollTop = 20;
    const drawn = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, row(id).getBoundingClientRect().top]));

    await commit(() => usePlannerStore.setState({ items: [item('z'), item('b'), item('a'), item('c')] }));
    for (const id of ['a', 'b', 'c']) expect(row(id).getBoundingClientRect().top, id).toBeCloseTo(drawn[id], 5);
    expect(on('|z').map(kind).sort()).toEqual(['clip', 'lift']);
  });

  it('a sticky head holds its axis: what is pinned is neither taken to have moved nor re-aimed', async () => {
    // A week column: the pinned head (Anytime) stays put while the hour grid scrolls under it.
    function Week() {
      const items = usePlannerStore((s) => s.items) as Row[];
      const [pinned, ...grid] = items;
      return (
        <div data-testid="week-scope" data-settle-scope="canvas" style={{ overflowY: 'auto' }} data-h={400}>
          <div style={{ position: 'sticky', top: 0 }} data-h={40}>
            <div data-settle-key={`${DAY}|${pinned.id}`} data-item-id={pinned.id} data-h={40}>
              {pinned.title}
            </div>
          </div>
          <div data-settle-key="grid" data-settle-role="frame">
            {grid.map((it) => (
              <TaskRow key={it.id} it={it} />
            ))}
          </div>
        </div>
      );
    }
    startPreview(<Week />, [item('p'), item('g1'), item('g2')]);
    land([item('p'), item('g2'), item('g1')]);
    frame();
    frame();
    advance(100);
    document.querySelector<HTMLElement>('[data-testid="week-scope"]')!.scrollTop = 30;
    const pinned = row('p').getBoundingClientRect().top;
    const g1 = row('g1').getBoundingClientRect().top;
    const created = animations.length;

    await commit(() => row('p').style.setProperty('--title-mask', 'none'));
    expect(animations).toHaveLength(created);

    await commit(() => usePlannerStore.setState({ items: [item('p'), item('g2'), item('g1'), item('g3')] }));
    expect(on(`${DAY}|p`)).toEqual([]);
    expect(row('p').getBoundingClientRect().top).toBe(pinned);
    expect(row('g1').getBoundingClientRect().top).toBeCloseTo(g1, 5);
  });
});

describe('the shield holds a press, not a moment', () => {
  function shieldedLanding() {
    startPreview(<Canvas />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(FRESH());
    expect(settling()).toBe('true');
  }

  it('a press that began inside the window keeps its scope shielded until its click has passed', () => {
    shieldedLanding();
    advance(200);
    fireEvent.pointerDown(row('a'));
    advance(100); // the window's own 250ms are over; the press is not
    fireEvent.pointerUp(row('a'));
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(settling()).toBeNull();
    click(row('a')); // the next press is the user's own
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('frees its scope a short grace after a let-go whose click never comes, or 2s after a press never let go', () => {
    shieldedLanding();
    advance(200);
    fireEvent.pointerDown(row('a'));
    advance(100);
    fireEvent.pointerUp(document.body); // dragged off: no click on the row
    advance(99);
    expect(settling()).toBe('true');
    advance(1);
    expect(settling()).toBeNull();

    cleanup();
    shieldedLanding();
    fireEvent.pointerDown(row('a')); // focus lost mid-press: no pointerup ever
    advance(1999);
    expect(settling()).toBe('true');
    advance(1);
    expect(settling()).toBeNull();
  });

  it('each scope keeps its own clock: a press elsewhere never stretches the canvas shield', () => {
    const old = Array.from({ length: 26 }, (_, i) => item(`o${i}`, `o${i}`, { project: 'old', h: 20 }));
    startPreview(
      <>
        <Canvas />
        <Braindump scrollH={300} />
      </>,
      old
    );
    // The canvas is large (shielded now); the braindump glides.
    land([item('x1', 'x1', { project: 'x' }), item('y1', 'y1', { project: 'y' }), item('z1', 'z1', { project: 'z' })]);
    frame();
    frame();
    advance(150);
    const braindumpRow = document.querySelector('[data-testid="braindump-scope"] [data-item-id="x1"]')!;
    fireEvent.pointerDown(braindumpRow); // interrupts the braindump's glide: it is shielded from here
    fireEvent.pointerUp(braindumpRow);
    click(braindumpRow);
    advance(70); // 252ms after the landing: the canvas's 250 are over
    click(row('x1'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('lets a keyboard click through — Enter or Space on a focused control has no pointer count', () => {
    shieldedLanding();
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(row('a'), { detail: 0 });
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('lets a text field take its press: it ticks nothing, and must keep the typing from the shortcuts', () => {
    startPreview(<Braindump />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(FRESH());
    expect(settling()).toBe('true');
    const input = document.querySelector('[data-testid="quickadd-input"]')!;
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 });
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented, type).toBe(false);
    }
    const onRow = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
    row('a').dispatchEvent(onRow);
    expect(onRow.defaultPrevented).toBe(true);
  });
});

describe('an interrupting press shields only a scope that was moving', () => {
  it('a press in a scope the landing left alone cancels the settle and shields nothing there', () => {
    // Only the grouping changes: the canvas moves, the braindump (same rows, same order) does not.
    startPreview(
      <>
        <Canvas />
        <Braindump />
      </>,
      [item('a'), item('b', 'b', { project: 'work' })]
    );
    land([item('a', 'a', { project: 'work' }), item('b', 'b', { project: 'work' })]);
    frame();
    frame();
    const running = live();
    expect(running.length).toBeGreaterThan(0);
    const braindump = document.querySelector('[data-testid="braindump-scope"]')!;
    expect(running.some((a) => braindump.contains(a.target))).toBe(false);

    const target = braindump.querySelector('[data-item-id="a"]')!;
    fireEvent.pointerDown(target);
    expect(running.every((a) => a.cancelled)).toBe(true);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false); // focus moves as it should
    expect(settling()).toBeNull();
  });
});

describe('a landing that changed nothing still watches its follow-ups', () => {
  it("settles the held capture's commit that lands right after it", async () => {
    startPreview(<Canvas />, CACHED());
    land(CACHED());
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
    // held-captures releases its addTask in a microtask after the landing's commit.
    await commit(() => usePlannerStore.setState({ items: [...CACHED(), item('late')] }));
    expect(on(`${DAY}|late`).map(kind).sort()).toEqual(['clip', 'lift']);
    expect(live().every((a) => a.playState === 'paused')).toBe(true);
    expect(settling()).toBe('true');
    frame();
    frame();
    frame();
    expect(live().every((a) => a.playState === 'running')).toBe(true);
  });

  it("under reduced motion, shields what the follow-up moved", async () => {
    startPreview(<Canvas />, CACHED());
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land(CACHED());
    expect(settling()).toBeNull();
    await commit(() => usePlannerStore.setState({ items: [item('first'), ...CACHED()] }));
    expect(animations).toEqual([]);
    expect(settling()).toBe('true');
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
    advance(SETTLE.shieldMs);
    click(row('a'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('with no follow-up, ends after two quiet frames having raised nothing', async () => {
    startPreview(<Canvas />, CACHED());
    land(CACHED());
    frame();
    frame();
    await commit(() => usePlannerStore.setState({ items: [item('first'), ...CACHED()] }));
    expect(animations).toEqual([]);
    expect(settling()).toBeNull();
  });
});

describe('a veto that lands mid-play', () => {
  it('stops a commit from re-aiming anything: the run snaps and shields', async () => {
    const running = playingCanvas();
    const created = animations.length;
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    await commit(() => useHarness.setState({ band: 30 }));
    expect(animations).toHaveLength(created);
    expect(running.every((a) => a.cancelled)).toBe(true);
    expect(settling()).toBe('true');
    click(row('a'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('a frame that grew', () => {
  it('uncovers its new height on its rows’ curve — only the bottom edge cuts', () => {
    startPreview(<Canvas />, [item('a'), item('w1', 'w1', { project: 'work' })]);
    land([item('a'), item('n'), item('w1', 'w1', { project: 'work' })]);
    const reveal = on('group:inbox');
    expect(reveal).toHaveLength(1);
    expect(reveal[0].keyframes).toEqual([
      { clipPath: 'inset(-10000px -10000px 40px -10000px)' },
      { clipPath: 'inset(-10000px -10000px -8px -10000px)' },
    ]);
    expect(reveal[0].options).toMatchObject({ duration: SETTLE.moveMs, delay: 0, composite: 'replace' });
    expect(on('group:work').map((a) => a.keyframes[0])).toEqual([{ transform: 'translate(0px, -40px)' }]);
  });

  it('reveals nothing when a row glides into it from below: the clip would hide it in transit', () => {
    startPreview(<Canvas />, [item('a'), item('w1', 'w1', { project: 'work' }), item('w2', 'w2', { project: 'work' })]);
    land([item('a'), item('w2'), item('w1', 'w1', { project: 'work' })]);
    expect(on('group:inbox')).toEqual([]);
    expect(on(`${DAY}|w2`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' });
  });
});

// ── The move curve ──────────────────────────────────────────────────────

describe('moves run on EASE_MOVE; appears, retypes and rises on EASE_SETTLE', () => {
  beforeEach(() => {
    easeMove.value = 'linear';
  });

  it('the glide is EASE_MOVE; the type-in, its lift and the retype stay on ease-out-soft', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    expect(on(`${DAY}|a`).map((a) => a.options.easing)).toEqual(['linear']);
    expect(on(`${DAY}|b`).map((a) => a.options.easing)).toEqual(['linear']);
    expect(on(`${DAY}|e`).map((a) => a.options.easing)).toEqual([EASE_SETTLE, EASE_SETTLE]);
    expect(on(`${DAY}|d`).map((a) => a.options.easing)).toEqual([EASE_SETTLE]);
  });

  it('the clip reveals that ride a move share its curve: a row that grew, a frame that grew', () => {
    startPreview(<Canvas />, [item('a'), item('w1', 'w1', { project: 'work' })]);
    land([item('a', 'a', { h: 80 }), item('n'), item('w1', 'w1', { project: 'work' })]);
    expect(on(`${DAY}|a`).map((a) => [kind(a), a.options.easing])).toEqual([['clip', 'linear']]);
    expect(on('group:inbox').map((a) => [kind(a), a.options.easing])).toEqual([['clip', 'linear']]);
    expect(on('group:work').map((a) => [kind(a), a.options.easing])).toEqual([['glide', 'linear']]);
  });

  it('a retarget re-aims on EASE_MOVE too', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    advance(100);
    await commit(() => useHarness.setState({ band: 50 }));
    expect(on('group:inbox').map((a) => a.options.easing)).toEqual(['linear']);
    expect(on(`${DAY}|a`).map((a) => a.options.easing)).toEqual(['linear']);
  });

  it('a rise stays on ease-out-soft', () => {
    const old = Array.from({ length: 26 }, (_, i) => item(`o${i}`, `o${i}`, { project: 'old', h: 20 }));
    startPreview(<Canvas />, old);
    land([item('x1', 'x1', { project: 'x' }), item('y1', 'y1', { project: 'y' })]);
    expect(live().map((a) => a.options.easing)).toEqual([EASE_SETTLE, EASE_SETTLE]);
    expect(EASE_MOVE).toBe('linear'); // the mock is live, so the rise really did not read it
  });
});

// ── Stacking: raises and lifts ──────────────────────────────────────────

/** Every inline style the harness's named elements carry now, by testid or item id (SettleHost's own status aside). */
function inlineStyles(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const el of document.querySelectorAll('[data-testid]:not([role="status"]), [data-item-id]')) {
    out[el.getAttribute('data-testid') ?? el.getAttribute('data-item-id')!] = el.getAttribute('style');
  }
  return out;
}

const props = (style: string | null): Record<string, string> =>
  Object.fromEntries(
    (style ?? '')
      .split(';')
      .map((d) => d.split(':').map((x) => x.trim()))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, v.join(':')])
  );

/** Which inline properties differ from a snapshot, anywhere in it. */
function changedProps(before: Record<string, string | null>): Set<string> {
  const now = inlineStyles();
  const changed = new Set<string>();
  for (const id of new Set([...Object.keys(before), ...Object.keys(now)])) {
    const a = props(before[id] ?? null);
    const b = props(now[id] ?? null);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) changed.add(k);
  }
  return changed;
}

const bucket = (b: string) => document.querySelector<HTMLElement>(`[data-testid="bucket-${b}"]`)!;
const PAINTED = 'rgb(250, 250, 250)';

/** m1 m2 | a1 a2 → m1 m2 a2 | a1: a2 is retimed into Morning, 60px up, out from behind the Afternoon card. */
const INTO_MORNING = {
  cached: () => [item('m1'), item('m2'), item('a1', 'a1', { bucket: 'afternoon' }), item('a2', 'a2', { bucket: 'afternoon' })],
  fresh: () => [item('m1'), item('m2'), item('a2'), item('a1', 'a1', { bucket: 'afternoon' })],
};

function intoMorning() {
  startPreview(<Buckets />, INTO_MORNING.cached());
  const before = inlineStyles();
  land(INTO_MORNING.fresh());
  return before;
}

describe('a row that glides out from behind a later stacking context', () => {
  it('raises the context it moved into above its siblings, for the run, and puts back exactly what was there', () => {
    const before = intoMorning();
    expect(before['bucket-morning']).toBe('position: relative; isolation: isolate;');
    expect(on(`${DAY}|a2`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 60px)' });

    // Morning (static z) now stacks over Afternoon; nothing else moved stacking.
    expect(bucket('morning').style.zIndex).toBe('1');
    expect(bucket('morning').style.position).toBe('relative'); // already positioned: untouched
    expect(bucket('afternoon').style.zIndex).toBe('');
    expect(document.querySelector<HTMLElement>('[data-testid="bucket-list"]')!.getAttribute('style')).toBeNull();
    // Only stacking is written, never opacity, filter or a transform, and no keyframe animates anything else.
    expect([...changedProps(before)].sort()).toEqual(['background-clip', 'background-color', 'box-shadow', 'position', 'z-index']);
    for (const a of animations) for (const kf of a.keyframes) for (const p of animated(kf)) expect(['transform', 'clipPath']).toContain(p);

    frame();
    frame(); // playing
    advance(200);
    expect(bucket('morning').style.zIndex).toBe('1');
    advance(SETTLE.moveMs + 50 - 200);
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
    expect(row('a2').hasAttribute('style')).toBe(false); // a style attribute the run created comes off again
  });

  it('puts it back the moment an interrupt ends the run', () => {
    const before = intoMorning();
    frame();
    frame();
    advance(100);
    expect(bucket('morning').style.zIndex).toBe('1');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'j' });
    });
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('puts it back when the host unmounts mid-run', () => {
    // One root, so the landing commits the host and the rows together; the host alone goes away.
    const useHost = create(() => ({ on: true }));
    const MaybeHost = () => (useHost((s) => s.on) ? <SettleHost /> : null);
    act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: INTO_MORNING.cached() }));
    render(
      <>
        <MaybeHost />
        <Buckets />
      </>
    );
    frame();
    frame();
    const before = inlineStyles();
    land(INTO_MORNING.fresh());
    expect(bucket('morning').style.zIndex).toBe('1');
    frame();
    frame();
    advance(100);
    expect(bucket('morning').style.zIndex).toBe('1');
    act(() => useHost.setState({ on: false }));
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('keeps it through a retarget, and puts it back when the scope snaps past maxRetargets', async () => {
    const before = intoMorning();
    frame();
    frame();
    advance(300);
    // a2 has ~17px left: re-aimed, it no longer crosses a row's height, but it still overlaps m2 — it keeps its lift.
    await commit(() => useHarness.setState({ band: 20 })); // retarget 1
    expect(Math.abs(parseTranslate(on(`${DAY}|a2`)[0].keyframes[0].transform).y)).toBeLessThan(40);
    expect(bucket('morning').style.zIndex).toBe('1');
    expect(row('a2').style.zIndex).toBe('1');
    expect(row('a2').style.backgroundColor).toBe(PAINTED);
    await commit(() => useHarness.setState({ band: 40 })); // retarget 2
    expect(bucket('morning').style.zIndex).toBe('1');
    await commit(() => useHarness.setState({ band: 60 })); // the scope snaps
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('a scope that snaps puts back its own stacking while another scope plays on', async () => {
    startPreview(
      <>
        <Buckets />
        <Braindump />
      </>,
      INTO_MORNING.cached()
    );
    const before = inlineStyles();
    land(INTO_MORNING.fresh()); // the braindump swaps a1 and a2 as well
    frame();
    frame();
    advance(100);
    const braindump = document.querySelector('[data-testid="braindump-scope"]')!;
    const glides = live().filter((a) => braindump.contains(a.target));
    expect(glides.length).toBeGreaterThan(0);
    for (const band of [20, 40, 60]) await commit(() => useHarness.setState({ band }));
    // The canvas snapped past maxRetargets; the braindump is still gliding.
    expect(glides.every((a) => !a.cancelled)).toBe(true);
    expect(settling()).toBe('true');
    expect(bucket('morning').getAttribute('style')).toBe(before['bucket-morning']);
    expect(document.querySelector('[data-testid="buckets-scope"] [data-item-id="a2"]')!.hasAttribute('style')).toBe(false);
  });

  it('raises nothing when the row starts inside its own context: a reorder within one bucket', () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
    const before = inlineStyles();
    land([item('m3'), item('m1'), item('m2')]);
    expect(on(`${DAY}|m3`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 80px)' });
    expect(bucket('morning').getAttribute('style')).toBe(before['bucket-morning']);
    expect(bucket('afternoon').getAttribute('style')).toBe(before['bucket-afternoon']);
  });

  it('two raised siblings: the one whose row travels farther stacks on top', () => {
    // a2 goes up into Morning (100px), m2 down into Afternoon (60px): each starts outside the other card.
    startPreview(<Buckets />, INTO_MORNING.cached());
    const before = inlineStyles();
    land([item('m1'), item('a2'), item('m2', 'm2', { bucket: 'afternoon' }), item('a1', 'a1', { bucket: 'afternoon' })]);
    expect(on(`${DAY}|a2`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 100px)' });
    expect(on(`${DAY}|m2`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, -60px)' });
    expect(bucket('morning').style.zIndex).toBe('2');
    expect(bucket('afternoon').style.zIndex).toBe('1');
    act(() => window.dispatchEvent(new Event('resize')));
    expect(inlineStyles()).toEqual(before);
  });

  it('a frame that glides with its rows raises nothing: judged in the frame’s own coordinates', () => {
    // A row lands at Morning's top, so Afternoon glides down 40 — and inside it a1 and a2 swap.
    // a1 starts above Afternoon's resting box, but inside the box as Afternoon is drawn then.
    startPreview(<Buckets />, INTO_MORNING.cached());
    const before = inlineStyles();
    land([item('m0'), item('m1'), item('m2'), item('a2', 'a2', { bucket: 'afternoon' }), item('a1', 'a1', { bucket: 'afternoon' })]);
    expect(on('bucket:afternoon')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });
    expect(on(`${DAY}|a1`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });
    expect(row('a1').getBoundingClientRect().top).toBe(120); // its FIRST: above Afternoon's LAST top (140)
    expect(bucket('afternoon').getAttribute('style')).toBe(before['bucket-afternoon']);
    expect(bucket('morning').getAttribute('style')).toBe(before['bucket-morning']);
  });
});

describe('a row that crosses its neighbours is lifted', () => {
  it('only when its own move is longer than its height: stacked above its siblings, on the nearest painted ground', () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
    const before = inlineStyles();
    land([item('m3'), item('m1'), item('m2')]);
    // m3 crosses two rows (80px > 40px); m1 and m2 each move exactly their own height.
    const m3 = row('m3');
    expect(m3.style.zIndex).toBe('1');
    expect(m3.style.position).toBe('relative'); // it was static: z-index needs a position
    expect(m3.style.backgroundColor).toBe(PAINTED); // the card body's, the nearest painted ancestor
    expect(m3.style.backgroundClip).toBe('border-box'); // the whole box its shadow outlines: no see-through ring inside it
    expect(m3.style.boxShadow).toBe('var(--shadow-elev-sm)'); // lifted: the floating surfaces' elevation, read from its token
    expect(m3.style.backgroundImage).toBe(''); // no fill of its own to make solid
    expect(row('m1').hasAttribute('style')).toBe(false);
    expect(row('m2').hasAttribute('style')).toBe(false);
    expect([...changedProps(before)].sort()).toEqual(['background-clip', 'background-color', 'box-shadow', 'position', 'z-index']);

    frame();
    frame();
    advance(SETTLE.moveMs + 50);
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('the row moved into another bucket is lifted on its new card’s ground', () => {
    intoMorning();
    const a2 = row('a2');
    expect(a2.style.zIndex).toBe('1');
    expect(a2.style.backgroundColor).toBe(PAINTED);
  });

  it('with no painted ground inside the scope it is stacked but given none — never the canvas outside it', () => {
    startPreview(<Canvas />, CACHED());
    const before = inlineStyles();
    land([item('d'), item('a'), item('b'), item('c')]);
    const d = row('d');
    expect(d.style.zIndex).toBe('1');
    expect(d.style.backgroundColor).toBe('');
    expect(d.style.boxShadow).toBe(''); // no surface: a shadow would outline nothing
    expect(row('a').hasAttribute('style')).toBe(false);
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
  });

  it('keeps a ground of its own (a selected row’s wash): stacked, its background untouched, then put back exactly', () => {
    const own = 'rgb(1, 2, 3)';
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3', 'm3', { bg: own })]);
    const before = inlineStyles();
    land([item('m3', 'm3', { bg: own }), item('m1'), item('m2')]);
    const m3 = row('m3');
    expect(m3.style.zIndex).toBe('1');
    expect(m3.style.backgroundColor).toBe(own); // not the card's
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(m3.getAttribute('style')).toBe('background-color: rgb(1, 2, 3);');
    expect(inlineStyles()).toEqual(before);
  });

  it('is off in a scope marked data-settle-lift="off" (Zen): stacked by nothing, given no ground or shadow', () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
    document.querySelector('[data-settle-scope]')!.setAttribute('data-settle-lift', 'off');
    const before = inlineStyles();
    land([item('m3'), item('m1'), item('m2')]);
    expect(on(`${DAY}|m3`).length).toBeGreaterThan(0); // it still glides
    expect(row('m3').hasAttribute('style')).toBe(false);
    expect(changedProps(before).size).toBe(0);
  });

  it('is off when SETTLE.liftRows is false — and the raise still runs', () => {
    const settle = SETTLE as unknown as { liftRows: boolean };
    settle.liftRows = false;
    try {
      const before = intoMorning();
      expect(row('a2').hasAttribute('style')).toBe(false);
      expect(bucket('morning').style.zIndex).toBe('1');
      expect([...changedProps(before)]).toEqual(['z-index']);
      cleanup();
      startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
      land([item('m3'), item('m1'), item('m2')]);
      expect(row('m3').hasAttribute('style')).toBe(false);
    } finally {
      settle.liftRows = true;
    }
  });
});

describe('nothing is stacked where nothing animates', () => {
  const vetoes: [string, () => void][] = [
    ['the OS reduced-motion preference', reduceMotionOS],
    ['the in-app animations toggle', () => document.documentElement.setAttribute('data-reduce-motion', 'true')],
    ['static mode', () => (mode.value = 'static')],
  ];

  it.each(vetoes)('under %s: no raise, no lift, no inline write at all', async (_, veto) => {
    startPreview(<Buckets />, INTO_MORNING.cached());
    act(veto);
    const before = inlineStyles();
    land(INTO_MORNING.fresh());
    expect(animations).toEqual([]);
    expect(settling()).toBe('true'); // shielded instead
    expect(inlineStyles()).toEqual(before);
    // A follow-up the vetoed run watches is shielded, never stacked either.
    await commit(() => usePlannerStore.setState({ items: [item('m0'), ...INTO_MORNING.fresh()] }));
    expect(animations).toEqual([]);
    expect(inlineStyles()).toEqual({ ...before, m0: null });
    advance(SETTLE.shieldMs);
    expect(inlineStyles()).toEqual({ ...before, m0: null });
  });

  it('a veto that lands mid-hold snaps the run and puts back what the hold stacked', () => {
    const before = intoMorning();
    expect(bucket('morning').style.zIndex).toBe('1');
    frame();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    frame();
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });
});

// ── Stacking across cousins ─────────────────────────────────────────────

/**
 * CSS paint order, from computed position / z-index / isolation and the live
 * fake animations (a transform or clip in effect makes a stacking context):
 * whether `a` is drawn over `b` where the two overlap.
 */
function isContext(el: Element): boolean {
  const cs = getComputedStyle(el);
  const parent = el.parentElement;
  const positioned = cs.position !== '' && cs.position !== 'static';
  const flexItem = !!parent && /flex|grid/.test(getComputedStyle(parent).display);
  const z = cs.zIndex !== '' && cs.zIndex !== 'auto';
  return (z && (positioned || flexItem)) || cs.isolation === 'isolate' || (animsOn.get(el) ?? []).some((x) => x.progress() !== null);
}

/** Where `el` sits in its stacking context: its z-index as a context, 0 positioned, -1 in flow. */
function levelOf(el: Element): number {
  const cs = getComputedStyle(el);
  const z = Number.parseInt(cs.zIndex, 10);
  if (isContext(el)) return Number.isFinite(z) ? z : 0;
  return cs.position !== '' && cs.position !== 'static' ? 0 : -1;
}

/** Each stacking context `el` is inside, outermost first, then what it is painted with in the innermost one. */
function stackPath(el: Element): Element[] {
  const contexts: Element[] = [];
  let painter: Element | null = null;
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    if (isContext(e)) contexts.unshift(e);
    else if (contexts.length === 0 && !painter && levelOf(e) === 0) painter = e;
  }
  return isContext(el) ? contexts : [...contexts, painter ?? el];
}

function paintsAbove(a: Element, b: Element): boolean {
  const pa = stackPath(a);
  const pb = stackPath(b);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i += 1;
  // One inside the other's context: the inner one paints over its ground.
  if (i === pa.length || i === pb.length) return pa.length > pb.length;
  const la = levelOf(pa[i]);
  const lb = levelOf(pb[i]);
  if (la !== lb) return la > lb;
  // A tie goes to tree order: the later one paints last.
  return (pa[i].compareDocumentPosition(pb[i]) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
}

const wrapOf = (b: string) => document.querySelector<HTMLElement>(`[data-testid="wrap-${b}"]`)!;
const cardOf = (b: string) => document.querySelector<HTMLElement>(`[data-testid="card-${b}"]`)!;
const captionOf = (b: string) => document.querySelector<HTMLElement>(`[data-testid="caption-${b}"]`)!;

/**
 * m1 m2 | a1 a2 a3 → m1 m2 a2 | a1 a3, the recording's shape: a2 goes up into
 * Morning (60px), and Afternoon slides 40px down around a3, which stays put —
 * so a3 starts outside Afternoon's box as well, and Afternoon is raised too.
 */
const COUSINS = {
  cached: () => [
    item('m1'),
    item('m2'),
    item('a1', 'a1', { bucket: 'afternoon' }),
    item('a2', 'a2', { bucket: 'afternoon' }),
    item('a3', 'a3', { bucket: 'afternoon' }),
  ],
  fresh: () => [
    item('m1'),
    item('m2'),
    item('a2'),
    item('a1', 'a1', { bucket: 'afternoon' }),
    item('a3', 'a3', { bucket: 'afternoon' }),
  ],
};

describe('a raise between cousins: each card the only thing in its own wrapper', () => {
  it('raises the outermost box the row starts outside of — the wrapper — so the card it left never paints over it', () => {
    startPreview(<Buckets wrap="flex" />, COUSINS.cached());
    const before = inlineStyles();
    land(COUSINS.fresh());
    expect(on(`${DAY}|a2`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 60px)' });
    expect(on('bucket:afternoon')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });
    expect(on(`${DAY}|a3`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' });

    // Drawn over the Afternoon card and its caption, where it starts.
    expect(paintsAbove(row('a2'), cardOf('afternoon'))).toBe(true);
    expect(paintsAbove(row('a2'), captionOf('afternoon'))).toBe(true);
    // Morning's wrapper (a flex item: z-index alone) outranks Afternoon's card, whose row travels less.
    expect(wrapOf('morning').style.zIndex).toBe('2');
    expect(wrapOf('morning').style.position).toBe('');
    expect(bucket('afternoon').style.zIndex).toBe('1');
    expect(bucket('morning').getAttribute('style')).toBe(before['bucket-morning']);
    expect(wrapOf('afternoon').getAttribute('style')).toBeNull();

    frame();
    frame();
    advance(200);
    expect(paintsAbove(row('a2'), cardOf('afternoon'))).toBe(true);
    advance(SETTLE.moveMs + 50 - 200);
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('a static block wrapper takes `position: relative` with its z-index, and gives it back', () => {
    startPreview(<Buckets wrap="block" />, COUSINS.cached());
    const before = inlineStyles();
    land(COUSINS.fresh());
    expect(wrapOf('morning').style.zIndex).toBe('2');
    expect(wrapOf('morning').style.position).toBe('relative');
    expect(paintsAbove(row('a2'), cardOf('afternoon'))).toBe(true);
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
  });

  it('steps down to the card where a position on the wrapper would re-anchor an absolute child', () => {
    startPreview(<Buckets wrap="anchoring" />, COUSINS.cached());
    const before = inlineStyles();
    land(COUSINS.fresh());
    expect(wrapOf('morning').getAttribute('style')).toBeNull();
    expect(bucket('morning').style.zIndex).toBe('2'); // already positioned: no position written
    expect(bucket('morning').style.position).toBe('relative');
    expect(bucket('afternoon').style.zIndex).toBe('1');
    expect(paintsAbove(row('a2'), cardOf('afternoon'))).toBe(true);
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
  });
});

// ── Retypes ─────────────────────────────────────────────────────────────

describe('a type-in starts where the text changed, and paces the text', () => {
  let reads: { live: number; glides: number; lifts: number }[] = [];
  let ranges = 0;
  const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };

  beforeEach(() => {
    reads = [];
    ranges = 0;
    // jsdom draws no text: a character is CH px wide, flowing on from the left of the nearest element
    // with an x of its own (an emoji's span inside a title flows on with the title's text).
    proto.getBoundingClientRect = function (this: Range) {
      const start = this.startContainer;
      const el = (start instanceof Element ? start : start.parentElement!).closest<HTMLElement>('[data-x]')!;
      const scope = el.closest('[data-settle-scope]');
      const running = animations.filter((a) => !a.cancelled && scope?.contains(a.target));
      const count = (k: string) => running.filter((a) => kind(a) === k).length;
      reads.push({ live: running.length, glides: count('glide'), lifts: count('lift') });
      const box = layoutOf(el);
      if (box.width === 0 && box.height === 0) return box;
      const chars = (node: Node, offset: number) => {
        const r = new Range();
        r.setStart(el, 0);
        r.setEnd(node, offset);
        return r.toString().length;
      };
      const from = chars(start, this.startOffset);
      const to = chars(this.endContainer, this.endOffset);
      return rect(box.left + from * CH, box.top, (to - from) * CH, 16);
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      ranges += 1;
      return createRange();
    });
  });

  afterEach(() => {
    delete proto.getBoundingClientRect;
  });

  const clips = (id: string) => on(`${DAY}|${id}`).filter((a) => kind(a) === 'clip');
  const clipOf = (id: string) => clips(id).map((a) => a.keyframes);
  const right = (x: number) => `inset(-8px ${VIEW_W - x}px -8px -8px)`;
  /** Clipped from viewport x `x` rightward (the rows span the 1024px canvas), revealed to the bleed in one stroke. */
  const typedFrom = (x: number) => [[{ clipPath: right(x) }, { clipPath: 'inset(-8px)' }]];
  /** From `start` (a clip), the text uncovered to viewport x `end` by typeTextAt on EASE_TYPE, then the rest of the row. */
  const pacedFrom = (start: string, end: number) => [
    [
      { clipPath: start, offset: 0, easing: EASE_TYPE },
      { clipPath: right(end), offset: SETTLE.typeTextAt, easing: EASE_SETTLE },
      { clipPath: 'inset(-8px)', offset: 1 },
    ],
  ];
  const paced = (x: number, end: number) => pacedFrom(right(x), end);
  const TYPE_IN = 'inset(-8px 100% -8px -8px)';
  const WHOLE = [[{ clipPath: TYPE_IN }, { clipPath: 'inset(-8px)' }]];

  it('keeps the checkbox and the unchanged prefix drawn: only what was added types in, at a reading pace', () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Draft the Q4 plan')]);
    land([item('a'), item('d', "Draft the Q4 plan with Maya's notes")]);
    expect(clipOf('d')).toEqual(paced(TITLE_X + 17 * CH, TITLE_X + 35 * CH));
    // The keyframes carry the curves: the effect itself runs linear.
    expect(clips('d')[0].options).toMatchObject({ duration: SETTLE.retypeMs, easing: 'linear' });
    // One Range for the one retype, its start and its text's end, read at layout with nothing in the scope animating.
    expect(ranges).toBe(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.live === 0)).toBe(true);
  });

  it('a change with no common prefix starts at the text’s left edge — the checkbox (8–24) stays drawn', () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Call Sam')]);
    land([item('a'), item('d', 'Email Sam')]);
    expect(clipOf('d')).toEqual(paced(TITLE_X, TITLE_X + 9 * CH));
    expect(TITLE_X).toBeGreaterThan(24);
  });

  it('a change in a later text node starts there: the title before it stays drawn, and it opens in one stroke', () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Stretch', { rail: '30m' })]);
    land([item('a'), item('d', 'Stretch', { rail: '45m' })]);
    expect(clipOf('d')).toEqual(typedFrom(RAIL_X));
    expect(clips('d')[0].options.easing).toBe(EASE_SETTLE);
  });

  it('a mid-word change starts mid-word; a text cut short starts after its last character, with no text left to pace', () => {
    startPreview(<Canvas />, [item('a', 'Reply to Sam'), item('d', 'Draft the Q4 plan with notes')]);
    land([item('a', 'Reply to Sal'), item('d', 'Draft the Q4 plan')]);
    expect(clipOf('a')).toEqual(paced(TITLE_X + 11 * CH, TITLE_X + 12 * CH));
    expect(clipOf('d')).toEqual(typedFrom(TITLE_X + 17 * CH));
    expect(ranges).toBe(2);
  });

  it('a changed character that is not drawn falls back to where the text starts', () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Stretch', { rail: '30m', railHidden: true })]);
    land([item('a'), item('d', 'Stretch', { rail: '45m', railHidden: true })]);
    expect(clipOf('d')).toEqual(paced(TITLE_X, TITLE_X + 7 * CH));
    expect(ranges).toBe(1);
  });

  it('a title clipped by its own box is paced to where its box ends', () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Plan')]);
    land([item('a'), item('d', 'Plan '.repeat(40).trim())]);
    // 199 characters run far past the row: the text ends where the title's box does, the row's right edge.
    expect(clipOf('d')).toEqual(paced(TITLE_X + 4 * CH, VIEW_W));
  });

  it('a new row types its title in at a reading pace, then opens the rest of the row: one Range, its lift unchanged', () => {
    startPreview(<Canvas />, [item('a'), item('d')]);
    land([item('a'), item('e', 'Email the landlord'), item('d')]);
    expect(clipOf('e')).toEqual(pacedFrom(TYPE_IN, TITLE_X + 18 * CH));
    expect(clips('e')[0].options).toMatchObject({ duration: SETTLE.appearMs, delay: SETTLE.appearLead, easing: 'linear' });
    const lift = on(`${DAY}|e`).find((a) => kind(a) === 'lift')!;
    expect(lift.keyframes).toEqual([{ transform: 'translateY(4px)' }, { transform: 'translateY(0px)' }]);
    expect(lift.options.easing).toBe(EASE_SETTLE);
    expect(ranges).toBe(1);
    expect(reads.every((r) => r.live === 0)).toBe(true);
  });

  it('a title with an emoji is paced whole, wherever the emoji sits: its span never ends the text early', () => {
    startPreview(<Canvas />, [item('a'), item('d')]);
    land([
      item('a'),
      item('e', '🏋️ Gym day', { titled: true }),
      item('f', 'Call mom 📞', { titled: true }),
      item('g', 'Plain', { titled: true }),
      item('d'),
    ]);
    expect(document.querySelectorAll('[data-row-title] [data-row-emoji]')).toHaveLength(2);
    expect(clipOf('e')).toEqual(pacedFrom(TYPE_IN, TITLE_X + '🏋️ Gym day'.length * CH));
    expect(clipOf('f')).toEqual(pacedFrom(TYPE_IN, TITLE_X + 'Call mom 📞'.length * CH));
    expect(clipOf('g')).toEqual(pacedFrom(TYPE_IN, TITLE_X + 5 * CH));
  });

  it('a new frame still unfolds in one stroke: only rows type in', () => {
    startPreview(<Canvas />, [item('a')]);
    land([item('a'), item('w1', 'w1', { project: 'work' })]);
    expect(on('group:work').find((a) => kind(a) === 'clip')!.keyframes).toEqual([
      { clipPath: 'inset(-8px -8px 100% -8px)' },
      { clipPath: 'inset(-8px)' },
    ]);
    expect(ranges).toBe(0);
  });

  it('a row new since the landing types in at a pace too, measured at the retarget with no glide in the scope running', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    advance(100);
    reads = [];
    await commit(() => usePlannerStore.setState({ items: [...FRESH(), item('late', 'Late arrival')] }));
    expect(clipOf('late')).toEqual(pacedFrom(TYPE_IN, TITLE_X + 12 * CH));
    expect(clips('late')[0].options).toMatchObject({ delay: 0, easing: 'linear' });
    expect(reads.length).toBeGreaterThan(0);
    // The clip reveals it keeps run on (a clip moves no rect), and so does e's lift, which only moves up or
    // down (a type-in's insets are all horizontal); its glides are cancelled before it reads.
    expect(reads.every((r) => r.glides === 0 && r.live > 0)).toBe(true);
    expect(reads.some((r) => r.lifts > 0)).toBe(true);
  });

  it('types the whole row in when only an attribute changed (a tick), or with no Range geometry at all', () => {
    startPreview(<Canvas />, [item('a'), item('d')]);
    land([item('a'), item('d', 'd', { done: true })]);
    expect(clipOf('d')).toEqual(WHOLE);
    expect(ranges).toBe(0);
    cleanup();

    delete proto.getBoundingClientRect; // jsdom, or an engine without it
    startPreview(<Canvas />, [item('a'), item('d', 'Draft')]);
    land([item('a'), item('d', 'Draft two')]);
    expect(clipOf('d')).toEqual(WHOLE);
  });

  it('a follow-up mid-hold measures again at the new layout, still with nothing in the scope animating', async () => {
    startPreview(<Canvas />, [item('a'), item('d', 'Draft the Q4 plan')]);
    land([item('a'), item('d', "Draft the Q4 plan with Maya's notes")]);
    frame();
    await commit(() => useHarness.setState({ band: 30 }));
    expect(clipOf('d')).toEqual(paced(TITLE_X + 17 * CH, TITLE_X + 35 * CH));
    expect(ranges).toBe(2);
    expect(reads.every((r) => r.live === 0)).toBe(true);
  });
});

// ── The lifted row's ground ─────────────────────────────────────────────

describe('a lifted row’s ground covers the box its shadow outlines', () => {
  it('on a phone the box (SwipeRow) is stacked and the row inside it takes the ground, over its whole box', () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3', 'm3', { sink: true })]);
    const before = inlineStyles();
    land([item('m3', 'm3', { sink: true }), item('m1'), item('m2')]);
    const sink = document.querySelector<HTMLElement>('[data-testid="sink-m3"]')!;
    expect(on(`${DAY}|m3`)).toEqual([]); // the box animates, not the row
    expect(animsOn.get(sink)?.[0].keyframes[0]).toEqual({ transform: 'translate(0px, 80px)' });
    expect(sink.style.zIndex).toBe('1');
    expect(sink.style.backgroundColor).toBe('');
    const m3 = row('m3');
    expect(m3.style.zIndex).toBe('');
    expect(m3.style.backgroundColor).toBe(PAINTED);
    expect(m3.style.backgroundClip).toBe('border-box');
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
    expect(m3.hasAttribute('style')).toBe(false);
  });
});

// ── A lifted or raised box is solid, and a lifted one casts a shadow ─────

describe('a lifted or raised box is solid, and a lifted one casts the elevation shadow', () => {
  const SHADOW = 'var(--shadow-elev-sm)';
  const solid = (...colors: string[]) => colors.map((c) => `linear-gradient(${c}, ${c})`).join(', ');
  /** m3 crosses m1 and m2 (80px > 40px): lifted. */
  const lift = (m3: Partial<Row>) => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3', 'm3', m3)]);
    const before = inlineStyles();
    land([item('m3', 'm3', m3), item('m1'), item('m2')]);
    return before;
  };

  it.each([
    ['rgba(10, 20, 30, 0.5)', 'the legacy form'],
    ['rgb(10 20 30 / 50%)', 'the slash form, in percent'],
    ['oklab(0.5 0.1 0.1 / 0.6)', 'a modern space'],
  ])('a translucent own fill (%s, %s) is redrawn over the card, as it reads at rest, and put back exactly', (bg) => {
    const before = lift({ bg });
    const m3 = row('m3');
    const own = getComputedStyle(m3).backgroundColor;
    expect(m3.style.backgroundImage).toBe(solid(own, PAINTED)); // its own colour on top, the card's opaque one under it
    expect(m3.style.backgroundColor).toBe(own); // never written: a pane transitions it
    expect(m3.style.backgroundClip).toBe(''); // its own fill covers its whole box at rest, and still does
    expect(m3.style.zIndex).toBe('1');
    expect(m3.style.boxShadow).toBe(SHADOW);
    expect([...changedProps(before)].sort()).toEqual(['background-image', 'box-shadow', 'position', 'z-index']);
    frame();
    frame();
    advance(SETTLE.moveMs + 50);
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('an opaque own fill is left as it is: nothing to solidify', () => {
    const before = lift({ bg: 'rgb(1, 2, 3)' });
    expect(row('m3').style.backgroundImage).toBe('');
    expect([...changedProps(before)].sort()).toEqual(['box-shadow', 'position', 'z-index']);
  });

  it('a fill that already draws an image (a hover wash) is left as it is', () => {
    const image = 'linear-gradient(rgb(0, 0, 255), rgb(0, 0, 255))';
    const before = lift({ bg: 'rgba(10, 20, 30, 0.5)', image });
    expect(row('m3').style.backgroundImage).toBe(image);
    expect(changedProps(before).has('background-image')).toBe(false);
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
  });

  it('a shadow of its own is kept, never replaced', () => {
    const shadow = 'rgb(255, 0, 0) 0px 0px 0px 1px';
    const before = lift({ shadow });
    const m3 = row('m3');
    expect(m3.style.boxShadow).toBe(shadow);
    expect(m3.style.backgroundColor).toBe(PAINTED); // the ground still goes on
    expect(changedProps(before).has('box-shadow')).toBe(false);
  });

  it('nothing is written that would start a CSS transition: a run animates transform and clip-path only', () => {
    lift({ bg: 'rgba(10, 20, 30, 0.5)', fades: 'background-color, box-shadow' });
    const m3 = row('m3');
    expect(m3.style.boxShadow).toBe('');
    expect(m3.style.backgroundImage).not.toBe(''); // background-image is not among them
    cleanup();
    const before = lift({ bg: 'rgba(10, 20, 30, 0.5)', fades: 'all' });
    expect([...changedProps(before)].sort()).toEqual(['position', 'z-index']);
  });

  it('a row with no fill of its own that transitions background-color takes no ground: it would fade in under the glide', () => {
    for (const fades of ['background-color', 'all']) {
      const before = lift({ fades });
      const m3 = row('m3');
      expect(m3.style.zIndex, fades).toBe('1'); // still stacked
      expect(m3.style.backgroundColor, fades).toBe('');
      // No ground, so no clip for it, and no surface for a shadow to outline.
      expect([...changedProps(before)].sort(), fades).toEqual(['position', 'z-index']);
      act(() => fireEvent.keyDown(document.body, { key: 'j' }));
      expect(inlineStyles(), fades).toEqual(before);
      cleanup();
    }
  });

  it('a block that draws its surface on a plate: no ground on the band, the plate solid and lit, put back exactly', () => {
    const plate = 'rgba(200, 200, 200, 0.8)';
    const before = lift({ plate });
    const m3 = row('m3');
    const pane = document.querySelector<HTMLElement>('[data-testid="plate-m3"]')!;
    expect(m3.style.zIndex).toBe('1'); // the block is stacked as before…
    expect(m3.style.backgroundColor).toBe(''); // …with no ground behind the whole band
    expect(m3.style.boxShadow).toBe('');
    expect(pane.style.backgroundImage).toBe(solid(plate, PAINTED));
    expect(pane.style.boxShadow).toBe(SHADOW);
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(inlineStyles()).toEqual(before);
  });

  it('a plate with a shadow of its own keeps it, and is still made solid', () => {
    const before = lift({ plate: 'rgba(200, 200, 200, 0.8)', plateShadow: 'rgb(0, 0, 0) 0px 1px 2px 0px' });
    const pane = document.querySelector<HTMLElement>('[data-testid="plate-m3"]')!;
    expect(pane.style.boxShadow).toBe('rgb(0, 0, 0) 0px 1px 2px 0px');
    expect(pane.style.backgroundImage).not.toBe('');
    expect(changedProps(before).has('box-shadow')).toBe(false);
    // m1 and m2 have no plate and do not cross a row: untouched.
    expect(row('m1').hasAttribute('style')).toBe(false);
  });

  it('a raised box with a translucent fill is made solid too, with no shadow, and put back when the host unmounts', () => {
    const useHost = create(() => ({ on: true }));
    const MaybeHost = () => (useHost((s) => s.on) ? <SettleHost /> : null);
    const cardBg = 'rgba(250, 250, 250, 0.9)';
    act(() => usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: INTO_MORNING.cached() }));
    render(
      <>
        <MaybeHost />
        <Buckets cardBg={cardBg} />
      </>
    );
    frame();
    frame();
    const before = inlineStyles();
    land(INTO_MORNING.fresh());
    const morning = bucket('morning');
    expect(morning.style.zIndex).toBe('1');
    // Over the scope's own box: the opaque canvas outside view-root is what it reads against.
    expect(morning.style.backgroundImage).toBe(solid(cardBg, 'rgb(9, 9, 9)'));
    expect(morning.style.boxShadow).toBe('');
    expect(bucket('afternoon').style.backgroundImage).toBe(''); // not raised
    frame();
    frame();
    advance(100);
    act(() => useHost.setState({ on: false }));
    expect(live()).toEqual([]);
    expect(inlineStyles()).toEqual(before);
  });

  it('a follow-up mid-hold keeps the ground, the fill and the shadow: each pass is judged as the scope rests', async () => {
    const before = lift({});
    const m3 = row('m3');
    expect(m3.style.backgroundColor).toBe(PAINTED);
    frame();
    await commit(() => useHarness.setState({ band: 30 })); // a re-hold
    expect(m3.style.backgroundColor).toBe(PAINTED);
    expect(m3.style.backgroundClip).toBe('border-box');
    expect(m3.style.boxShadow).toBe(SHADOW);
    expect(m3.style.zIndex).toBe('1');
    frame();
    frame();
    advance(SETTLE.moveMs + 50);
    expect(inlineStyles()).toEqual(before);
  });

  it('nothing at all under a veto', () => {
    reduceMotionOS();
    const before = lift({ bg: 'rgba(10, 20, 30, 0.5)', plate: 'rgba(200, 200, 200, 0.8)' });
    expect(changedProps(before).size).toBe(0);
  });
});

// ── A lifted row comes off as it lands ──────────────────────────────────

describe('a lifted row comes off as its own move lands, while the rest play on', () => {
  const SHADOW = 'var(--shadow-elev-sm)';
  /** The set-down: the one animation of anything but transform and clip-path. */
  const fadeOf = (el: Element) => (animsOn.get(el) ?? []).find((a) => 'boxShadow' in a.from && !a.cancelled);
  /** Every row that was there before the landing is as it was: m4 and the band are new. */
  const asBefore = (before: Record<string, string | null>) => {
    const now = inlineStyles();
    for (const id of Object.keys(before)) expect([id, now[id]]).toEqual([id, before[id]]);
  };
  /** m3 crosses m1 and m2 (80px > 40px): lifted. m4 appears, and its reveal outlasts every move. */
  const liftAndAppear = () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
    const before = inlineStyles();
    land([item('m3'), item('m1'), item('m2'), item('m4')]);
    return before;
  };

  it('sets its shadow down over the last liftSetDownMs of the move, then puts every write back, mid-run', () => {
    const before = liftAndAppear();
    const m3 = row('m3');
    expect(fadeOf(m3)).toBeUndefined(); // nothing is timed while the moves are held
    frame();
    frame(); // plays
    const fade = fadeOf(m3)!;
    expect(fade.keyframes).toEqual([{ boxShadow: getComputedStyle(m3).boxShadow }, { boxShadow: 'none' }]);
    expect(fade.options).toMatchObject({
      duration: SETTLE.liftSetDownMs,
      delay: SETTLE.moveMs - SETTLE.liftSetDownMs,
      easing: EASE_SET_DOWN,
      fill: 'forwards', // held at none until the release takes the inline shadow off
    });
    expect(m3.style.boxShadow).toBe(SHADOW); // the lift stands under it
    advance(SETTLE.moveMs - 1);
    expect(m3.style.zIndex).toBe('1');
    expect(fade.cancelled).toBe(false);
    advance(2);
    // Landed: every write is back, the set-down with it, and the run plays on.
    expect(m3.hasAttribute('style')).toBe(false);
    expect(fade.cancelled).toBe(true);
    expect(settling()).toBe('true');
    expect(live().length).toBeGreaterThan(0);
    asBefore(before);
    expect(row('m4').hasAttribute('style')).toBe(false);
    advance(SETTLE.appearLead + SETTLE.appearMs);
    expect(live()).toEqual([]);
    asBefore(before);
  });

  it('an interrupt mid-set-down puts the row back and cancels the fade in the same task', () => {
    const before = liftAndAppear();
    frame();
    frame();
    advance(SETTLE.moveMs - 40);
    const fade = fadeOf(row('m3'))!;
    act(() => fireEvent.keyDown(document.body, { key: 'j' }));
    expect(fade.cancelled).toBe(true);
    asBefore(before);
  });

  it('a retarget before the set-down re-times it from the re-aimed move', async () => {
    const before = liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    advance(100);
    const first = fadeOf(m3)!;
    await commit(() => useHarness.setState({ band: 30 })); // re-aims every move: moveMs − 100 from here
    expect(first.cancelled).toBe(true);
    const again = fadeOf(m3)!;
    const left = SETTLE.moveMs - 100;
    expect(again.options).toMatchObject({ duration: SETTLE.liftSetDownMs, delay: left - SETTLE.liftSetDownMs, fill: 'forwards' });
    advance(left - 1);
    expect(m3.style.zIndex).not.toBe('');
    advance(2);
    expect(m3.hasAttribute('style')).toBe(false);
    expect(again.cancelled).toBe(true);
    advance(SETTLE.runTimeoutMs);
    expect(live()).toEqual([]);
    asBefore(before);
  });

  it('a retarget mid-set-down goes on from the shadow as drawn, at once: it never shows full again', async () => {
    const before = liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    advance(SETTLE.moveMs - SETTLE.liftSetDownMs + 30); // 30ms into the set-down
    const first = fadeOf(m3)!;
    // Part-way down, as drawn: not the full lift shadow still standing inline under the fade.
    const drawn = getComputedStyle(m3).boxShadow;
    expect(drawn).toBe(`${SHADOW} @ ${(30 / SETTLE.liftSetDownMs).toFixed(3)}`);
    expect(m3.style.boxShadow).toBe(SHADOW);
    await commit(() => useHarness.setState({ band: 30 })); // re-aims m3: retargetMinMs from here
    expect(first.cancelled).toBe(true);
    const again = fadeOf(m3)!;
    expect(again.keyframes).toEqual([{ boxShadow: drawn }, { boxShadow: 'none' }]);
    expect(again.keyframes[0].boxShadow).not.toBe(SHADOW);
    expect(again.options).toMatchObject({ duration: SETTLE.retargetMinMs, delay: 0, fill: 'forwards' });
    advance(SETTLE.retargetMinMs + 1);
    expect(m3.hasAttribute('style')).toBe(false);
    advance(SETTLE.runTimeoutMs);
    asBefore(before);
  });

  it('a retarget that leaves a landing row where it is keeps its release: it comes off when it was due', async () => {
    const before = liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    advance(SETTLE.moveMs - 4); // m3 is all but landed, its set-down nearly done
    const first = fadeOf(m3)!;
    // m2 grows: only m4, below it, moves. m3 is under a pixel from its slot and gets no move.
    await commit(() =>
      usePlannerStore.setState({ items: [item('m3'), item('m1'), item('m2', 'm2', { h: 50 }), item('m4')] })
    );
    expect(on(`${DAY}|m3`).filter((a) => kind(a) === 'glide')).toEqual([]);
    expect(first.cancelled).toBe(true);
    const again = fadeOf(m3)!;
    expect(again.options).toMatchObject({ delay: 0, duration: 4, fill: 'forwards' }); // on from where it was, never full
    advance(5);
    expect(m3.hasAttribute('style')).toBe(false); // when it was due, not at the run's end
    expect(settling()).toBe('true');
    advance(SETTLE.runTimeoutMs);
    expect(live()).toEqual([]);
    asBefore(before);
  });

  it('a raised card comes off with the row that asked for it', () => {
    const before = intoMorning();
    expect(bucket('morning').style.zIndex).toBe('1');
    frame();
    frame();
    advance(SETTLE.moveMs + 1);
    expect(bucket('morning').style.zIndex).toBe('');
    expect(row('a2').hasAttribute('style')).toBe(false);
    advance(SETTLE.runTimeoutMs);
    expect(inlineStyles()).toEqual(before);
  });
});

// ── Timed from when the engine starts each animation ────────────────────

describe('every end is timed from when the engine starts the animation, not from the call', () => {
  const LAG = 60;
  const fadeOf = (el: Element) => (animsOn.get(el) ?? []).find((a) => 'boxShadow' in a.from && !a.cancelled);
  /** m3 crosses m1 and m2 (80px > 40px): lifted. m4 appears, and its type-in and lift outlast every move. */
  const liftAndAppear = () => {
    startPreview(<Buckets />, [item('m1'), item('m2'), item('m3')]);
    const before = inlineStyles();
    land([item('m3'), item('m1'), item('m2'), item('m4')]);
    return before;
  };
  /** The latest end of m4's appear, from its start: what the finish waits for. */
  const APPEAR_END = SETTLE.appearLead + SETTLE.appearMs;
  /** Every row that was there before the landing is as it was: m4 is new. */
  const asBefore = (before: Record<string, string | null>) => {
    const now = inlineStyles();
    for (const id of Object.keys(before)) expect([id, now[id]]).toEqual([id, before[id]]);
  };

  it('a 60ms start lag moves the release and the finish 60ms later, and nothing is cut short', async () => {
    startLag = { composited: LAG, main: LAG }; // Chromium starts what was played together, at the compositor's moment
    const before = liftAndAppear();
    const m3 = row('m3');
    frame();
    frame(); // played at P; nothing has started yet
    const played = live().filter((a) => !('boxShadow' in a.from)); // the glides, the appear's clip and lift
    const fade = fadeOf(m3)!;
    advance(LAG);
    await microtasks(); // started at P + LAG, and the engine has said so
    advance(SETTLE.moveMs - 1); // P + LAG + moveMs − 1: the glide is all but landed
    expect(m3.style.zIndex).toBe('1');
    expect(m3.style.boxShadow).toBe(LIFT_SHADOW);
    expect(fadeOf(m3)).toBe(fade); // it started with the glide, so it already ends with it
    expect(fade.progress()).toBeGreaterThan(0.99);
    advance(2);
    expect(m3.hasAttribute('style')).toBe(false);
    expect(fade.cancelled).toBe(true);
    // The finish waits for m4's appear, which ends LAG + APPEAR_END after play.
    advance(APPEAR_END - SETTLE.moveMs - 1 + 50 - 1);
    expect(settling()).toBe('true');
    expect(played.every((a) => !a.cancelled && a.progress() === null)).toBe(true); // every one ran to its end
    advance(1);
    expect(settling()).toBeNull();
    expect(live()).toEqual([]);
    asBefore(before);
  });

  it('a set-down that began before the glides did is made again, to end as the row lands', async () => {
    startLag = { composited: LAG, main: 0 }; // the shadow fade starts at once, the glides LAG later
    liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    const early = fadeOf(m3)!;
    advance(LAG);
    await microtasks();
    expect(early.cancelled).toBe(true);
    const fade = fadeOf(m3)!;
    // Made LAG into the run, with all of the glide still to go: its delay is the corrected one.
    expect(fade.options).toMatchObject({
      duration: SETTLE.liftSetDownMs,
      delay: SETTLE.moveMs - SETTLE.liftSetDownMs,
      fill: 'forwards',
    });
    advance(SETTLE.moveMs - 1);
    expect(m3.style.zIndex).toBe('1');
    expect(fade.progress()).toBeGreaterThan(0.99);
    advance(2);
    expect(m3.hasAttribute('style')).toBe(false);
  });

  it('a set-down already under way when the engine reports is left as it is; the lift still comes off as the row lands', async () => {
    const late = SETTLE.moveMs - SETTLE.liftSetDownMs + 60; // the glides start 60ms into the set-down
    startLag = { composited: late, main: 0 };
    liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    const fade = fadeOf(m3)!;
    advance(late);
    await microtasks();
    expect(fadeOf(m3)).toBe(fade);
    expect(fade.cancelled).toBe(false);
    advance(SETTLE.moveMs - 1);
    expect(m3.style.zIndex).toBe('1'); // held to the glide's real end, the shadow set down by then
    expect(fade.progress()).toBe(1);
    advance(2);
    expect(m3.hasAttribute('style')).toBe(false);
  });

  it('a retarget measures what is left of the move from its real start, and its own glides are timed from theirs', async () => {
    startLag = { composited: LAG, main: LAG };
    liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    advance(LAG);
    await microtasks();
    advance(100); // 100ms into the glide, LAG + 100 after play
    await commit(() => useHarness.setState({ band: 30 })); // re-aims every move
    const [glide] = on(`${DAY}|m3`).filter((a) => kind(a) === 'glide');
    expect(glide.options.duration).toBe(SETTLE.moveMs - 100);
    advance(LAG);
    await microtasks(); // the re-aimed glides start now
    advance(SETTLE.moveMs - 100 - 1);
    expect(m3.style.zIndex).toBe('1');
    expect(fadeOf(m3)!.progress()).toBeGreaterThan(0.99);
    advance(2);
    expect(m3.hasAttribute('style')).toBe(false);
  });

  it('an engine that reports no start keeps the call’s clock', async () => {
    startLag = { composited: LAG, main: LAG };
    reportsStart = false;
    liftAndAppear();
    const m3 = row('m3');
    frame();
    frame();
    advance(LAG);
    await microtasks();
    advance(SETTLE.moveMs - LAG - 1);
    expect(m3.style.zIndex).toBe('1');
    advance(2); // moveMs after the call
    expect(m3.hasAttribute('style')).toBe(false);
    advance(APPEAR_END - SETTLE.moveMs + 50 - 2);
    expect(settling()).toBe('true');
    advance(1);
    expect(settling()).toBeNull();
  });

  it('a run that ended before the engine started anything stays ended', async () => {
    startLag = { composited: LAG, main: LAG };
    const before = liftAndAppear();
    frame();
    frame();
    advance(LAG / 2);
    act(() => fireEvent.keyDown(document.body, { key: 'j' })); // an interrupt, mid-lag
    expect(live()).toEqual([]);
    advance(LAG);
    await microtasks();
    advance(SETTLE.runTimeoutMs);
    expect(live()).toEqual([]);
    expect(settling()).toBeNull();
    asBefore(before);
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

// ── A layout change outside the scope ───────────────────────────────────

describe('a layout change outside the scope moves every row alike, and is carried rather than re-aimed back', () => {
  const ROWS = ['b', 'a', 'e', 'd'];
  const tops = () => Object.fromEntries(ROWS.map((id) => [id, row(id).getBoundingClientRect().top]));
  const expectTops = (want: Record<string, number>) => {
    for (const id of ROWS) expect([id, row(id).getBoundingClientRect().top]).toEqual([id, expect.closeTo(want[id], 5)]);
  };

  it('a hover after a painted outside shift leaves every row where it is drawn, and spends no retarget', async () => {
    startPreview(
      <Above>
        <Canvas />
      </Above>,
      CACHED()
    );
    land(FRESH());
    frame();
    frame();
    const running = live();
    advance(100);
    // The header row above the planner grows: nothing in the scope records it, and the next frame paints it.
    await commit(() => useHarness.setState({ above: 50 }));
    frame();
    const drawn = tops();
    const created = animations.length;
    await commit(() => row('a').style.setProperty('--title-mask', 'none')); // a record inside a row that moves nothing
    expect(animations).toHaveLength(created);
    expect(running.every((a) => !a.cancelled)).toBe(true);
    expectTops(drawn);

    // A real commit still re-aims from where the rows are drawn now, and two of them still fit the budget.
    const now = tops();
    await commit(() => useHarness.setState({ band: 20 }));
    expectTops(now);
    await commit(() => useHarness.setState({ band: 40 }));
    expect(on('group:inbox')).toHaveLength(1); // re-aimed, not snapped
    expect(on('group:inbox')[0].keyframes[0]).toEqual({ transform: 'translate(0px, -40px)' });
  });

  it('mid-hold, FIRST is carried too: a later re-hold keeps the rows where they are drawn', async () => {
    startPreview(
      <Above>
        <Canvas />
      </Above>,
      CACHED()
    );
    land(FRESH());
    const held = live();
    await commit(() => useHarness.setState({ above: 50 }));
    const drawn = tops();
    await commit(() => row('a').style.setProperty('--title-mask', 'none'));
    expect(held.every((a) => !a.cancelled && a.playState === 'paused')).toBe(true); // not re-held
    await commit(() => useHarness.setState({ band: 30 })); // a real follow-up re-holds against FIRST, as shifted
    expect(held.every((a) => a.cancelled)).toBe(true);
    expectTops(drawn);
  });
});

// ── An appear's lift through a retarget ─────────────────────────────────

describe('a retarget leaves an appear’s lift running beside its type-in', () => {
  it('neither is re-issued, and a lift is never taken for a glide: nothing is raised for it', async () => {
    startPreview(<Buckets />, [item('m1'), item('m2')]);
    const before = inlineStyles();
    land([item('m1'), item('m2'), item('e')]); // e appears last in Morning
    frame();
    frame();
    const [clip, lift] = [...on(`${DAY}|e`)].sort((x, y) => kind(x).localeCompare(kind(y)));
    expect([kind(clip), kind(lift)]).toEqual(['clip', 'lift']);
    advance(30);
    await commit(() => useHarness.setState({ band: 20 })); // every card glides down 20; e rides its card
    expect(on('bucket:morning').filter((a) => kind(a) === 'glide')).toHaveLength(1);
    expect(on(`${DAY}|e`)).toEqual([clip, lift]); // the same two, still paired
    expect([clip.options.delay, lift.options.delay]).toEqual([SETTLE.appearLead, SETTLE.appearLead]);
    expect(bucket('morning').getAttribute('style')).toBe(before['bucket-morning']);
    expect(row('e').hasAttribute('style')).toBe(false);
  });

  it('a glide the retarget gives an appearing row adds to its lift, from where it is drawn', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame();
    advance(30);
    const lift = on(`${DAY}|e`).find((a) => kind(a) === 'lift')!;
    const drawn = row('e').getBoundingClientRect().top;
    await commit(() => usePlannerStore.setState({ items: [item('x'), ...FRESH()] })); // e is pushed 40 down its group
    expect(lift.cancelled).toBe(false);
    const glides = on(`${DAY}|e`).filter((a) => kind(a) === 'glide');
    expect(glides.map((a) => a.keyframes[0])).toEqual([{ transform: 'translate(0px, -40px)' }]);
    // Summed with the lift, never in place of it: a replace would drop the lift while both run.
    expect(glides[0].options.composite).toBe('add');
    expect(row('e').getBoundingClientRect().top).toBeCloseTo(drawn, 5);
  });
});
