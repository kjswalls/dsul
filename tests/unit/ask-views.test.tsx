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
import { answererDividerCopy, answererDividers } from '@/components/ai/chat-transcript';
import { HELP_ME_START, newChatGreeting, newChatOpeners } from '@/components/ai/ask/new-chat-empty';
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

    it('says when nothing matches', async () => {
      push({ kind: 'history' });
      renderRail();
      await settle();
      fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'zz' } });
      await timers(300);
      await settle();
      expect(screen.getByTestId('history-no-results')).toHaveTextContent('Nothing matches “zz”.');
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
    expect(toasts.error).toHaveBeenCalledWith(CONVERSATION_COPY.unstarFailed);
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
  });
});

/* ── a new chat ──────────────────────────────────────────────────────── */

describe('a new chat', () => {
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

  it('chips: up to three of today’s openers, then "Help me start…" (the C3 seam)', () => {
    // Today's buildChatOpeners can offer fewer than three; C3's options fill
    // the row to four at the merge.
    const openers = newChatOpeners({ items: [], todayStr: '2026-10-02', userTimezone: 'UTC', inactiveIds: new Set() });
    expect(openers.map((o) => o.id)).toEqual(['plan', 'reflect', 'start']);
    expect(openers.at(-1)).toBe(HELP_ME_START);
    expect(HELP_ME_START.mode).toBe('prefill');
  });

  it('greets by the part of the day and the first name', () => {
    expect(newChatGreeting(9 * 60, 'Kirby Smith')).toBe('Morning, Kirby');
    expect(newChatGreeting(13 * 60, null)).toBe('Afternoon');
    expect(newChatGreeting(2 * 60, 'Kirby')).toBe('Evening, Kirby');
    expect(newChatGreeting(null, 'Kirby')).toBe('Hello');
  });
});
