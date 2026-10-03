import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * Ask's History and conversation views (AI step 2a, checkpoint C4), in the
 * real RightRail over the real stores, with the conversations API and the
 * chat transport faked (tests/unit/helpers/conversations-fakes.ts).
 *
 *  - History: Starred, Today, Yesterday, Earlier (a starred one only under
 *    Starred); rows by live item title, ☐ for an item's; search from two
 *    characters after 250ms; Escape clears text, then goes back; the empty,
 *    error and paged states.
 *  - A conversation's ⌄: Rename (Escape restores, and goes nowhere), Star,
 *    Delete with its confirm (and OpenClaw's sentence when it ever answered).
 *  - The gone state, the transcript (bubbles, Copy, dividers, status lines,
 *    Stop, Jump to latest) and the new-chat empty state with its four chips.
 *
 * Ask home is stubbed: C3 owns it, and only its header (the rail's) is C4's.
 */

vi.mock('@/components/ai/ask/ask-home', () => ({ AskHome: () => <div data-testid="ask-home-stub" /> }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: toasts.error, dismiss: vi.fn(), success: vi.fn() }),
}));

import { RightRail } from '@/components/ai/rail/right-rail';
import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { ItemConversationMenu, CONVERSATION_COPY, deleteDescription } from '@/components/ai/ask/conversation-title-menu';
import { answererDividerCopy, answererDividers, REPLY_PROSE } from '@/components/ai/chat-transcript';
import { ItemConversation } from '@/components/ai/item-conversation';
import { ChatComposer } from '@/components/ai/chat-composer';
import { useRailStore, type AskView } from '@/lib/rail-store';
import { useUIStore } from '@/lib/ui-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { chatErrorCopy } from '@/lib/chat-errors';
import { clockTime } from '@/lib/format-chat-timestamp';
import { historyTime } from '@/lib/conversation-summary';
import type { ConversationSummary, StoredMessage } from '@/lib/conversation-types';
import type { TaskItem } from '@/lib/planner-types';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';
import {
  fail,
  fakeApi,
  fakeTransport,
  flush,
  hangs,
  summary,
  type FakeApi,
  type FakeTransport,
} from './helpers/conversations-fakes';

/* ── fixtures ────────────────────────────────────────────────────────── */

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'task',
  id: 't1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
  ...over,
});
const DENTIST = task();

/** Friday 2 October 2026, 14:00 UTC (the user's zone here). */
const NOW = Date.parse('2026-10-02T14:00:00.000Z');

/** A thread's stored messages, in order. */
function stored(...ms: (Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role'>)[]): StoredMessage[] {
  return ms.map((m, i) => ({
    pos: i,
    content: '',
    status: 'complete',
    errorCode: null,
    replyTo: null,
    answerer: m.role === 'assistant' ? 'model' : null,
    model: null,
    createdAt: '2026-10-02T09:00:00.000Z',
    ...m,
  }));
}

/* ── environment ─────────────────────────────────────────────────────── */

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let api: FakeApi;
let transport: FakeTransport;
let unseed: () => void = () => {};
const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => {}) };

beforeEach(() => {
  api = fakeApi();
  transport = fakeTransport();
  configureConversations({ api: api.api, transport: transport.transport });
  clearChatState();
  // A latch reset() keeps on purpose (saving off stays off for the page).
  useConversationsStore.setState({ saving: 'unknown' });
  usePlannerStore.setState({
    items: [DENTIST],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypes: [],
    userTimezone: 'UTC',
    isLoading: false,
    userId: 'u1',
  } as never);
  useUIStore.setState({ activeDialog: null, displacedItemId: null, confirmRequest: null } as never);
  useProposalStore.getState().dismiss();
  toasts.error.mockClear();
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  unseed = seedAI(CONNECTED_MODEL);
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  vi.useRealTimers();
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
  useProposalStore.getState().dismiss();
  useUIStore.setState({ activeDialog: null, displacedItemId: null, confirmRequest: null } as never);
});

/* ── helpers ─────────────────────────────────────────────────────────── */

const renderRail = () =>
  render(
    <div data-rail="">
      <RightRail visible overlays={false} />
      <ConfirmDialog />
    </div>
  );

const rail = () => useRailStore.getState();
const stack = () => rail().stacks.desktop;
const push = (view: AskView) => act(() => rail().push('desktop', view));
const view = () => document.querySelector('[data-rail-view]') as HTMLElement;
const heading = () => view().querySelector<HTMLElement>('[data-ask-heading]');
const askBox = () => view().querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement;

/** Every timer queued so far (a deferred focus, a debounce under 10ms) has run. */
const timers = (ms = 10) => act(() => new Promise((r) => setTimeout(r, ms)));
const settle = () => act(() => flush());
/**
 * Two rounds: a menu's close runs its action on a timer, and what that
 * action renders (inside act, only once act ends) focuses on a timer of its own.
 */
const hops = async () => {
  await timers();
  await timers();
};

/** Escape from wherever focus is, as a real keypress bubbles from there. */
function pressEscapeHere() {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? window).dispatchEvent(event);
  });
  return event;
}

/** Summaries this browser already holds (History's first page, say). */
function hold(...rows: ConversationSummary[]) {
  act(() =>
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, ...Object.fromEntries(rows.map((r) => [r.id, r])) },
    }))
  );
}

/** Open a Radix menu the way a pointer does. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

/** A saved conversation, open in Ask with its transcript loaded. */
async function openSaved(row: ConversationSummary, messages: StoredMessage[] = []) {
  api.rows.set(row.id, row);
  api.answer.thread = (id) => (id === row.id ? { ok: true, value: { conversation: row, messages, hasEarlier: false } } : undefined);
  hold(row);
  push({ kind: 'conversation', id: row.id });
  renderRail();
  await settle();
}

/**
 * A real browser's confirm: its content leaves on a 200ms animation, and
 * Radix's Presence holds it mounted, its button still focused, until
 * `animationend`. jsdom runs no CSS, so the alertdialog is given an animation
 * named by its data-state, and the end is fired by hand (`end`). Without this
 * the dialog unmounts at once and a fix that only works then looks right.
 */
function animatedConfirm() {
  const real = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const style = real(el, pseudo);
    if (!(el instanceof HTMLElement) || el.getAttribute('role') !== 'alertdialog') return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === 'animationName') return el.dataset.state === 'closed' ? 'confirm-out' : 'confirm-in';
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  return {
    end() {
      const node = document.querySelector('[role="alertdialog"]');
      const event = new Event('animationend');
      Object.defineProperty(event, 'animationName', { value: 'confirm-out' });
      act(() => void node?.dispatchEvent(event));
    },
    restore: () => spy.mockRestore(),
  };
}

/** A saved item conversation, held here with its transcript: its item's index points at it. */
function holdItemThread(id: string, itemId: string, messages: ChatMessage[]) {
  act(() =>
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, [id]: summary({ id, itemId, title: 'Book the dentist' }) },
      itemIndex: { ...s.itemIndex, [itemId]: id },
      threads: {
        ...s.threads,
        [id]: {
          id,
          itemId,
          draftTitle: null,
          saved: true,
          load: 'loaded',
          hasEarlier: false,
          streaming: false,
          typing: false,
          fetchedAt: Date.now(),
          messages,
        },
      } as never,
    }))
  );
}

/** A message as the store holds it. */
const held = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({
  content: '',
  status: 'complete',
  errorCode: null,
  replyTo: null,
  answerer: m.role === 'assistant' ? 'model' : null,
  model: null,
  createdAt: Date.now(),
  pos: 0,
  sync: 'saved',
  ...m,
});

/* ── History ─────────────────────────────────────────────────────────── */

