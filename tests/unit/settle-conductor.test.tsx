import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, createEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
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
 *    effect.getComputedTiming, on the fake clock;
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

import { SettleHost } from '@/components/shell/settle-host';
import { useDragStore } from '@/lib/drag-store';
import { hoveredItem, setHoveredItemRef } from '@/lib/hovered-item';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';
import { SETTLING_ATTR } from '@/lib/settle';
import { settleEpoch } from '@/lib/settle-epoch';
import { EASE_SETTLE, SETTLE } from '@/lib/settle-plan';
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

class FakeAnimation {
  playState: 'running' | 'paused' | 'idle' = 'running';
  private startedAt = performance.now();
  private held = 0;
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
  }

  get delay(): number {
    return this.options.delay ?? 0;
  }
  get duration(): number {
    return Number(this.options.duration);
  }
  get currentTime(): number {
    return this.playState === 'running' ? performance.now() - this.startedAt : this.held;
  }
  get cancelled(): boolean {
    return this.playState === 'idle';
  }
  pause() {
    this.held = this.currentTime;
    this.playState = 'paused';
  }
  play() {
    this.startedAt = performance.now() - this.held;
    this.playState = 'running';
  }
  cancel() {
    this.playState = 'idle';
  }
  get from(): Keyframe {
    return this.keyframes[0];
  }
  /** Linear here, eased in a browser: 0 through the delay (fill backwards), null once over or cancelled. */
  progress(): number | null {
    if (this.cancelled) return null;
    const t = this.currentTime;
    if (t < this.delay) return 0;
    if (t >= this.delay + this.duration) return null;
    return (t - this.delay) / this.duration;
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

function fakeAnimate(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const anim = new FakeAnimation(this, keyframes, options);
  animations.push(anim);
  animsOn.set(this, [...(animsOn.get(this) ?? []), anim]);
  return anim;
}

const live = () => animations.filter((a) => !a.cancelled);
const keyOf = (a: FakeAnimation) => a.target.getAttribute('data-settle-key');
const on = (key: string, list = live()) => list.filter((a) => keyOf(a) === key);
const kind = (a: FakeAnimation) => ('transform' in a.from ? 'translate' : 'clip');

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

function fakeRect(this: HTMLElement): DOMRect {
  rectCalls.push(this);
  if (throwNextRect) {
    throwNextRect = false;
    throw new Error('layout exploded');
  }
  if (hidden(this)) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect;
  const o = drawnOffset(this);
  const left = leftOf(this) + o.x;
  const top = topOf(this) + o.y;
  const width = widthOf(this);
  const height = heightOf(this);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
}

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

type Row = Item & { h?: number };
const item = (id: string, title = id, extra: Partial<Row> = {}): Row =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [], ...extra }) as Row;

/** Harness-only state: a non-participant band above the groups, and a key that remounts the braindump. */
const useHarness = create<{ band: number; tab: string }>(() => ({ band: 0, tab: 'a' }));

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

function TaskRow({ it }: { it: Row }) {
  return (
    <div
      data-settle-key={`${DAY}|${it.id}`}
      data-item-id={it.id}
      data-h={it.h ?? 40}
      onClick={onRowClick}
      onMouseDown={onRowMouseDown}
    >
      {it.title}
    </div>
  );
}

