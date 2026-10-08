import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * The waiting shimmer's phases (lib/planner-shimmer.ts): the look-only
 * preview's titles wait in a muted ink with one band of light crossing them,
 * and the fresh data lands with one last pass of light (Kirby's ask,
 * 2026-10-07). The paint is CSS (planner-shimmer-css.test.ts); this file
 * locks what the module decides:
 *
 *  - the wait starts on the preview's commit, in `on` mode only;
 *  - the landing chooses the light, the plain ease or nothing, by how long
 *    the ink had been on screen, and nothing under a veto, a hidden tab or
 *    another account;
 *  - a failed load or a dropped preview raises nothing and ends plainly;
 *  - a title that joins the wait late (scrolled back into view, mounted by a
 *    tab switch) has its mute and its sweep put on the clock before it paints;
 *  - every timer, listener and inline x goes with the phase, and with the
 *    last host.
 *
 * jsdom has no layout and no Web Animations: rects and getAnimations are
 * faked per element, and the clock (timers, rAF, performance.now) is fake.
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
import {
  AWAY_ATTR,
  LIGHT_AFTER_MS,
  MUTE_ANIMATION,
  RISE_ANIMATION,
  SHIMMER,
  SHIMMER_ATTR,
  SWEEP_ANIMATION,
  SYNC_BAR_ANIMATION,
  X_PROPERTY,
  endShimmer,
  inkDepth,
  registerShimmerHost,
  shimmerLandingCommitted,
  shimmerPhase,
  shimmerPreviewCommitted,
} from '@/lib/planner-shimmer';
import { usePlannerStore } from '@/lib/planner-store';

const U = 'user-a';
const READY = { userId: U, error: null, loadFailedUserId: null };

const attr = () => document.documentElement.getAttribute(SHIMMER_ATTR);
const depthRules = () =>
  [...document.head.querySelectorAll('style')].filter((s) => s.textContent?.includes('--planner-shimmer-depth'));

type FakeAnim = { animationName: string; startTime: number | null; effect: { updateTiming: ReturnType<typeof vi.fn> } };

function anim(name: string, startTime: number | null = null): FakeAnim {
  return { animationName: name, startTime, effect: { updateTiming: vi.fn() } };
}

/** A title with a fake box and fake running animations. */
function title(parent: Element, { left = 100, top = 100, anims = [] as FakeAnim[], mark = 'open' } = {}) {
  const el = document.createElement('p');
  el.setAttribute('data-row-title', mark);
  el.textContent = 'A row';
  el.getBoundingClientRect = () =>
    ({ left, top, right: left + 200, bottom: top + 20, width: 200, height: 20, x: left, y: top }) as DOMRect;
  (el as unknown as { getAnimations: () => FakeAnim[] }).getAnimations = () => anims;
  parent.appendChild(el);
  return el;
}

/** The preview's root and the canvas scope the fresh rows land in: one element, as view-root is. */
function canvas(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-settle-scope', 'canvas');
  root.setAttribute('data-preview', 'true');
  document.body.appendChild(root);
  return root;
}

function animationStart(target: Element, animationName: string, timeStamp = performance.now()) {
  const e = new Event('animationstart', { bubbles: true });
  Object.defineProperty(e, 'animationName', { value: animationName });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  target.dispatchEvent(e);
}

function startPreview() {
  usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true, items: [] });
  shimmerPreviewCommitted();
}

/** The success landing: isPreview and isLoading cleared in one set(), then the layout effect. */
function land(extra: Record<string, unknown> = {}, root?: HTMLElement) {
  usePlannerStore.setState({ isLoading: false, isPreview: false, ...extra });
  root?.removeAttribute('data-preview');
  shimmerLandingCommitted();
}

let release: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  });
  mode.value = 'on';
  usePlannerStore.setState({ ...READY, isLoading: false, isPreview: false, items: [] });
  release = registerShimmerHost();
});