describe('History', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  const ROWS = {
    starred: summary({ id: 's1', title: 'Lisbon in May', starred: true, lastMessageAt: '2026-10-02T13:00:00.000Z' }),
    today: summary({
      id: 'c1',
      title: 'Plan my day',
      lastMessageAt: '2026-10-02T08:02:00.000Z',
      changes: { added: 2, steps: 0, moved: 1, changed: 0 },
    }),
    item: summary({ id: 'c2', itemId: 't1', title: 'Stored title', lastMessageAt: '2026-10-01T18:00:00.000Z' }),
    earlier: summary({ id: 'c3', title: 'Old chat', lastMessageAt: '2026-09-24T12:00:00.000Z' }),
  };

  function listPage(nextCursor: string | null = null) {
    api.answer.list = (o) =>
      o?.cursor
        ? undefined
        : {
            ok: true,
            value: { conversations: [ROWS.today, ROWS.item, ROWS.earlier], starred: [ROWS.starred], nextCursor },
          };
  }

  const groups = () =>
    Array.from(view().querySelectorAll<HTMLElement>('[data-history-group]')).map((g) => ({
      key: g.dataset.historyGroup,
      label: g.querySelector('h3')?.textContent,
      rows: within(g)
        .queryAllByTestId('history-row')
        .map((r) => r.querySelector('.truncate')?.textContent),
    }));

  it('opens from Ask home’s header, and Back hands focus to the button', async () => {
    renderRail();
    const button = screen.getByRole('button', { name: 'History' });
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    act(() => button.focus());
    fireEvent.click(button);
    expect(stack()).toEqual([{ kind: 'history', returnFocus: 'history' }]);
    await timers();
    expect(document.activeElement).toBe(heading());
    expect(heading()).toHaveTextContent('History');
    // Its header carries "+" and no History of its own.
    expect(within(view()).queryByRole('button', { name: 'History' })).toBeNull();
    expect(within(view()).getByRole('button', { name: 'New chat' })).toBeInTheDocument();

    pressEscapeHere();
    expect(stack()).toEqual([]);
    await timers();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'History' }));
  });

  it('groups Starred, Today, Yesterday and Earlier, a starred one only under Starred', async () => {
    listPage();
    push({ kind: 'history' });
    renderRail();
    await settle();
    expect(groups()).toEqual([
      { key: 'starred', label: 'Starred', rows: ['Lisbon in May'] },
      { key: 'today', label: 'Today', rows: ['Plan my day'] },
      // An item's conversation by its item's LIVE title.
      { key: 'yesterday', label: 'Yesterday', rows: ['Book the dentist'] },
      { key: 'earlier', label: 'Earlier', rows: ['Old chat'] },
    ]);
  });

  it('says what each changed, with its time and glyph', async () => {
    listPage();
    push({ kind: 'history' });
    renderRail();
    await settle();
    const rows = screen.getAllByTestId('history-row');
    const [starred, today, item, earlier] = rows;
    expect(within(today).getByTestId('history-second-line')).toHaveTextContent('Moved 1 item · Added 2 items');
    expect(today).toHaveTextContent('8:02');
    expect(within(item).getByTestId('history-second-line')).toHaveTextContent('Item conversation · no changes');
    expect(item).toHaveTextContent('Thu');
    expect(earlier).toHaveTextContent('Sep 24');
    expect(starred.querySelector('[data-glyph]')).toHaveAttribute('data-glyph', 'general');
    expect(item.querySelector('[data-glyph]')).toHaveAttribute('data-glyph', 'item');
    // ☑ once the item is done, read live.
    act(() => usePlannerStore.setState({ items: [task({ status: 'completed' })] }));
    expect(screen.getAllByTestId('history-row')[2].querySelector('[data-glyph]')).toHaveAttribute('data-glyph', 'item-done');
    // Its item deleted: the stored title, and the line says so.
    act(() => usePlannerStore.setState({ items: [] }));
    const gone = screen.getAllByTestId('history-row')[2];
    expect(gone).toHaveTextContent('Stored title');
    expect(within(gone).getByTestId('history-second-line')).toHaveTextContent('Item conversation · item deleted');
  });

  it("opens an item's conversation as its item, and a general one over History", async () => {
    listPage();
    push({ kind: 'history' });
    renderRail();
    await settle();
    fireEvent.click(screen.getAllByTestId('history-row')[2]);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 't1' } });
    expect(rail().pendingReveal).toEqual({ itemId: 't1' });
    expect(stack()).toEqual([{ kind: 'history' }]);

    act(() => useUIStore.getState().closeDialog());
    fireEvent.click(screen.getAllByTestId('history-row')[1]);
    expect(stack()).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1', returnFocus: 'conv:c1' }]);
  });

  it('rings a focused row, as every other Ask row does, not only tints it', async () => {
    listPage();
    push({ kind: 'history' });
    renderRail();
    await settle();
    for (const row of screen.getAllByTestId('history-row')) {
      expect(row).toHaveClass('hover:bg-accent', 'focus-visible:ring-2', 'focus-visible:ring-ring', 'focus-visible:outline-none');
      expect(row.className).not.toMatch(/focus-visible:bg-/);
    }
  });

  it('says it is loading in words, with the skeleton rows hidden', async () => {
    let release: () => void = () => {};
    api.answer.list = () => new Promise((r) => (release = () => r(undefined)));
    push({ kind: 'history' });
    renderRail();
    try {
      const list = screen.getByTestId('history-list');
      expect(within(list).getByText('Loading conversations…')).toHaveClass('sr-only');
      expect(list.querySelector('[aria-label="Loading"], [aria-busy]')).toBeNull();
    } finally {
      await act(async () => {
        release();
        await flush();
      });
    }
  });

  it('comes back from a conversation as it was left: the search, its results and the scroll', async () => {
    listPage();
    api.rows.set('c1', ROWS.today);
    api.answer.thread = (id) => (id === 'c1' ? { ok: true, value: { conversation: ROWS.today, messages: [], hasEarlier: false } } : undefined);
    api.answer.search = () => ({ ok: true, value: [{ ...ROWS.today, matched: 'title', snippet: null, itemTitle: null }] });
    push({ kind: 'history' });
    renderRail();
    await settle();
    fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'plan' } });
    await timers(300);
    await settle();
    const list = screen.getByTestId('history-list');
    list.scrollTop = 120;
    fireEvent.scroll(list);
    const row = screen.getByTestId('history-row');
    act(() => row.focus());
    fireEvent.click(row);
    await settle();
    expect(stack()).toEqual([
      { kind: 'history', memo: { q: 'plan', scrollTop: 120 } },
      { kind: 'conversation', id: 'c1', returnFocus: 'conv:c1' },
    ]);

    fireEvent.click(screen.getByTestId('rail-back'));
    await settle();
    await timers();
    expect(screen.getByTestId('history-search')).toHaveValue('plan');
    expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Plan my day'] }]);
    // Not asked again: the results it was opened from are the ones on screen.
    await timers(300);
    await settle();
    expect(api.api.search).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('history-list').scrollTop).toBe(120);
    expect(document.activeElement).toBe(screen.getByTestId('history-row'));
  });

  it('keeps the row Back hands focus to in sight, scrolling only its list', async () => {
    listPage();
    api.rows.set('c1', ROWS.today);
    api.answer.thread = (id) => (id === 'c1' ? { ok: true, value: { conversation: ROWS.today, messages: [], hasEarlier: false } } : undefined);
    push({ kind: 'history' });
    renderRail();
    await settle();
    fireEvent.click(screen.getAllByTestId('history-row')[1]);
    await settle();
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    // The list's box ends at 300, and the row sits below it.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const at = this.dataset.testid === 'history-list' ? [0, 300] : this.dataset.askFocus === 'conv:c1' ? [400, 440] : null;
      return at === null
        ? realRect.call(this)
        : ({ top: at[0], bottom: at[1], left: 0, right: 0, width: 0, height: at[1] - at[0], x: 0, y: at[0] } as DOMRect);
    };
    try {
      fireEvent.click(screen.getByTestId('rail-back'));
      await settle();
      await timers();
      expect(document.activeElement).toHaveAttribute('data-ask-focus', 'conv:c1');
      expect(screen.getByTestId('history-list').scrollTop).toBe(140);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
    }
  });

  // A click on "‹ History", or Enter on it (a button's Enter is that same
  // click), leaves focus on the button. React keeps that button from the
  // conversation's header to History's, where it now reads "‹ Ask", so focus
  // left there would make a second Enter go home instead of back to the row.
  it.each([
    ['a row of its groups', false],
    ['a search result', true],
  ])('hands focus from the pressed Back to %s, as Escape does', async (_label, search) => {
    listPage();
    api.rows.set('c1', ROWS.today);
    api.answer.thread = (id) => (id === 'c1' ? { ok: true, value: { conversation: ROWS.today, messages: [], hasEarlier: false } } : undefined);
    api.answer.search = () => ({ ok: true, value: [{ ...ROWS.today, matched: 'title', snippet: null, itemTitle: null }] });
    push({ kind: 'history' });
    renderRail();
    await settle();
    if (search) {
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'plan' } });
      await timers(300);
      await settle();
    }
    const opener = () => view().querySelector<HTMLElement>('[data-ask-focus="conv:c1"]') as HTMLElement;
    act(() => opener().focus());
    fireEvent.click(opener());
    await settle();
    await timers();
    expect(stack().at(-1)).toMatchObject({ kind: 'conversation', id: 'c1' });

    const backButton = screen.getByTestId('rail-back');
    expect(backButton).toHaveAccessibleName('Back to History');
    act(() => backButton.focus());
    fireEvent.click(backButton);
    await settle();
    await timers();
    expect(stack()).toEqual([expect.objectContaining({ kind: 'history' })]);
    expect(document.activeElement).toBe(opener());
    // The same node is still in the header, now the way home: it is not where focus stays.
    expect(screen.getByTestId('rail-back')).toHaveAccessibleName('Back to Ask');
    expect(document.activeElement).not.toBe(screen.getByTestId('rail-back'));
  });

  it('says so when there is nothing, and when the list fails, with Try again', async () => {
    let fails = true;
    api.answer.list = () => (fails ? fail(500, 'server') : undefined);
    push({ kind: 'history' });
    renderRail();
    await settle();
    expect(screen.getByTestId('history-error')).toHaveTextContent("Couldn't load your conversations.");
    fails = false;
    fireEvent.click(within(screen.getByTestId('history-error')).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.queryByTestId('history-error')).toBeNull();
    expect(screen.getByTestId('history-empty')).toHaveTextContent('No conversations yet.');
    expect(screen.getByTestId('history-empty')).toHaveTextContent(
      'What you ask is kept here, on every device, until you delete it.'
    );
  });

  it('asks for the next page as the end of the list comes into view', async () => {
    const observers: { cb: IntersectionObserverCallback; el: Element | null }[] = [];
    const Real = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb, el: null });
      }
      observe(el: Element) {
        observers[observers.length - 1].el = el;
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    try {
      listPage('p2');
      const older = summary({ id: 'c4', title: 'Even older', lastMessageAt: '2026-09-01T12:00:00.000Z' });
      const page2 = { ok: true as const, value: { conversations: [older], nextCursor: null } };
      api.answer.list = ((first) => (o?: { cursor?: string | null }) => (o?.cursor === 'p2' ? page2 : first?.(o)))(
        api.answer.list
      );
      push({ kind: 'history' });
      renderRail();
      await settle();
      expect(observers.length).toBeGreaterThan(0);
      const io = observers[observers.length - 1];
      await act(async () => {
        io.cb([{ isIntersecting: true, target: io.el } as IntersectionObserverEntry], {} as IntersectionObserver);
        await flush();
      });
      expect(api.api.list).toHaveBeenLastCalledWith({ cursor: 'p2' });
      expect(groups().at(-1)?.rows).toEqual(['Old chat', 'Even older']);
    } finally {
      globalThis.IntersectionObserver = Real;
    }
  });

  describe('search', () => {
    it('asks from two characters, 250ms after the last keystroke', async () => {
      listPage();
      push({ kind: 'history' });
      renderRail();
      await settle();
      const box = screen.getByRole('searchbox', { name: 'Search conversations' });
      fireEvent.change(box, { target: { value: 'd' } });
      await timers(300);
      expect(api.api.search).not.toHaveBeenCalled();
      // One character is no search: the groups stay.
      expect(groups()[0].key).toBe('starred');

      api.answer.search = () => ({
        ok: true,
        value: [{ ...ROWS.item, matched: 'message', snippet: '…call the dentist at nine…', itemTitle: 'Book the dentist' }],
      });
      fireEvent.change(box, { target: { value: 'de' } });
      fireEvent.change(box, { target: { value: 'den' } });
      await timers(100);
      expect(api.api.search).not.toHaveBeenCalled();
      await timers(250);
      await settle();
      expect(api.api.search).toHaveBeenCalledTimes(1);
      expect(api.api.search).toHaveBeenCalledWith('den');
      expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Book the dentist'] }]);
      const line = screen.getByTestId('history-second-line');
      expect(line).toHaveTextContent('…call the dentist at nine…');
      expect(line.querySelector('strong')).toHaveTextContent('den');
    });

    it('says when nothing matches, with no "Results" heading over no results', async () => {
      push({ kind: 'history' });
      renderRail();
      await settle();
      const results = () => view().querySelector('[data-history-group="results"]') as HTMLElement;
      // While it asks, the heading stands over the skeleton rows to come.
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'zz' } });
      expect(within(results()).getByRole('heading', { name: 'Results' })).toBeInTheDocument();
      await timers(300);
      await settle();
      expect(screen.getByTestId('history-no-results')).toHaveTextContent('Nothing matches “zz”.');
      expect(within(results()).queryByRole('heading')).toBeNull();
      expect(results()).not.toHaveAttribute('aria-labelledby');

      // Nor over a search that failed.
      api.answer.search = () => fail(500, 'server');
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'zzz' } });
      await timers(300);
      await settle();
      expect(results()).toHaveTextContent("Couldn't search right now.");
      expect(within(results()).queryByRole('heading')).toBeNull();

      // And back over rows once there are some.
      api.answer.search = () => ({ ok: true, value: [{ ...summary({ id: 'c9', title: 'Zzz plans' }), matched: 'title', snippet: null, itemTitle: null }] });
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'zzzz' } });
      await timers(300);
      await settle();
      expect(within(results()).getByRole('heading', { name: 'Results' })).toBeInTheDocument();
      expect(results()).toHaveAttribute('aria-labelledby', 'history-results');
    });

    it('tells a screen reader what a search came to, while focus stays in the field', async () => {
      push({ kind: 'history' });
      renderRail();
      await settle();
      const status = screen.getByTestId('history-search-status');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent(/^$/);
      const box = screen.getByTestId('history-search');

      api.answer.search = () => ({ ok: true, value: [{ ...ROWS.item, matched: 'title', snippet: null, itemTitle: null }] });
      fireEvent.change(box, { target: { value: 'den' } });
      expect(status).toHaveTextContent(/^Searching…$/);
      await timers(300);
      await settle();
      expect(status).toHaveTextContent(/^1 result$/);

      api.answer.search = () => ({ ok: true, value: [] });
      fireEvent.change(box, { target: { value: 'zz' } });
      await timers(300);
      await settle();
      expect(status).toHaveTextContent(/^Nothing matches “zz”\.$/);

      api.answer.search = () => fail(500, 'server');
      fireEvent.change(box, { target: { value: 'zzz' } });
      await timers(300);
      await settle();
      expect(status).toHaveTextContent(/^Couldn't search right now\.$/);

      fireEvent.change(box, { target: { value: '' } });
      expect(status).toHaveTextContent(/^$/);
    });

    it('forgets a result deleted from it: Back from the delete lands on results without it', async () => {
      const SECRET = summary({ id: 'c5', title: 'Biopsy results', messageCount: 2, lastMessageAt: '2026-10-02T08:02:00.000Z' });
      const OTHER = summary({ id: 'c6', title: 'Biopsy questions', lastMessageAt: '2026-10-02T07:00:00.000Z' });
      const asHit = (row: ConversationSummary, snippet: string) => ({ ...row, matched: 'message' as const, snippet, itemTitle: null });
      api.rows.set('c5', SECRET);
      api.answer.thread = (id) =>
        id === 'c5'
          ? {
              ok: true,
              value: {
                conversation: SECRET,
                messages: stored({ id: 'm1', role: 'user', content: 'My biopsy came back positive, what now?' }),
                hasEarlier: false,
              },
            }
          : undefined;
      api.answer.search = () => ({
        ok: true,
        value: [asHit(SECRET, 'My biopsy came back positive, what now?'), asHit(OTHER, 'What does a biopsy show?')],
      });
      push({ kind: 'history' });
      renderRail();
      await settle();
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'biopsy' } });
      await timers(300);
      await settle();
      expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Biopsy results', 'Biopsy questions'] }]);

      const deleteOpen = async () => {
        openMenu(screen.getByRole('button', { name: /conversation options/i }));
        fireEvent.click(screen.getByTestId('conversation-delete'));
        await timers();
        fireEvent.click(screen.getByTestId('conversation-delete-confirm'));
        await settle();
        await timers();
        await timers(300);
        await settle();
      };
      fireEvent.click(screen.getAllByTestId('history-row')[0]);
      await settle();
      await deleteOpen();
      expect(api.removes).toEqual(['c5']);
      expect(stack()).toEqual([{ kind: 'history', memo: { q: 'biopsy', scrollTop: 0 } }]);
      expect(screen.getByTestId('history-search')).toHaveValue('biopsy');
      // Not asked again, and not shown: neither its title nor its words.
      expect(api.api.search).toHaveBeenCalledTimes(1);
      expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Biopsy questions'] }]);
      expect(view()).not.toHaveTextContent('positive');
      expect(screen.getByTestId('history-search-status')).toHaveTextContent(/^1 result$/);

      // The last one: nothing matches, said in words.
      api.rows.set('c6', OTHER);
      api.answer.thread = (id) => (id === 'c6' ? { ok: true, value: { conversation: OTHER, messages: [], hasEarlier: false } } : undefined);
      fireEvent.click(screen.getByTestId('history-row'));
      await settle();
      await deleteOpen();
      expect(api.removes).toEqual(['c5', 'c6']);
      expect(screen.queryByTestId('history-row')).toBeNull();
      expect(screen.getByTestId('history-no-results')).toHaveTextContent('Nothing matches “biopsy”.');
      expect(screen.getByTestId('history-search-status')).toHaveTextContent(/^Nothing matches “biopsy”\.$/);
    });

    it('shows a result as the conversation is now: renamed since the search, by its new title', async () => {
      const TRIP = summary({ id: 'c7', title: 'Trip plans', lastMessageAt: '2026-10-02T08:02:00.000Z' });
      api.answer.search = () => ({ ok: true, value: [{ ...TRIP, matched: 'title', snippet: null, itemTitle: null }] });
      push({ kind: 'history' });
      renderRail();
      await settle();
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'trip' } });
      await timers(300);
      await settle();
      expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Trip plans'] }]);
      api.rows.set('c7', TRIP);
      await act(async () => {
        await useConversationsStore.getState().rename('c7', 'Lisbon trip');
      });
      expect(groups()).toEqual([{ key: 'results', label: 'Results', rows: ['Lisbon trip'] }]);
    });

    it('clears on Escape first, and goes back on the next', async () => {
      push({ kind: 'history' });
      renderRail();
      await settle();
      const box = screen.getByTestId('history-search') as HTMLInputElement;
      act(() => box.focus());
      fireEvent.change(box, { target: { value: 'dentist' } });
      const first = pressEscapeHere();
      expect(first.defaultPrevented).toBe(true);
      expect(box.value).toBe('');
      expect(stack()).toEqual([{ kind: 'history' }]);
      pressEscapeHere();
      expect(stack()).toEqual([]);
    });

    it('takes focus when the palette asks for it, and not on a pointer open', async () => {
      push({ kind: 'history' });
      act(() => rail().requestFocus({ target: 'history-search' }));
      renderRail();
      await timers();
      expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search conversations' }));
      expect(rail().pendingFocus).toBeNull();
    });
  });

  it('is not offered while saving is off', () => {
    act(() => useConversationsStore.setState({ saving: 'off' }));
    renderRail();
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });
});

