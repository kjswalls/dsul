import { vi } from 'vitest';
import type { Item, Project } from '@/lib/planner-types';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * Shared bits for the far zoom and minimap view tests: a 2d context that
 * records what it is asked to draw (no canvas package is installed, so
 * getContext is spied, as zen-stage.test.tsx does), a canvas with a size, and
 * a hand-cranked requestAnimationFrame.
 */

export const TODAY = '2026-07-16';
export const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

export interface DrawLog {
  calls: { name: string; args: unknown[] }[];
  count: (name: string) => number;
  texts: () => string[];
}

export function spyCanvas(): DrawLog {
  const calls: DrawLog['calls'] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      return (...args: unknown[]) => {
        calls.push({ name: String(prop), args });
      };
    },
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    texts: () => calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0])),
  };
}

/** Give canvases a box (jsdom lays nothing out). */
export function sizeCanvases(w = 800, h = 600) {
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(w);
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(h);
}

/** requestAnimationFrame as a queue the test runs by hand. */
export function manualRaf() {
  let id = 0;
  const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    id += 1;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (n: number) => {
    queue.delete(n);
  });
  let now = 0;
  return {
    pending: () => queue.size,
    /** Run every queued frame once, `ms` after the last. */
    step(ms = 40) {
      now += ms;
      const due = [...queue.entries()];
      queue.clear();
      for (const [, cb] of due) cb(now);
    },
  };
}

export const task = (id: string, over: Partial<Item> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    project: 'Work',
    ...over,
  }) as unknown as Item;

export function seed(items: Item[], projects: Project[] = [{ id: 'p1', name: 'Work', emoji: '' } as Project]) {
  usePlannerStore.setState({
    items,
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    projects,
    routines: [],
    seasons: [],
    goals: [],
    userTimezone: 'UTC',
    selectedDate: asDate(TODAY),
    collectionsAvailable: true,
    goalsAvailable: true,
    userId: null,
  });
}

export function installDomShims() {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}