afterEach(() => {
  release();
  cleanup();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduce-motion');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the wait', () => {
  it("starts on the preview's commit", () => {
    startPreview();
    expect(attr()).toBe('wait');
    expect(shimmerPhase()).toBe('wait');
  });

  it.each(['static', 'off'] as const)('never starts in %s mode', (m) => {
    mode.value = m;
    startPreview();
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
  });

  it.each([
    ["the app's animations switch", null],
    ['the OS reduced-motion setting', '(prefers-reduced-motion: reduce)'],
    ['forced colours', '(forced-colors: active)'],
  ])('never starts under %s: no attribute, no measures, no observer', async (_label, query) => {
    if (query === null) document.documentElement.setAttribute('data-reduce-motion', 'true');
    else {
      const real = window.matchMedia;
      vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ ...real(q), matches: q === query }));
    }
    const root = canvas();
    const t = title(root, { left: 240 });
    const read = vi.spyOn(t, 'getBoundingClientRect');
    startPreview();
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
    // The CSS shows nothing under a veto, so nothing is done for it either.
    animationStart(t, SWEEP_ANIMATION);
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    const mute = anim(MUTE_ANIMATION, null);
    title(root, { anims: [mute] });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(t.style.getPropertyValue(X_PROPERTY)).toBe('');
    expect(mute.startTime).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at the next measure when a veto arrives mid-wait', () => {
    const root = canvas();
    const t = title(root, { left: 240 });
    startPreview();
    animationStart(t, SWEEP_ANIMATION);
    vi.advanceTimersByTime(16);
    expect(t.style.getPropertyValue(X_PROPERTY)).toBe('240px');
    // The animations switch, synced from the server: the CSS drops the shimmer
    // at once, and the next scroll ends the phase instead of measuring for it.
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    const read = vi.spyOn(t, 'getBoundingClientRect');
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(read).not.toHaveBeenCalled();
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
    expect(t.style.getPropertyValue(X_PROPERTY)).toBe('');
  });

  it('measures each started title in the next frame, and marks one outside the viewport away', () => {
    const root = canvas();
    startPreview();
    const seen = title(root, { left: 240, top: 100 });
    const below = title(root, { left: 240, top: window.innerHeight + 400 });
    animationStart(seen, SWEEP_ANIMATION);
    animationStart(below, SWEEP_ANIMATION);
    expect(seen.style.getPropertyValue('--planner-shimmer-x')).toBe('');
    vi.advanceTimersByTime(16);
    expect(seen.style.getPropertyValue('--planner-shimmer-x')).toBe('240px');
    expect(seen.hasAttribute(AWAY_ATTR)).toBe(false);
    expect(below.hasAttribute(AWAY_ATTR)).toBe(true);
    expect(below.style.getPropertyValue('--planner-shimmer-x')).toBe('');

    // Scrolled into view: measured again, and back.
    below.getBoundingClientRect = () =>
      ({ left: 240, top: 300, right: 440, bottom: 320, width: 200, height: 20, x: 240, y: 300 }) as DOMRect;
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(below.hasAttribute(AWAY_ATTR)).toBe(false);
    expect(below.style.getPropertyValue('--planner-shimmer-x')).toBe('240px');
  });

  it('the end leaves no title marked away, and none carrying an inline x', () => {
    const root = canvas();
    startPreview();
    const below = title(root, { top: window.innerHeight + 400 });
    const seen = title(root, { left: 240 });
    animationStart(below, SWEEP_ANIMATION);
    animationStart(seen, SWEEP_ANIMATION);
    vi.advanceTimersByTime(16);
    expect(below.hasAttribute(AWAY_ATTR)).toBe(true);
    expect(seen.style.getPropertyValue(X_PROPERTY)).toBe('240px');
    endShimmer();
    expect(below.hasAttribute(AWAY_ATTR)).toBe(false);
    expect(seen.style.getPropertyValue(X_PROPERTY)).toBe('');
    expect(seen.getAttribute('style') ?? '').toBe('');
  });

  it('a title scrolled back into view joins the clock in the measure that un-marks it', () => {
    const root = canvas();
    startPreview();
    const seen = title(root, { anims: [anim(MUTE_ANIMATION, 1000), anim(SWEEP_ANIMATION, 1000)] });
    animationStart(seen, SWEEP_ANIMATION, 1000);
    // Below the fold, then scrolled into view after the clock is set: away
    // had dropped its animations, so the ones it comes back with are new.
    const mute = anim(MUTE_ANIMATION, null);
    const sweep = anim(SWEEP_ANIMATION, null);
    const other = anim('row-pulse', null);
    const below = title(root, { top: window.innerHeight + 400, anims: [mute, sweep, other] });
    animationStart(below, SWEEP_ANIMATION, 1004);
    vi.advanceTimersByTime(16);
    expect(below.hasAttribute(AWAY_ATTR)).toBe(true);
    expect(mute.startTime).toBeNull();

    below.getBoundingClientRect = () =>
      ({ left: 240, top: 300, right: 440, bottom: 320, width: 200, height: 20, x: 240, y: 300 }) as DOMRect;
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(below.hasAttribute(AWAY_ATTR)).toBe(false);
    // Both on the clock, so it shows the waiting ink and the band where its
    // neighbours do, not full ink through a fresh 300ms delay. Nothing else moves.
    expect(mute.startTime).toBe(1000);
    expect(sweep.startTime).toBe(1000);
    expect(other.startTime).toBeNull();

    // A title that stayed in view is not touched again.
    const stay = vi.spyOn(seen as unknown as { getAnimations: () => FakeAnim[] }, 'getAnimations');
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(stay).not.toHaveBeenCalled();
  });

  it('a title mounted mid-wait under a preview root joins the clock before it paints', async () => {
    const root = canvas();
    startPreview();
    animationStart(title(root, { anims: [anim(SWEEP_ANIMATION, 1000)] }), SWEEP_ANIMATION, 1000);

    // A tab switch: a new list mounts in one commit. The observer's records
    // arrive as a microtask, before the browser renders.
    const list = document.createElement('section');
    list.setAttribute('data-preview', 'true');
    const mute = anim(MUTE_ANIMATION, null);
    const sweep = anim(SWEEP_ANIMATION, null);
    const fresh = title(list, { left: 64, anims: [mute, sweep] });
    const offscreen = anim(MUTE_ANIMATION, null);
    const deep = title(list, { left: 64, top: window.innerHeight + 900, anims: [offscreen] });
    // Outside any preview root: not a waiting title at all.
    const elsewhere = anim(MUTE_ANIMATION, null);
    const loose = title(document.createElement('div'), { anims: [elsewhere] });
    document.body.append(list, loose.parentElement!);
    await Promise.resolve();

    expect(fresh.style.getPropertyValue(X_PROPERTY)).toBe('64px');
    expect(mute.startTime).toBe(1000);
    expect(sweep.startTime).toBe(1000);
    // Below the fold it is marked away (no animations to hold), and the loose one is left alone.
    expect(deep.hasAttribute(AWAY_ATTR)).toBe(true);
    expect(offscreen.startTime).toBeNull();
    expect(elsewhere.startTime).toBeNull();
    expect(loose.style.getPropertyValue(X_PROPERTY)).toBe('');
  });

  it('a title joining before any sweep has reported takes the start of one already running', async () => {
    const root = canvas();
    // Styled by the preview's own commit, inside the delay: running, not yet started.
    title(root, { anims: [anim(SWEEP_ANIMATION, 640)] });
    startPreview();
    const mute = anim(MUTE_ANIMATION, null);
    const fresh = title(document.createElement('div'), { anims: [mute] });
    root.appendChild(fresh.parentElement!);
    await Promise.resolve();
    expect(mute.startTime).toBe(640);
  });

  it('a title joining before any sweep has reported, with no other title left, takes the sync bar’s start', async () => {
    // The phone: the preview commits on Today, and a tab switch inside the
    // delay replaces every title. The sync line sits outside the tab.
    const bar = document.createElement('span');
    bar.className = 'planner-sync-line__bar';
    (bar as unknown as { getAnimations: () => FakeAnim[] }).getAnimations = () => [anim(SYNC_BAR_ANIMATION, 640)];
    document.body.appendChild(bar);
    const today = canvas();
    const gone = title(today, { anims: [anim(SWEEP_ANIMATION, 640)] });
    startPreview();
    gone.remove();
    const tab = document.createElement('section');
    tab.setAttribute('data-preview', 'true');
    const mute = anim(MUTE_ANIMATION, null);
    const sweep = anim(SWEEP_ANIMATION, null);
    title(tab, { left: 24, anims: [mute, sweep] });
    document.body.appendChild(tab);
    await Promise.resolve();
    // On the clock in its first frame, so it never shows full ink through its own delay.
    expect(mute.startTime).toBe(640);
    expect(sweep.startTime).toBe(640);

    // And it is the clock: a sweep that reports later is moved onto it.
    const late = anim(SWEEP_ANIMATION, 900);
    animationStart(title(tab, { anims: [late] }), SWEEP_ANIMATION, 900);
    expect(late.startTime).toBe(640);
  });

  it('looks past a waiting title whose sweep has no start yet', async () => {
    const root = canvas();
    title(root, { anims: [anim(SWEEP_ANIMATION, null)] });
    title(root, { anims: [anim(SWEEP_ANIMATION, 640)] });
    startPreview();
    const mute = anim(MUTE_ANIMATION, null);
    const fresh = title(document.createElement('div'), { anims: [mute] });
    root.appendChild(fresh.parentElement!);
    await Promise.resolve();
    expect(mute.startTime).toBe(640);
  });

  it('stops watching for mounts with the wait', async () => {
    const root = canvas();
    startPreview();
    animationStart(title(root, { anims: [anim(SWEEP_ANIMATION, 1000)] }), SWEEP_ANIMATION, 1000);
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land({}, root);
    root.setAttribute('data-preview', 'true');
    const mute = anim(MUTE_ANIMATION, null);
    title(root, { anims: [mute] });
    await Promise.resolve();
    expect(mute.startTime).toBeNull();
  });

  it('holds a sweep or the sync bar that starts later to the first pass: one clock', () => {
    const root = canvas();
    startPreview();
    const first = anim(SWEEP_ANIMATION, 1000);
    const a = title(root, { anims: [first] });
    animationStart(a, SWEEP_ANIMATION, 1000);
    expect(first.startTime).toBe(1000);

    // In the same frame: already on the clock, and never read (a read flushes style).
    const same = title(root, { anims: [anim(SWEEP_ANIMATION, 1000)] });
    const read = vi.spyOn(same as unknown as { getAnimations: () => FakeAnim[] }, 'getAnimations');
    animationStart(same, SWEEP_ANIMATION, 1004);
    expect(read).not.toHaveBeenCalled();

    // A title that started later and the sync line's bar: moved onto it, the
    // title's mute with its sweep (a later mute would ease down out of step).
    const late = anim(SWEEP_ANIMATION, 1900);
    const lateMute = anim(MUTE_ANIMATION, 1900);
    animationStart(title(root, { anims: [lateMute, late] }), SWEEP_ANIMATION, 1900);
    expect(late.startTime).toBe(1000);
    expect(lateMute.startTime).toBe(1000);
    const bar = document.createElement('span');
    const barAnim = anim(SYNC_BAR_ANIMATION, 2100);
    (bar as unknown as { getAnimations: () => FakeAnim[] }).getAnimations = () => [barAnim];
    document.body.appendChild(bar);
    animationStart(bar, SYNC_BAR_ANIMATION, 2100);
    expect(barAnim.startTime).toBe(1000);
  });
});