/* ── the ⌄ menu ──────────────────────────────────────────────────────── */

describe("a conversation's ⌄", () => {
  const TRIP = summary({ id: 'c1', title: 'Trip plans', messageCount: 2 });
  const EXCHANGE = stored(
    { id: 'm1', role: 'user', content: 'Where should we go?' },
    { id: 'm2', role: 'assistant', content: 'Lisbon.', replyTo: 'm1' }
  );
  const trigger = () => screen.getByRole('button', { name: /conversation options/i });

  it('names the title in the header, and offers Rename, Star and Delete', async () => {
    await openSaved(TRIP, EXCHANGE);
    expect(trigger()).toHaveTextContent('Trip plans');
    expect(trigger().closest('h2')).toHaveAttribute('data-ask-heading');
    openMenu(trigger());
    expect(screen.getByTestId('conversation-rename')).toHaveTextContent('Rename');
    expect(screen.getByTestId('conversation-star')).toHaveTextContent('Star');
    expect(screen.getByTestId('conversation-delete')).toHaveTextContent('Delete…');
    expect(screen.queryByText(/open wide/i)).toBeNull();
  });

  it('renames in place: Enter saves the trimmed text', async () => {
    await openSaved(TRIP, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-rename'));
    await hops();
    const input = screen.getByTestId('conversation-rename-input') as HTMLInputElement;
    expect(input).toHaveValue('Trip plans');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  Lisbon in May  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(api.patches).toEqual([{ id: 'c1', patch: { title: 'Lisbon in May' } }]);
    expect(trigger()).toHaveTextContent('Lisbon in May');
  });

  it('cancels a rename on Escape, title restored and the view where it was', async () => {
    push({ kind: 'history' });
    await openSaved(TRIP, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-rename'));
    await hops();
    const input = screen.getByTestId('conversation-rename-input');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Something else' } });
    pressEscapeHere();
    await timers();
    expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
    expect(trigger()).toHaveTextContent('Trip plans');
    expect(document.activeElement).toBe(trigger());
    expect(api.patches).toEqual([]);
    expect(stack()).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
  });

  it('stars and unstars, and says so when a star fails', async () => {
    await openSaved(TRIP, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-star'));
    await settle();
    expect(api.patches).toEqual([{ id: 'c1', patch: { starred: true } }]);
    openMenu(trigger());
    expect(screen.getByTestId('conversation-star')).toHaveTextContent('Unstar');
    api.answer.patch = () => fail(500, 'server');
    fireEvent.click(screen.getByTestId('conversation-star'));
    await settle();
    expect(useConversationsStore.getState().summaries.c1.starred).toBe(true);
    // D9's one string, for an unstar too.
    expect(toasts.error).toHaveBeenCalledWith("Couldn't star that conversation.");
    expect(CONVERSATION_COPY.starFailed).toBe("Couldn't star that conversation.");
  });

  it('asks before deleting, in exact words, and Escape leaves everything as it was', async () => {
    push({ kind: 'history' });
    await openSaved(TRIP, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-delete'));
    await timers();
    const dialog = screen.getByTestId('confirm-dialog');
    expect(within(dialog).getByText('Delete this conversation?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "It's removed from all your devices. Changes it made to your planner stay. This can't be undone."
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('conversation-delete-confirm')).toHaveTextContent('Delete');

    pressEscapeHere();
    await timers();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(stack()).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
    expect(api.removes).toEqual([]);
  });

  it('deletes on confirm: the view goes, and focus lands on the one beneath', async () => {
    push({ kind: 'history' });
    await openSaved(TRIP, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-delete'));
    await timers();
    fireEvent.click(screen.getByTestId('conversation-delete-confirm'));
    await settle();
    await timers();
    expect(api.removes).toEqual(['c1']);
    expect(stack()).toEqual([{ kind: 'history' }]);
    expect(useConversationsStore.getState().summaries.c1).toBeUndefined();
    expect(document.activeElement).toBe(heading());
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("lands focus on the view beneath once the confirm's exit is over, and keeps its words till then", async () => {
    const exit = animatedConfirm();
    try {
      push({ kind: 'history' });
      await openSaved(TRIP, EXCHANGE);
      openMenu(trigger());
      fireEvent.click(screen.getByTestId('conversation-delete'));
      await timers();
      const confirm = screen.getByTestId('conversation-delete-confirm');
      act(() => confirm.focus());
      fireEvent.click(confirm);
      await settle();
      await hops();
      expect(stack()).toEqual([{ kind: 'history' }]);
      // Still leaving: mounted, focused, and still saying what it asked.
      const dialog = screen.getByTestId('confirm-dialog');
      expect(dialog).toHaveTextContent('Delete this conversation?');
      expect(confirm).toHaveTextContent(/^Delete$/);
      expect(document.activeElement).toBe(confirm);

      exit.end();
      await timers();
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
      expect(document.activeElement).toBe(heading());
      expect(heading()).toHaveTextContent('History');
    } finally {
      exit.restore();
    }
  });

  it('counts an OpenClaw reply held here, before the server has said so', async () => {
    await openSaved(
      { ...TRIP, openclawSeen: false },
      stored({ id: 'm1', role: 'user', content: 'Book it' }, { id: 'm2', role: 'assistant', content: 'Done.', replyTo: 'm1', answerer: 'openclaw' })
    );
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-delete'));
    await timers();
    expect(within(screen.getByTestId('confirm-dialog')).getByText(/OpenClaw may keep its own copy\.$/)).toBeInTheDocument();
  });

  it('adds that OpenClaw may keep a copy, once it ever answered', async () => {
    await openSaved({ ...TRIP, answerer: 'model', openclawSeen: true }, EXCHANGE);
    openMenu(trigger());
    fireEvent.click(screen.getByTestId('conversation-delete'));
    await timers();
    expect(
      within(screen.getByTestId('confirm-dialog')).getByText(
        "It's removed from all your devices. Changes it made to your planner stay. This can't be undone. OpenClaw may keep its own copy."
      )
    ).toBeInTheDocument();
  });

  it('builds the body for an item’s conversation too', () => {
    expect(deleteDescription({ item: true, openclawSeen: false })).toBe(
      "The item stays. The conversation is removed from all your devices. This can't be undone."
    );
    expect(deleteDescription({ item: true, openclawSeen: true })).toBe(
      "The item stays. The conversation is removed from all your devices. This can't be undone. OpenClaw may keep its own copy."
    );
  });

  it('is not offered for a conversation with no row yet', () => {
    act(() => {
      const id = useConversationsStore.getState().newDraft();
      rail().push('desktop', { kind: 'conversation', id });
    });
    renderRail();
    expect(screen.queryByRole('button', { name: /conversation options/i })).toBeNull();
    expect(heading()).toHaveTextContent('New chat');
  });
});

describe("an item's conversation ⌄", () => {
  it('offers Star and Delete conversation…, and asks in the item’s words', async () => {
    const row = summary({ id: 'c9', itemId: 't1', title: 'Book the dentist' });
    api.rows.set('c9', row);
    hold(row);
    render(
      <>
        <ItemConversationMenu id="c9" />
        <ConfirmDialog />
      </>
    );
    openMenu(screen.getByRole('button', { name: 'Conversation options' }));
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.getByTestId('item-conversation-star')).toHaveTextContent('Star');
    fireEvent.click(screen.getByTestId('item-conversation-delete'));
    await timers();
    const dialog = screen.getByTestId('confirm-dialog');
    expect(within(dialog).getByText("Delete this item's conversation?")).toBeInTheDocument();
    expect(
      within(dialog).getByText("The item stays. The conversation is removed from all your devices. This can't be undone.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('item-conversation-delete-confirm'));
    await settle();
    expect(api.removes).toEqual(['c9']);
    expect(usePlannerStore.getState().items).toEqual([DENTIST]);
  });

  it('hands focus to the item panel once the confirm has gone, its ⌄ having gone with the conversation', async () => {
    const exit = animatedConfirm();
    try {
      holdItemThread('c9', 't1', [held({ id: 'q', role: 'user', content: 'When?' })]);
      api.rows.set('c9', useConversationsStore.getState().summaries.c9);
      function Pinned() {
        const saved = useConversationsStore((s) => !!s.summaries.c9);
        return saved ? <ItemConversationMenu id="c9" /> : null;
      }
      render(
        <>
          <Pinned />
          <ConfirmDialog />
        </>
      );
      openMenu(screen.getByRole('button', { name: 'Conversation options' }));
      fireEvent.click(screen.getByTestId('item-conversation-delete'));
      await timers();
      const confirm = screen.getByTestId('item-conversation-delete-confirm');
      act(() => confirm.focus());
      const before = useUIStore.getState().itemPanelFocusToken;
      fireEvent.click(confirm);
      await settle();
      await hops();
      expect(useUIStore.getState().itemPanelFocusToken).toBe(before);
      exit.end();
      await timers();
      expect(useUIStore.getState().itemPanelFocusToken).toBe(before + 1);
    } finally {
      exit.restore();
    }
  });
});

describe("an item's inline conversation (the modal, the phone, Zen, /item/[id])", () => {
  const THREAD = [
    held({ id: 'q1', role: 'user', content: 'Which day?', pos: 0 }),
    held({ id: 'a1', role: 'assistant', content: 'Half an answer', status: 'stopped', replyTo: 'q1', pos: 1 }),
  ];

  it("is Ask's transcript: your bubble, a plain reply with Copy, the status lines, and its ⌄", () => {
    holdItemThread('c9', 't1', THREAD);
    render(<ItemConversation item={DENTIST} mode="inline" />);
    const section = screen.getByTestId('item-thread');
    expect(section).toHaveTextContent(/^Conversation/);
    expect(within(section).getByRole('button', { name: 'Conversation options' })).toBeInTheDocument();
    expect(within(section).getByText('Which day?')).toHaveClass('rounded-2xl', 'bg-secondary');
    const reply = within(section).getByText('Half an answer').closest('[data-message-role="assistant"]') as HTMLElement;
    expect(reply.querySelector('[class*="bg-warning"]')).toBeNull();
    expect(within(reply).getByRole('button', { name: 'Copy reply' })).toBeInTheDocument();
    expect(within(reply).getByTestId('chat-stopped-note')).toHaveTextContent('Stopped');
    // Its own one-line box, as before, and the transcript's one status line.
    expect(within(section).getByTestId('item-thread-input')).toBeInTheDocument();
    expect(within(section).getByTestId('reply-status')).toHaveAttribute('role', 'status');
  });

  it('a delete from its ⌄ hands focus to its box, which stays', async () => {
    const exit = animatedConfirm();
    try {
      holdItemThread('c9', 't1', THREAD);
      api.rows.set('c9', useConversationsStore.getState().summaries.c9);
      render(
        <>
          <ItemConversation item={DENTIST} mode="inline" />
          <ConfirmDialog />
        </>
      );
      openMenu(screen.getByRole('button', { name: 'Conversation options' }));
      fireEvent.click(screen.getByTestId('item-conversation-delete'));
      await timers();
      const confirm = screen.getByTestId('item-conversation-delete-confirm');
      act(() => confirm.focus());
      fireEvent.click(confirm);
      await settle();
      await hops();
      expect(screen.queryByRole('button', { name: 'Conversation options' })).toBeNull();
      exit.end();
      await timers();
      expect(document.activeElement).toBe(screen.getByTestId('item-thread-input'));
    } finally {
      exit.restore();
    }
  });
});

/* ── the conversation view ───────────────────────────────────────────── */

describe('a conversation', () => {
  it('says so when it was deleted elsewhere, and keeps its box', async () => {
    const row = summary({ id: 'c1', title: 'Trip plans' });
    hold(row);
    api.answer.thread = () => fail(404, 'not_found');
    push({ kind: 'conversation', id: 'c1' });
    renderRail();
    await settle();
    expect(screen.getByTestId('conversation-gone')).toHaveTextContent(/^This conversation was deleted\.$/);
    expect(askBox()).toBeInTheDocument();
    // Nothing left to rename or delete.
    expect(screen.queryByRole('button', { name: /conversation options/i })).toBeNull();
  });

  it('keeps its name, and the focused heading, when found deleted after it opened', async () => {
    hold(summary({ id: 'c1', title: 'Trip plans' }));
    let answer: () => void = () => {};
    api.answer.thread = () => new Promise((r) => (answer = () => r(fail(404, 'not_found'))));
    renderRail();
    push({ kind: 'history' });
    push({ kind: 'conversation', id: 'c1' });
    await timers();
    const h = heading() as HTMLElement;
    expect(h).toHaveTextContent('Trip plans');
    expect(document.activeElement).toBe(h);

    await act(async () => {
      answer();
      await flush();
    });
    await timers();
    expect(screen.getByTestId('conversation-gone')).toBeInTheDocument();
    // The same heading node, so focus did not drop to <body> with the ⌄.
    expect(heading()).toBe(h);
    expect(h).toHaveTextContent(/^Trip plans$/);
    expect(document.activeElement).toBe(h);
    expect(screen.getByTestId('rail-back')).toHaveTextContent('History');
    expect(askBox()).toHaveAttribute('placeholder', 'Ask anything…');
  });

  it('says it is loading in words while its transcript is on its way', async () => {
    let land: () => void = () => {};
    const row = summary({ id: 'c1', title: 'Trip plans' });
    hold(row);
    api.answer.thread = () =>
      new Promise((r) => (land = () => r({ ok: true, value: { conversation: row, messages: [], hasEarlier: false } })));
    push({ kind: 'conversation', id: 'c1' });
    renderRail();
    try {
      const loading = screen.getByTestId('chat-transcript-loading');
      expect(within(loading).getByText('Loading conversation…')).toHaveClass('sr-only');
      expect(loading).not.toHaveAttribute('aria-label');
      expect(loading).not.toHaveAttribute('aria-busy');
    } finally {
      await act(async () => {
        land();
        await flush();
      });
    }
  });

  it('says when its transcript could not be loaded, and tries again', async () => {
    let fails = true;
    const row = summary({ id: 'c1', title: 'Trip plans' });
    hold(row);
    api.answer.thread = () =>
      fails
        ? fail(500, 'server')
        : { ok: true, value: { conversation: row, messages: stored({ id: 'm1', role: 'user', content: 'Hi' }), hasEarlier: false } };
    push({ kind: 'conversation', id: 'c1' });
    renderRail();
    await settle();
    expect(screen.getByTestId('conversation-error')).toHaveTextContent("Couldn't load this conversation.");
    fails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.queryByTestId('conversation-error')).toBeNull();
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });

  it('says when its item is gone, and goes on', async () => {
    const row = summary({ id: 'c1', itemId: 'gone', title: 'Old item' });
    await openSaved(row, stored({ id: 'm1', role: 'user', content: 'Hi' }));
    expect(screen.getByTestId('conversation-item-gone')).toHaveTextContent('The item this was about is gone.');
    expect(askBox()).toHaveAttribute('placeholder', 'Reply…');
  });
});

describe('the transcript', () => {
  const ROW = summary({ id: 'c1', title: 'Trip plans', openclawSeen: true });

  it('draws yours in a bubble and replies as plain text, with Copy under each', async () => {
    await openSaved(
      ROW,
      stored(
        { id: 'm1', role: 'user', content: 'Where should we go?' },
        { id: 'm2', role: 'assistant', content: 'Try **Lisbon**.', replyTo: 'm1' }
      )
    );
    const mine = screen.getByText('Where should we go?');
    expect(mine.closest('[data-message-role="user"]')).not.toBeNull();
    expect(mine).toHaveClass('rounded-2xl', 'bg-secondary');
    const reply = screen.getByText('Lisbon').closest('[data-message-role="assistant"]') as HTMLElement;
    expect(reply.querySelector('.rounded-2xl')).toBeNull();
    expect(reply.querySelector('img, [data-avatar]')).toBeNull();

    const copy = within(reply).getByRole('button', { name: 'Copy reply' });
    await act(async () => {
      fireEvent.click(copy);
      await flush();
    });
    expect(clipboard.writeText).toHaveBeenCalledWith('Try **Lisbon**.');
    expect(within(reply).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  // One clock for every chat time: a reply's reads as History's row and Ask
  // home's activity row read the same minute ("8:02", never "8:02 AM"), and
  // follows the 24-hour setting with them.
  it.each([
    ['12h', '8:02'],
    ['24h', '08:02'],
  ] as const)("times a reply by History's clock, under the %s setting", async (timeFormat, shown) => {
    act(() => usePlannerStore.setState({ timeFormat }));
    try {
      const at = '2026-10-02T08:02:00.000Z';
      await openSaved(
        { ...ROW, lastMessageAt: at },
        stored(
          { id: 'm1', role: 'user', content: 'Where should we go?', createdAt: at },
          { id: 'm2', role: 'assistant', content: 'Lisbon.', replyTo: 'm1', createdAt: at }
        )
      );
      expect(screen.getByTestId('reply-time')).toHaveTextContent(new RegExp(`^${shown}$`));
      expect(historyTime(at, Date.parse(at), 'UTC', timeFormat === '24h')).toBe(shown);
      expect(clockTime(Date.parse(at), 'UTC', timeFormat)).toBe(shown);
    } finally {
      act(() => usePlannerStore.setState({ timeFormat: '12h' }));
    }
  });

  it('marks where who answers changes', async () => {
    await openSaved(
      ROW,
      stored(
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1', answerer: 'model' },
        { id: 'm3', role: 'user', content: 'two' },
        { id: 'm4', role: 'assistant', content: 'B', replyTo: 'm3', answerer: 'openclaw' },
        { id: 'm5', role: 'user', content: 'three' },
        { id: 'm6', role: 'assistant', content: 'C', replyTo: 'm5', answerer: 'openclaw' }
      )
    );
    const dividers = screen.getAllByTestId('answerer-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent('OpenClaw answers from here');
    // A separator's children are presentational: it carries the words itself.
    expect(screen.getByRole('separator', { name: 'OpenClaw answers from here' })).toBe(dividers[0]);
    // Before the turn's question, never between it and its reply.
    expect(dividers[0].nextElementSibling).toHaveTextContent('two');
  });

  it('places dividers by turn, and words them by who answers', () => {
    const m = (id: string, role: 'user' | 'assistant', answerer: 'model' | 'openclaw' | null, replyTo: string | null = null) =>
      ({ id, role, answerer, replyTo }) as ChatMessage;
    const at = answererDividers([
      m('u1', 'user', null),
      m('a1', 'assistant', 'openclaw', 'u1'),
      m('u2', 'user', null),
      m('a2', 'assistant', 'model', 'u2'),
      m('a3', 'assistant', 'openclaw'),
    ]);
    expect([...at]).toEqual([
      [2, 'model'],
      [4, 'openclaw'],
    ]);
    expect(answererDividerCopy('model')).toBe('Your model answers from here');
  });

  it('says a stopped reply stopped, and a failed one in our words, never its content', async () => {
    await openSaved(
      ROW,
      stored(
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'Half an ans', status: 'stopped', replyTo: 'm1' },
        { id: 'm3', role: 'user', content: 'two' },
        { id: 'm4', role: 'assistant', content: '', status: 'error', errorCode: 'rate_limit', replyTo: 'm3' }
      )
    );
    expect(screen.getByText('Half an ans')).toBeInTheDocument();
    expect(screen.getByTestId('chat-stopped-note')).toHaveTextContent(/^Stopped$/);
    expect(screen.getByTestId('chat-error-note')).toHaveTextContent(chatErrorCopy('rate_limit', 'model'));
    // Not a live region of its own: ReplyStatus says a failure once, so it is
    // not read out twice (nor at all for one that was already there).
    expect(screen.getByTestId('chat-error-note')).not.toHaveAttribute('role');
  });

  it('stops a reply on Stop, keeping what arrived', async () => {
    await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
    const turn = hangs('Partial');
    transport.next = turn.run;
    fireEvent.change(askBox(), { target: { value: 'more please' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await settle();
    expect(screen.getByText('Partial')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-stop'));
    await settle();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    expect(screen.getByTestId('chat-stopped-note')).toBeInTheDocument();
    expect(screen.getByText('Partial')).toBeInTheDocument();
  });

  it('Stop by keyboard hands focus to the box, not <body>, as its slot turns back into Send or the Mic', async () => {
    await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
    transport.next = hangs('Partial').run;
    fireEvent.change(askBox(), { target: { value: 'more please' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await settle();
    const stop = screen.getByTestId('chat-stop');
    act(() => stop.focus());
    fireEvent.click(stop);
    expect(document.activeElement).toBe(askBox());
    await settle();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    expect(document.activeElement).toBe(askBox());
  });

  it("the phone dock's Stop hands focus to its field once the reply has ended (it is disabled till then)", async () => {
    await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
    transport.next = hangs('Partial').run;
    fireEvent.change(askBox(), { target: { value: 'more please' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await settle();
    render(<ChatComposer variant="dock" binding={{ kind: 'conversation', id: 'c1' }} />);
    const field = screen.getByTestId('chat-dock-input');
    expect(field).toBeDisabled();
    const stop = field.parentElement?.querySelector('[data-testid="chat-stop"]') as HTMLElement;
    act(() => stop.focus());
    fireEvent.click(stop);
    await settle();
    expect(field).not.toBeDisabled();
    expect(document.activeElement).toBe(field);
  });

  it('names the panel box as the dock names its own', async () => {
    await openSaved(ROW);
    expect(askBox()).toHaveAttribute('aria-label', 'Message AI');
  });

  it('is a log that reads nothing out as it streams, and says once that a reply began and how it ended', async () => {
    await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).toBe(screen.getByTestId('chat-transcript'));
    expect(log).toHaveAttribute('aria-live', 'off');
    const status = screen.getByTestId('reply-status');
    expect(status).toHaveAttribute('role', 'status');
    // A transcript that arrived whole: nothing happened while it was open.
    expect(status).toHaveTextContent(/^$/);

    const turn = hangs();
    transport.next = turn.run;
    fireEvent.change(askBox(), { target: { value: 'two' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await settle();
    expect(status).toHaveTextContent(/^AI is replying…$/);
    // The dots are for the eye only; the line above says it.
    expect(screen.getByTestId('reply-dots')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('reply-dots').querySelector('span')).toHaveClass('motion-reduce:animate-none');
    await act(async () => {
      turn.release('B');
      await flush();
    });
    expect(status).toHaveTextContent(/^Reply finished\.$/);

    transport.next = hangs('Half').run;
    fireEvent.change(askBox(), { target: { value: 'three' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await settle();
    fireEvent.click(screen.getByTestId('chat-stop'));
    await settle();
    expect(status).toHaveTextContent(/^Stopped\.$/);
  });

  it('draws a reply’s lists, links and code with its own rules (no typography plugin here)', async () => {
    expect(REPLY_PROSE).not.toMatch(/(^|\s)prose(-|\s|$)/);
    for (const rule of ['[&_ul]:list-disc', '[&_ol]:list-decimal', '[&_ul]:pl-5', '[&_ol]:pl-5', '[&_a]:underline', '[&_pre]:overflow-x-auto']) {
      expect(REPLY_PROSE.split(' ')).toContain(rule);
    }
    await openSaved(
      ROW,
      stored(
        { id: 'm1', role: 'user', content: 'List?' },
        { id: 'm2', role: 'assistant', content: '- Groceries\n- Laundry\n\n1. First\n2. Second', replyTo: 'm1' }
      )
    );
    const reply = screen.getByText('Groceries').closest('[data-message-role="assistant"]') as HTMLElement;
    const prose = reply.querySelector('ul')?.parentElement as HTMLElement;
    expect(prose.className).toBe(REPLY_PROSE);
    expect(within(prose).getAllByRole('listitem')).toHaveLength(4);
    expect(prose.querySelector('ol')).not.toBeNull();
  });

  describe('Load earlier', () => {
    const PAGE = stored(
      { id: 'm3', role: 'user', content: 'three', pos: 2 },
      { id: 'm4', role: 'assistant', content: 'D', replyTo: 'm3', pos: 3 }
    );
    const EARLIER = stored({ id: 'm1', role: 'user', content: 'one', pos: 0 }, { id: 'm2', role: 'assistant', content: 'B', replyTo: 'm1', pos: 1 });

    async function openPaged(earlier: () => ReturnType<NonNullable<FakeApi['answer']['thread']>>) {
      api.rows.set(ROW.id, ROW);
      api.answer.thread = (_id, o) =>
        o?.before != null ? earlier() : { ok: true, value: { conversation: ROW, messages: PAGE, hasEarlier: true } };
      hold(ROW);
      push({ kind: 'conversation', id: ROW.id });
      renderRail();
      await settle();
    }

    it('stays focusable while its page is on its way, then hands focus to the transcript as it goes', async () => {
      let land: () => void = () => {};
      await openPaged(
        () => new Promise((r) => (land = () => r({ ok: true, value: { conversation: ROW, messages: EARLIER, hasEarlier: false } })))
      );
      const button = screen.getByTestId('chat-load-earlier');
      act(() => button.focus());
      fireEvent.click(button);
      // Busy, not disabled: a disabled button drops focus to <body>.
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      expect(api.api.thread).toHaveBeenCalledTimes(2);

      await act(async () => {
        land();
        await flush();
      });
      expect(screen.queryByTestId('chat-load-earlier')).toBeNull();
      expect(screen.getByText('one')).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByTestId('chat-transcript'));
    });

    it('keeps the message being read where it sat, whatever grew meanwhile', async () => {
      await openPaged(() => ({ ok: true, value: { conversation: ROW, messages: EARLIER, hasEarlier: false } }));
      const scroller = screen.getByTestId('chat-transcript');
      const realRect = HTMLElement.prototype.getBoundingClientRect;
      // The scroller's box starts at 100. "three" sits 50px into it, and the
      // landed page pushes it 300px further down.
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        let top: number | null = null;
        if (this === scroller) top = 100;
        else if (this.dataset.messageId === 'm3') top = document.querySelector('[data-message-id="m1"]') ? 450 : 150;
        return top === null ? realRect.call(this) : ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect);
      };
      try {
        scroller.scrollTop = 40;
        fireEvent.click(screen.getByTestId('chat-load-earlier'));
        await settle();
        expect(screen.getByText('one')).toBeInTheDocument();
        expect(scroller.scrollTop).toBe(340);
      } finally {
        HTMLElement.prototype.getBoundingClientRect = realRect;
      }
    });
  });

  describe('Jump to latest', () => {
    function measure(el: HTMLElement, o: { scrollHeight: number; clientHeight: number }) {
      Object.defineProperty(el, 'scrollHeight', { value: o.scrollHeight, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: o.clientHeight, configurable: true });
    }
    function arrive(content: string) {
      act(() =>
        useConversationsStore.setState((s) => {
          const t = s.threads.c1;
          const m: ChatMessage = {
            id: `x${t.messages.length}`,
            role: 'assistant',
            content,
            status: 'complete',
            errorCode: null,
            replyTo: null,
            answerer: 'model',
            model: null,
            createdAt: Date.now(),
            pos: t.messages.length,
            sync: 'saved',
          };
          return { threads: { ...s.threads, c1: { ...t, messages: [...t.messages, m] } } };
        })
      );
    }

    it('shows only when scrolled up, and takes you down', async () => {
      await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
      const scroller = screen.getByTestId('chat-transcript');
      measure(scroller, { scrollHeight: 1000, clientHeight: 300 });

      // Near the bottom: following, no pill, and what arrives is followed.
      scroller.scrollTop = 650;
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
      measure(scroller, { scrollHeight: 1200, clientHeight: 300 });
      arrive('B');
      expect(scroller.scrollTop).toBe(1200);
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();

      // Scrolled up: the view stays put and the pill shows.
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      expect(screen.getByTestId('chat-jump-latest')).toHaveTextContent('Jump to latest');
      measure(scroller, { scrollHeight: 1400, clientHeight: 300 });
      arrive('C');
      expect(scroller.scrollTop).toBe(100);
      expect(screen.getByTestId('chat-jump-latest')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('chat-jump-latest'));
      expect(scroller.scrollTop).toBe(1400);
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
    });

    it('hands focus to the box as it goes, and its smooth ride down does not bring it back', async () => {
      await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
      const scroller = screen.getByTestId('chat-transcript');
      measure(scroller, { scrollHeight: 1000, clientHeight: 300 });
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo as never;
      const pill = screen.getByTestId('chat-jump-latest');
      act(() => pill.focus());
      fireEvent.click(pill);
      expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
      expect(document.activeElement).toBe(askBox());

      // On the way down, still far from the bottom: no pill.
      scroller.scrollTop = 300;
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
      scroller.scrollTop = 700;
      fireEvent.scroll(scroller);
      // Arrived: the next scroll up is the reader's own.
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      expect(screen.getByTestId('chat-jump-latest')).toBeInTheDocument();
    });

    it('a ride cut short (the reader took the scroll) ends at scrollend', async () => {
      await openSaved(ROW, stored({ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'A', replyTo: 'm1' }));
      const scroller = screen.getByTestId('chat-transcript');
      measure(scroller, { scrollHeight: 1000, clientHeight: 300 });
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      scroller.scrollTo = vi.fn() as never;
      fireEvent.click(screen.getByTestId('chat-jump-latest'));
      scroller.scrollTop = 200;
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
      act(() => void scroller.dispatchEvent(new Event('scrollend')));
      expect(screen.getByTestId('chat-jump-latest')).toBeInTheDocument();
    });
  });
});

/* ── a new chat ──────────────────────────────────────────────────────── */

describe('a new chat', () => {
  // The chips turn at 16:00 (lib/ai-openers.ts), so the clock is fixed:
  // 14:00 in the user's zone, an afternoon.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  const chipIds = () =>
    within(screen.getByTestId('chat-openers'))
      .getAllByRole('button')
      .map((c) => c.dataset.opener);

  it('opens from "+" with the greeting, the box in the middle and four chips', async () => {
    // Something overdue and nothing today: three openers, then "Help me start…".
    usePlannerStore.setState({ items: [DENTIST, task({ id: 't3', title: 'File taxes', startDate: '2020-01-01' })] });
    renderRail();
    const plus = screen.getByRole('button', { name: 'New chat' });
    act(() => plus.focus());
    fireEvent.click(plus);
    await timers();
    expect(heading()).toHaveTextContent(/^New chat$/);
    const empty = screen.getByTestId('new-chat-empty');
    expect(empty).toHaveTextContent('How can I help?');
    expect(empty.querySelector('[data-ask-greeting]')).toHaveClass('font-serif');
    // Its box is asked for, and it sits between the greeting and the chips.
    expect(document.activeElement).toBe(askBox());
    const chips = within(screen.getByTestId('chat-openers')).getAllByRole('button');
    expect(chips.map((c) => c.dataset.opener)).toEqual(['plan', 'let-go', 'reflect', 'start']);
    expect(chips[3]).toHaveTextContent('Help me start…');
    expect(empty.compareDocumentPosition(askBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(askBox().compareDocumentPosition(chips[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The header offers History, not another "+".
    expect(within(view()).getByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(within(view()).queryByRole('button', { name: 'New chat' })).toBeNull();
  });

  it('"Help me start…" fills the box and hands it the caret, sending nothing', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.click(screen.getByRole('button', { name: 'Help me start…' }));
    await timers();
    expect(askBox()).toHaveValue('Help me start ');
    expect(document.activeElement).toBe(askBox());
    expect(askBox().selectionStart).toBe('Help me start '.length);
    expect(transport.inputs).toEqual([]);
    expect(api.turns).toEqual([]);
  });

  it('"Help me start…" keeps what was already typed, after the start of the sentence', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    fireEvent.change(askBox(), { target: { value: '  with the move' } });
    fireEvent.click(screen.getByRole('button', { name: 'Help me start…' }));
    await timers();
    expect(askBox()).toHaveValue('Help me start with the move');
    // Tapped again: the start is already there, and is not said twice.
    fireEvent.click(screen.getByRole('button', { name: 'Help me start…' }));
    await timers();
    expect(askBox()).toHaveValue('Help me start with the move');
    expect(document.activeElement).toBe(askBox());
    expect(transport.inputs).toEqual([]);
  });

  it('keeps the same box, focused, through the first send', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    const box = askBox();
    fireEvent.change(box, { target: { value: 'Plan my week' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(screen.queryByTestId('new-chat-empty')).toBeNull();
    expect(within(screen.getByTestId('chat-transcript')).getByText('Plan my week')).toBeInTheDocument();
    expect(askBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box).toHaveAttribute('placeholder', 'Reply…');
  });

  it('goes to History from an unsent draft, and Back goes home, leaving no row', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    fireEvent.click(within(view()).getByRole('button', { name: 'History' }));
    expect(stack()).toEqual([{ kind: 'history', returnFocus: 'history' }]);
    fireEvent.click(screen.getByTestId('rail-back'));
    expect(stack()).toEqual([]);
    await settle();
    expect(api.turns).toEqual([]);
    expect(Object.keys(useConversationsStore.getState().summaries)).toEqual([]);
  });

  it('offers no History of its own when opened over History, whose "‹ History" is the way there', async () => {
    push({ kind: 'history' });
    renderRail();
    await settle();
    fireEvent.click(within(view()).getByRole('button', { name: 'New chat' }));
    await timers();
    expect(stack().map((v) => v.kind)).toEqual(['history', 'conversation']);
    expect(screen.getByTestId('rail-back')).toHaveAccessibleName('Back to History');
    expect(heading()).toHaveTextContent('New chat');
    expect(within(view()).queryByRole('button', { name: 'History' })).toBeNull();
    // ✕ still ends the row.
    expect(screen.getByTestId('rail-close')).toBeInTheDocument();
    // From Ask home, the same new chat keeps its History.
    fireEvent.click(screen.getByTestId('rail-back'));
    fireEvent.click(screen.getByTestId('rail-back'));
    await timers();
    fireEvent.click(within(view()).getByRole('button', { name: 'New chat' }));
    await timers();
    expect(stack().map((v) => v.kind)).toEqual(['conversation']);
    expect(within(view()).getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  it("chips: today's openers at the new chat's count, then \"Help me start…\", by the hour", async () => {
    // Nothing sitting and the afternoon: "Plan my day" and the fallback, so
    // fewer than three, and "Help me start…" still last.
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    expect(chipIds()).toEqual(['plan', 'reflect', 'start']);
    cleanup();
    act(() => rail().reset());

    // From 16:00, tomorrow and a look back, with what has been sitting.
    vi.setSystemTime(Date.parse('2026-10-02T19:00:00.000Z'));
    usePlannerStore.setState({ items: [DENTIST, task({ id: 't3', title: 'File taxes', startDate: '2020-01-01' })] });
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    expect(chipIds()).toEqual(['plan-tomorrow', 'let-go', 'review', 'start']);
  });

  it("greets with Ask home's greeting, at the new chat's size, under the spark", async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await timers();
    const greeting = screen.getByTestId('new-chat-empty').querySelector('[data-ask-greeting]') as HTMLElement;
    expect(greeting).toHaveAttribute('data-ask-greeting', 'new-chat');
    // The mock's 24px, not text-2xl, which is 22px in this theme (app/globals.css).
    expect(greeting).toHaveClass('font-serif', 'text-[24px]', 'flex-col');
    expect(greeting).not.toHaveClass('text-2xl');
    expect(greeting.querySelector('svg')).toHaveClass('text-ai');
    expect(greeting).toHaveTextContent(/^Afternoon(, \S+)?$/);
  });
});