/** The canvas: view-root is `display: contents` under a 600px box, groups are frames. */
function Canvas() {
  const items = usePlannerStore((s) => s.items) as Row[];
  const band = useHarness((s) => s.band);
  return (
    <div data-testid="canvas-box" data-h={600}>
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
  animations = [];
  animsOn.clear();
  endTimeOverride = null;
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
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onRowClick.mockClear();
  onRowMouseDown.mockClear();
  onOutsideClick.mockClear();
  useHarness.setState({ band: 0, tab: 'a' });
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
  it('animates transform and clip-path ONLY — never opacity or filter — fill backwards, on ease-out-soft', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    expect(animations.length).toBeGreaterThan(0);
    for (const a of animations) {
      for (const kf of a.keyframes) {
        for (const prop of Object.keys(kf)) expect(['transform', 'clipPath']).toContain(prop);
      }
      expect(a.options.fill).toBe('backwards');
      expect(a.options.easing).toBe(EASE_SETTLE);
    }
  });

  it('plays §9.6 exactly: move, appear (clip type-in + 4px lift), retype; exits and still nodes get nothing', () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());

    const [moveA] = on(`${DAY}|a`);
    expect(moveA.keyframes).toEqual([{ transform: 'translate(0px, -40px)' }, { transform: 'translate(0px, 0px)' }]);
    expect(moveA.options).toMatchObject({ duration: 420, delay: 0, composite: 'add' });
    expect(on(`${DAY}|b`)[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' });

    const appear = on(`${DAY}|e`);
    expect(appear).toHaveLength(2);
    const clip = appear.find((a) => kind(a) === 'clip')!;
    const lift = appear.find((a) => kind(a) === 'translate')!;
    expect(clip.keyframes).toEqual([{ clipPath: 'inset(-8px 100% -8px -8px)' }, { clipPath: 'inset(-8px)' }]);
    expect(clip.options).toMatchObject({ duration: 340, delay: 100, composite: 'replace' });
    expect(lift.keyframes).toEqual([{ transform: 'translateY(4px)' }, { transform: 'translateY(0px)' }]);
    expect(lift.options).toMatchObject({ duration: 340, delay: 100, composite: 'add' });

    const [retype] = on(`${DAY}|d`);
    expect(retype.keyframes).toEqual([{ clipPath: 'inset(-8px 100% -8px -8px)' }, { clipPath: 'inset(-8px)' }]);
    expect(retype.options).toMatchObject({ duration: 300, delay: 0, composite: 'replace' });

    expect(on('group:inbox')).toEqual([]);
    expect(animations).toHaveLength(5);
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
    expect(frame.every((a) => a.options.delay === 80 && a.options.duration === 340)).toBe(true);
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

  it('retargets a mid-glide commit from where boxes are DRAWN: translates recreated, clip reveals kept', async () => {
    startPreview(<Canvas />, CACHED());
    land(FRESH());
    frame();
    frame(); // playing
    const first = live();
    const clips = first.filter((a) => kind(a) === 'clip');
    const translates = first.filter((a) => kind(a) === 'translate');
    advance(100);

    // a is drawn 40·(1 − 100/420) above its layout box right now.
    const aDrawn = row('a').getBoundingClientRect().top;
    await commit(() => useHarness.setState({ band: 50 }));

    expect(translates.every((a) => a.cancelled)).toBe(true);
    expect(clips.every((a) => !a.cancelled)).toBe(true);
    // The group was painted 50px higher than its new layout: it glides down for what is left of a move.
    const [group] = on('group:inbox');
    expect(group.keyframes[0]).toEqual({ transform: 'translate(0px, -50px)' });
    expect(group.options).toMatchObject({ duration: SETTLE.moveMs - 100, delay: 0, composite: 'add' });
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
    expect(late.map(kind).sort()).toEqual(['clip', 'translate']);

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
    frame(); // playing; the latest end is e's reveal, 100 + 340
    advance(100 + 340 + 50 - 1);
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
    expect(on('|new').map(kind).sort()).toEqual(['clip', 'translate']);
  });
});

describe('frames that move with their rows', () => {
  it('braindump: an appended row moves the quick-add card down with a glide', () => {
    startPreview(<Braindump />, [item('a'), item('b'), item('c')]);
    land([item('a'), item('b'), item('c'), item('d')]);
    const quickadd = live().filter((a) => a.target.getAttribute('data-testid') === 'quickadd');
    expect(quickadd).toHaveLength(1);
    expect(quickadd[0].keyframes).toEqual([{ transform: 'translate(0px, -30px)' }, { transform: 'translate(0px, 0px)' }]);
    expect(on('|d').map(kind).sort()).toEqual(['clip', 'translate']);
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
    expect(on('|z').map(kind).sort()).toEqual(['clip', 'translate']);
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
    expect(on(`${DAY}|late`).map(kind).sort()).toEqual(['clip', 'translate']);
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
