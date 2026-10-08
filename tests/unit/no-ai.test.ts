import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * lib/no-ai.ts beyond what the setup column's foot shows (ask-setup.test.tsx
 * renders the strip, its focus and its failures): the question kept from `?`
 * goes with the invitation it was kept for and comes back only with Undo,
 * and the phone's page says No AI without touching the desktop's braindump.
 */

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));

import { chooseNoAI } from '@/lib/no-ai';
import { ASK_CLAIMED_KEY, __resetKeptForTests, clearKeptQuestionState, keepQuestion, readKept, type KeptQuestion } from '@/lib/ask-pending';
import { getAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { useLookStore } from '@/lib/look-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { NOTHING_CONNECTED, SEED_USER_ID, seedAI } from './helpers/ai-fixtures';

/** The connection route: PATCH {hidden} answers `patchStatus`; GET says what the server last kept. */
let patchStatus = 200;
let serverHidden = false;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if ((init?.method ?? 'GET') === 'PATCH') {
    const body = JSON.parse(String(init?.body ?? 'null')) as { hidden?: boolean };
    if (patchStatus !== 200) return { ok: false, status: patchStatus, json: async () => ({ error: 'unavailable' }) };
    serverHidden = body.hidden === true;
    return { ok: true, status: 200, json: async () => ({ aiHidden: body.hidden }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      available: true,
      model: null,
      openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
      aiHidden: serverHidden,
    }),
  };
});

let unseed: () => void = () => {};

/** Undo on the strip's row, as the strip's button does it. */
async function pressUndo() {
  const entry = useUndoStripStore.getState().entry;
  expect(entry?.onUndo).toBeDefined();
  useUndoStripStore.getState().dismiss(entry!.id);
  entry!.onUndo!();
  await settle();
}

/** The write, the store's re-read on a failure, and the focus hand-off's polls. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  patchStatus = 200;
  serverHidden = false;
  toastMock.error.mockClear();
  unseed = seedAI(NOTHING_CONNECTED);
  useRailStore.getState().reset();
  useUndoStripStore.setState({ entry: null });
  useSidebarStore.setState({ askOpen: false, leftSidebarOpen: false });
  useLookStore.setState({ layout: 'classic' });
});

afterEach(() => {
  useUndoStripStore.setState({ entry: null });
  unseed();
  unseed = () => {};
  clearKeptQuestionState();
  localStorage.removeItem(ASK_CLAIMED_KEY);
  __resetKeptForTests();
  vi.unstubAllGlobals();
});

describe('No AI and the kept question', () => {
  function kept(): KeptQuestion {
    expect(keepQuestion('what should I do first')).toBe(true);
    return readKept(SEED_USER_ID) as KeptQuestion;
  }

  it('takes it with the invitation, and Undo puts the identical record back', async () => {
    const before = kept();
    await chooseNoAI();
    expect(getAICapabilities().askInvite).toBe(false);
    expect(readKept(SEED_USER_ID)).toBeNull();
    await pressUndo();
    expect(getAICapabilities().askInvite).toBe(true);
    expect(readKept(SEED_USER_ID)).toEqual(before);
  });

  it('once the row has gone, nothing brings it back, not even AI turned on again in Settings', async () => {
    kept();
    await chooseNoAI();
    useUndoStripStore.getState().dismiss();
    await useAIConnectionStore.getState().setAIHidden(false);
    expect(getAICapabilities().askInvite).toBe(true);
    expect(readKept(SEED_USER_ID)).toBeNull();
  });

  it("a choice that didn't take puts it back with the invitation", async () => {
    const before = kept();
    patchStatus = 503;
    await chooseNoAI();
    await settle();
    expect(toastMock.error).toHaveBeenCalled();
    expect(getAICapabilities().askInvite).toBe(true);
    expect(readKept(SEED_USER_ID)).toEqual(before);
  });

  it('an Undo the server refused takes it again with the row, and the retry brings it back', async () => {
    const before = kept();
    await chooseNoAI();
    patchStatus = 503;
    await pressUndo();
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(readKept(SEED_USER_ID)).toBeNull();
    patchStatus = 200;
    await pressUndo();
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(readKept(SEED_USER_ID)).toEqual(before);
  });

  it('with nothing kept, Undo keeps nothing', async () => {
    await chooseNoAI();
    await pressUndo();
    expect(readKept(SEED_USER_ID)).toBeNull();
  });
});

describe('No AI from the phone', () => {
  it("leaves the desktop's braindump as it was: the phone's strip already sits in its dock", async () => {
    await chooseNoAI({ phone: true });
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(useUndoStripStore.getState().entry).not.toBeNull();
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
  });

  it('the desktop still shows the dock the strip lives in', async () => {
    await chooseNoAI();
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
  });
});