describe('the landing', () => {
  it('inside the delay: nothing, and the titles are text', () => {
    startPreview();
    vi.advanceTimersByTime(SHIMMER.delayMs - 50);
    land();
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
  });

  it('before the ink settled: the plain ease, from the ink on screen', () => {
    const root = canvas();
    title(root);
    startPreview();
    vi.advanceTimersByTime(400);
    land({}, root);
    expect(attr()).toBe('ease');
    const rules = depthRules();
    expect(rules).toHaveLength(1);
    // A rule for the titles, never a property on the root.
    expect(rules[0].textContent).toContain("[data-row-title='open'] {");
    expect(rules[0].textContent).toContain(`--planner-shimmer-depth: ${Math.round(inkDepth(400) * 1000) / 10}%;`);
    expect(document.documentElement.style.getPropertyValue('--planner-shimmer-depth')).toBe('');

    // The rise starts with the next frame; it ends its own run plus slack later.
    animationStart(root.firstElementChild!, RISE_ANIMATION);
    vi.advanceTimersByTime(SHIMMER.easeMs + SHIMMER.slackMs - 1);
    expect(attr()).toBe('ease');
    vi.advanceTimersByTime(1);
    expect(attr()).toBeNull();
    expect(depthRules()).toHaveLength(0);
  });

  it('once the ink had settled: the pass of light, each rise delayed by its x', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    const root = canvas();
    const leftRise = anim(RISE_ANIMATION);
    const midRise = anim(RISE_ANIMATION);
    const midSweep = anim(SWEEP_ANIMATION);
    const rightRise = anim(RISE_ANIMATION);
    title(root, { left: 0, anims: [leftRise] });
    title(root, { left: 720, anims: [midSweep, midRise] });
    title(root, { left: 1440, anims: [rightRise] });
    const away = title(root, { left: 720, top: 5000, anims: [anim(RISE_ANIMATION)] });
    startPreview();
    animationStart(away, SWEEP_ANIMATION);
    vi.advanceTimersByTime(16);
    expect(away.hasAttribute(AWAY_ATTR)).toBe(true);
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land({}, root);
    expect(attr()).toBe('land');
    // Full waiting ink to rise from: no depth rule.
    expect(depthRules()).toHaveLength(0);

    expect(leftRise.effect.updateTiming).not.toHaveBeenCalled();
    expect(midRise.effect.updateTiming).toHaveBeenCalledWith({ delay: SHIMMER.spreadMs / 2 });
    expect(rightRise.effect.updateTiming).toHaveBeenCalledWith({ delay: SHIMMER.spreadMs });
    // Only the rise is retimed, and a title outside the viewport sits it out.
    expect(midSweep.effect.updateTiming).not.toHaveBeenCalled();
    expect((away as unknown as { getAnimations: () => FakeAnim[] }).getAnimations()[0].effect.updateTiming).not.toHaveBeenCalled();

    // The end follows the first rise's own start time, however late the frame.
    vi.advanceTimersByTime(200);
    animationStart(root.firstElementChild!, RISE_ANIMATION, performance.now() - 40);
    vi.advanceTimersByTime(SHIMMER.spreadMs + SHIMMER.riseMs + SHIMMER.slackMs - 41);
    expect(attr()).toBe('land');
    vi.advanceTimersByTime(1);
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
  });

  it('with no rise ever reported, the backstop ends it', () => {
    const root = canvas();
    title(root);
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land({}, root);
    expect(attr()).toBe('land');
    vi.advanceTimersByTime(SHIMMER.backstopMs - 1);
    expect(attr()).toBe('land');
    vi.advanceTimersByTime(1);
    expect(attr()).toBeNull();
  });

  it('a failed load raises nothing: the planner is empty, so the ink returns plainly', () => {
    const root = canvas();
    const t = title(root);
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    // emptyPlannerData in the same set(): the rows unmount with the commit.
    usePlannerStore.setState({ isLoading: false, isPreview: false, error: 'offline', loadFailedUserId: U });
    expect(attr()).toBe('ease');
    t.remove();
    root.removeAttribute('data-preview');
    shimmerLandingCommitted();
    expect(attr()).toBeNull();
    expect(depthRules()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a dropped preview raises nothing either', () => {
    const root = canvas();
    const t = title(root);
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    // dropPreview: still loading, the cached rows gone.
    usePlannerStore.setState({ isPreview: false });
    expect(attr()).toBe('ease');
    t.remove();
    shimmerLandingCommitted();
    expect(attr()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('another account landing ends it plainly', () => {
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land({ userId: 'user-b' });
    expect(attr()).toBeNull();
    expect(shimmerPhase()).toBeNull();
  });

  it("the app's animations switch, turned off mid-wait, ends it plainly", () => {
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    land();
    expect(attr()).toBeNull();
  });

  it.each([
    ['the OS reduced-motion setting', '(prefers-reduced-motion: reduce)'],
    ['forced colours', '(forced-colors: active)'],
  ])('%s ends it plainly', (_label, query) => {
    const real = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ ...real(q), matches: q === query }));
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land();
    expect(attr()).toBeNull();
  });

  it('a hidden tab ends it plainly', () => {
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    land();
    expect(attr()).toBeNull();
  });

  it('a landing the subscription missed ends in the layout effect', () => {
    startPreview();
    release();
    release = () => {};
    // The last host went and took the phase with it; a new one mounts under
    // the preview and lands before its subscription is up.
    shimmerPreviewCommitted();
    usePlannerStore.setState({ isLoading: false, isPreview: false });
    expect(attr()).toBe('wait');
    shimmerLandingCommitted();
    expect(attr()).toBeNull();
  });
});

