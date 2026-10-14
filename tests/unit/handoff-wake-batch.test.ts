import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APP_WAKE_PATH, handsOffToApp, wakeIfHandedOff } from '@/lib/handoff-wake';

/**
 * The browser half of the app wake (lib/handoff-wake.ts). A connected app's
 * wake starts a whole run, so a burst of hand-offs (make it so hands a lane
 * over at once) leaves as ONE call once it goes quiet. OpenClaw is never woken
 * from the browser: it hears its work on /api/agent/events.
 */

const fetchMock = vi.fn(async () => new Response('{}'));
const bodies = (path: string) =>
  fetchMock.mock.calls
    .filter((c) => (c as unknown[])[0] === path)
    .map((c) => JSON.parse(String(((c as unknown[])[1] as RequestInit).body)));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('handsOffToApp', () => {
  it('is an assignment to anyone but OpenClaw or a reserved value', () => {
    expect(handsOffToApp({ assignee: 'Claude' })).toBe(true);
    for (const no of [{ assignee: 'openclaw' }, { assignee: 'beacon' }, { assignee: '' }, { assignee: undefined }, {}, null]) {
      expect(handsOffToApp(no), JSON.stringify(no)).toBe(false);
    }
  });
});

describe('wakeIfHandedOff', () => {
  it('gathers a burst of app hand-offs into one call', () => {
    wakeIfHandedOff('a', { assignee: 'Claude' });
    vi.advanceTimersByTime(300);
    wakeIfHandedOff('b', { assignee: 'Claude' });
    wakeIfHandedOff('b', { assignee: 'Claude' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(bodies(APP_WAKE_PATH)).toEqual([{ itemIds: ['a', 'b'] }]);
  });

  it('never calls out for OpenClaw: it hears its own work', () => {
    wakeIfHandedOff('a', { assignee: 'openclaw' });
    vi.advanceTimersByTime(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wakes nothing for a take-back or an unrelated edit', () => {
    wakeIfHandedOff('a', { assignee: undefined });
    wakeIfHandedOff('a', { title: 'x' });
    vi.advanceTimersByTime(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