describe('the hosts', () => {
  it("the last host's cleanup ends any phase, its timers and its listeners", () => {
    const root = canvas();
    const t = title(root);
    startPreview();
    vi.advanceTimersByTime(LIGHT_AFTER_MS + 100);
    land({}, root);
    expect(attr()).toBe('land');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const second = registerShimmerHost();
    release();
    // One host still up: nothing ends.
    expect(attr()).toBe('land');
    second();
    expect(attr()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // No listener survives: a rise starting now arms nothing.
    animationStart(t, RISE_ANIMATION);
    expect(vi.getTimerCount()).toBe(0);
    // And no subscription: a new preview's end changes nothing.
    usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true });
    usePlannerStore.setState({ isLoading: false, isPreview: false });
    expect(attr()).toBeNull();
    release = registerShimmerHost();
  });

  it('cancels a queued measure with the phase', () => {
    const root = canvas();
    startPreview();
    const t = title(root, { left: 240 });
    animationStart(t, SWEEP_ANIMATION);
    endShimmer();
    vi.advanceTimersByTime(16);
    expect(t.style.getPropertyValue('--planner-shimmer-x')).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the ink curve', () => {
  it('is still for the delay, settled by its end, and only ever goes down', () => {
    expect(inkDepth(0)).toBe(0);
    expect(inkDepth(SHIMMER.delayMs)).toBe(0);
    expect(inkDepth(LIGHT_AFTER_MS)).toBe(1);
    expect(inkDepth(5000)).toBe(1);
    let last = 0;
    for (let t = SHIMMER.delayMs; t <= LIGHT_AFTER_MS; t += 8) {
      const d = inkDepth(t);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    // --ease-roll is slow at both ends: half way down at half time, and a
    // landing a quarter of the way in catches the ink only a little way down,
    // so its plain ease up is a small step, not a dip and a pop.
    expect(inkDepth(SHIMMER.delayMs + SHIMMER.inkMs / 2)).toBeCloseTo(0.5, 2);
    expect(inkDepth(SHIMMER.delayMs + SHIMMER.inkMs / 4)).toBeLessThan(0.2);
  });
});

describe('SettleHost', () => {
  it('starts the wait on the preview commit and ends it with nothing to raise', () => {
    release();
    release = () => {};
    usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true });
    const view = render(<SettleHost />);
    expect(attr()).toBe('wait');
    act(() => vi.advanceTimersByTime(LIGHT_AFTER_MS + 100));
    act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
    // The subscriber chose the light; the landing's layout effect found no title.
    expect(attr()).toBeNull();
    view.unmount();
  });

  it('unmounting mid-wait ends it', () => {
    release();
    release = () => {};
    usePlannerStore.setState({ ...READY, isLoading: true, isPreview: true });
    const view = render(<SettleHost />);
    expect(attr()).toBe('wait');
    view.unmount();
    expect(attr()).toBeNull();
  });
});
