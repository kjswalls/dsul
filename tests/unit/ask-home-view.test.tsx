import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Ask home's content (PR-2 checkpoint C3), rendered: the greeting, the load
 * line, Needs you, With AI activity, the two chips and the static label. The
 * words themselves are pinned in ask-home.test.ts; this pins what the user
 * sees and what a tap does, over the real stores, with only the db layer and
 * the conversation API faked.
 *
 * The clock is fixed (Date only, so timers stay real): 10:00 UTC on
 * 2026-10-02, a morning.
 */

type Ev = { action: string; payload: Record<string, unknown>; createdAt: string };
const hoisted = vi.hoisted(() => ({
  events: {} as Record<string, Ev[]>,
  recordAgentReply: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItemEvents: vi.fn(async (id: string) => hoisted.events[id] ?? []),
  getItemEventsAvailable: () => true,
  recordAgentReply: (...args: unknown[]) => hoisted.recordAgentReply(...args),
  updateItem: vi.fn(async () => {}),
  fetchAgentStates: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

import { AskHome } from '@/components/ai/ask/ask-home';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { fetchItemEvents } from '@/lib/db';
import { READY_AFTER_MS } from '@/hooks/use-agent-question';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { usePlannerStore } from '@/lib/planner-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useEODStore } from '@/lib/eod-store';
import { useRailStore } from '@/lib/rail-store';
import { useUIStore } from '@/lib/ui-store';
import { useProposalStore } from '@/lib/proposal-store';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { resetAgentFreshness } from '@/hooks/use-agent-freshness';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, summary } from './helpers/conversations-fakes';
import type { Item } from '@/lib/planner-types';
import type { ConversationSummary } from '@/lib/conversation-types';

const TODAY = '2026-10-02';
const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const task = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    startDate: TODAY,
    ...over,
  }) as Item;

const blocked = (id: string, title: string, question: string, at: string) =>
  task(id, { title, assignee: 'openclaw', aiStatus: 'blocked', aiResult: question, aiStatusAt: at });

const ask = (q: string, options: unknown[]): Ev[] => [
  { action: 'agent_question', payload: { question: q, options }, createdAt: ago(5) },
];

function setItems(items: Item[]) {
  usePlannerStore.setState({ items, tasks: items.filter((i) => i.type !== 'habit') } as never);
}

/** Conversations as History's list holds them, fresh: Ask home lists from the list (D8). */
function setConversations(...rows: ConversationSummary[]) {
  useConversationsStore.setState((s) => ({
    summaries: Object.fromEntries(rows.map((r) => [r.id, r])),
    list: {
      ...s.list,
      ids: rows.filter((r) => !r.starred).map((r) => r.id),
      starredIds: rows.filter((r) => r.starred).map((r) => r.id),
      cursor: null,
      status: 'loaded',
      fetchedAt: Date.now(),
    },
  }));
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let unseed: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  configureConversations({ api: fakeApi().api, transport: fakeTransport().transport });
  clearChatState();
  resetAgentFreshness();
  hoisted.recordAgentReply.mockClear();
  for (const k of Object.keys(hoisted.events)) delete hoisted.events[k];
  usePlannerStore.setState({
    items: [],
    tasks: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypes: [],
    userTimezone: 'UTC',
    timeFormat: '12h',
    isLoading: false,
    userId: 'u1',
  } as never);
  useSessionUserStore.setState({
    user: { id: 'u1', email: 'k@example.com', displayName: 'Kirby Example', avatarUrl: null },
  });
  useEODStore.setState({ eodReviewEnabled: false, eodReviewTime: '21:00' });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useRailStore.getState().reset();
  useProposalStore.getState().dismiss();
  unseed = seedAI(CONNECTED_MODEL);
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useSessionUserStore.setState({ user: null });
  vi.useRealTimers();
});

const home = () => document.querySelector('[data-ask-home]') as HTMLElement;
const greetingEl = () => home().querySelector('[data-ask-greeting]') as HTMLElement;
const loadEl = () => home().querySelector('[data-ask-load]');
const cards = () => screen.queryAllByTestId('needs-you-card');
const activity = () => screen.queryAllByTestId('ai-activity-row');

/* ── greeting and load line ──────────────────────────────────────────── */

describe('the greeting', () => {
  it('reads "Morning, Kirby." in the serif, with no spark of its own', () => {
    render(<AskHome />);
    expect(greetingEl()).toHaveTextContent(/^Morning, Kirby\.$/);
    expect(greetingEl()).toHaveAttribute('data-ask-greeting', 'home');
    expect(greetingEl()).toHaveClass('font-serif', 'text-[15px]');
    expect(greetingEl().querySelector('svg')).toBeNull();
  });

  it('drops the name when there is none, and turns at noon', () => {
    useSessionUserStore.setState({ user: null });
    vi.setSystemTime(Date.parse('2026-10-02T12:00:00.000Z'));
    render(<AskHome />);
    expect(greetingEl()).toHaveTextContent(/^Afternoon\.$/);
  });

  it('leads a new chat larger, with the spark and no period', () => {
    render(<AskGreeting variant="new-chat" />);
    const el = document.querySelector('[data-ask-greeting="new-chat"]') as HTMLElement;
    expect(el).toHaveTextContent(/^Morning, Kirby$/);
    expect(el).toHaveClass('font-serif', 'text-2xl');
    expect(el.querySelector('svg')).toHaveClass('text-ai');
  });
});

describe('the load line', () => {
  it("counts the day's total and what is done", () => {
    setItems([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => task(id)),
      task('g', { status: 'completed' }),
      task('h', { status: 'completed' }),
    ]);
    render(<AskHome />);
    expect(loadEl()).toHaveTextContent(/^8 things today · 2 done\.$/);
  });

  it('offers the hours free only while the end-of-day review is on', () => {
    setItems([task('a', { duration: 180 }), task('b', { duration: 120 })]);
    const { unmount } = render(<AskHome />);
    expect(loadEl()).toHaveTextContent(/^About 5h planned\.$/);
    unmount();

    useEODStore.setState({ eodReviewEnabled: true, eodReviewTime: '21:00' });
    render(<AskHome />);
    expect(loadEl()).toHaveTextContent(/^About 5h planned, 6h free\.$/);
  });

  it('is not there on an empty day', () => {
    render(<AskHome />);
    expect(loadEl()).toBeNull();
  });
});

/* ── needs you ───────────────────────────────────────────────────────── */

describe('Needs you', () => {
  const DENTIST = blocked('dentist', 'Book the dentist', 'Tue 3pm or Thu 10am?', ago(30));

  it('draws the question as the mock does, and answers it with a tap', async () => {
    hoisted.events.dentist = ask('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am']);
    setItems([DENTIST]);
    render(<AskHome />);

    const card = screen.getByTestId('needs-you-card');
    expect(card).toHaveTextContent('OpenClaw needs you');
    expect(card).toHaveTextContent('Book the dentist: Tue 3pm or Thu 10am?');
    await waitFor(() => expect(within(card).getAllByTestId('needs-you-option')).toHaveLength(2));
    expect(within(card).getByTestId('needs-you-other')).toHaveTextContent('Other…');
    // With options to tap, no field until "Other…" asks for one.
    expect(within(card).queryByTestId('needs-you-answer')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Thu 10am' }));
    expect(hoisted.recordAgentReply).toHaveBeenCalledWith('dentist', 'task', 'Thu 10am');
    // Re-queued: out of Needs you, and spinning under With AI activity.
    expect(screen.queryByTestId('needs-you')).toBeNull();
    const row = activity().find((r) => r.textContent?.includes('Book the dentist'));
    expect(row).toHaveAttribute('data-state', 'working');
  });

  it('"Other…" opens a field, takes the caret there, and Enter sends', async () => {
    hoisted.events.dentist = ask('Tue 3pm or Thu 10am?', ['Tue 3pm']);
    setItems([DENTIST]);
    render(<AskHome />);
    const other = await screen.findByTestId('needs-you-other');
    fireEvent.click(other);
    const field = screen.getByTestId('needs-you-answer');
    expect(document.activeElement).toBe(field);
    expect(screen.queryByTestId('needs-you-other')).toBeNull();

    fireEvent.change(field, { target: { value: 'Friday morning' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(hoisted.recordAgentReply).toHaveBeenCalledWith('dentist', 'task', 'Friday morning');
  });

  it('Escape with text clears it and is consumed; on an empty field it passes', async () => {
    setItems([DENTIST]);
    render(<AskHome />);
    const field = await screen.findByTestId('needs-you-answer');
    fireEvent.change(field, { target: { value: 'Fri' } });
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(field).toHaveValue('');
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
    expect(hoisted.recordAgentReply).not.toHaveBeenCalled();
  });

  it('shows the field outright with no options, without taking focus', async () => {
    setItems([DENTIST]);
    render(<AskHome />);
    const field = await screen.findByTestId('needs-you-answer');
    expect(field).toHaveAttribute('placeholder', 'Answer…');
    expect(screen.queryByTestId('needs-you-other')).toBeNull();
    expect(document.activeElement).not.toBe(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(hoisted.recordAgentReply).not.toHaveBeenCalled();
  });

  it('never paints the field ahead of the chips: it waits for the trail to answer', async () => {
    // The field painted first and was then swapped for the chips, taking a
    // caret (and any words) already in it.
    hoisted.events.dentist = ask('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am']);
    setItems([DENTIST]);
    render(<AskHome />);
    expect(screen.queryByTestId('needs-you-answer')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('needs-you-option')).toHaveLength(2));
    expect(screen.queryByTestId('needs-you-answer')).toBeNull();
  });

  it('a trail that fails still leaves the field to answer in', async () => {
    vi.mocked(fetchItemEvents).mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    setItems([DENTIST]);
    render(<AskHome />);
    expect(await screen.findByTestId('needs-you-answer')).toBeInTheDocument();
  });

  it('a trail that never answers stops being waited on after READY_AFTER_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    vi.mocked(fetchItemEvents).mockImplementationOnce(() => new Promise(() => {}));
    setItems([DENTIST]);
    render(<AskHome />);
    act(() => void vi.advanceTimersByTime(READY_AFTER_MS - 1));
    expect(screen.queryByTestId('needs-you-answer')).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId('needs-you-answer')).toBeInTheDocument();
  });

  it('heads the cards "Needs you · N", in the section headings\' type', () => {
    setItems([DENTIST, blocked('vet', 'Call the vet', 'Which day?', ago(10))]);
    render(<AskHome />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Needs you · 2' });
    expect(heading.className).toBe(ASK_SECTION_HEADING);
    expect(screen.getByRole('region', { name: 'Needs you · 2' })).toBe(screen.getByTestId('needs-you'));
  });

  it('an answer by keyboard hands focus to the row the item became, not to <body>', async () => {
    hoisted.events.dentist = ask('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am']);
    setItems([DENTIST]);
    render(<AskHome />);
    const option = await screen.findByRole('button', { name: 'Thu 10am' });
    option.focus();
    fireEvent.click(option);
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-ask-focus', 'item:dentist'));
    expect(document.activeElement).toHaveAttribute('data-state', 'working');
  });

  it('so does Enter in the field', async () => {
    setItems([DENTIST, blocked('vet', 'Call the vet', 'Which day?', ago(10))]);
    render(<AskHome />);
    const field = await within(cards()[0]).findByTestId('needs-you-answer');
    field.focus();
    fireEvent.change(field, { target: { value: 'Thursday' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(hoisted.recordAgentReply).toHaveBeenCalledWith('dentist', 'task', 'Thursday');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-ask-focus', 'item:dentist'));
  });

  it('a card answered with the mouse leaves focus where it was', async () => {
    hoisted.events.dentist = ask('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am']);
    setItems([DENTIST]);
    render(<AskHome />);
    const box = home().querySelector('[data-ask-composer] textarea') as HTMLElement;
    box.focus();
    fireEvent.click(await screen.findByRole('button', { name: 'Thu 10am' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(box);
  });

  it('shows three, longest-waiting first, then "Show 2 more" opens the rest in place', () => {
    setItems([
      blocked('n1', 'One', 'Q1', ago(10)),
      blocked('n2', 'Two', 'Q2', ago(50)),
      blocked('n3', 'Three', 'Q3', ago(40)),
      blocked('n4', 'Four', 'Q4', ago(30)),
      blocked('n5', 'Five', 'Q5', ago(20)),
    ]);
    render(<AskHome />);
    expect(cards().map((c) => c.dataset.itemId)).toEqual(['n2', 'n3', 'n4']);
    fireEvent.click(screen.getByTestId('needs-you-more'));
    expect(cards().map((c) => c.dataset.itemId)).toEqual(['n2', 'n3', 'n4', 'n5', 'n1']);
    expect(screen.queryByTestId('needs-you-more')).toBeNull();
  });

  it('"Show N more" by keyboard hands focus to the first card it showed', async () => {
    setItems(['n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) => blocked(id, id, 'Q', ago(50 - i))));
    render(<AskHome />);
    const more = screen.getByTestId('needs-you-more');
    expect(more).toHaveClass('focus-visible:ring-2');
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(document.activeElement).toBe(within(cards()[3]).getByTestId('needs-you-title')));
  });

  it('reads "AI needs you" for the AI, and its title opens the item', () => {
    setItems([task('mine', { title: 'Sort the receipts', assignee: 'beacon', aiStatus: 'blocked', aiResult: 'Which year?' })]);
    render(<AskHome />);
    expect(screen.getByTestId('needs-you-card')).toHaveTextContent('AI needs you');
    const title = screen.getByTestId('needs-you-title');
    expect(title).toHaveAttribute('data-ask-focus', 'needs:mine');
    fireEvent.click(title);
    const dialog = useUIStore.getState().activeDialog as { type: string; item?: { id: string } };
    expect(dialog.type).toBe('edit-item');
    expect(dialog.item?.id).toBe('mine');
  });
});

/* ── with AI activity ────────────────────────────────────────────────── */

describe('With AI activity', () => {
  it('lists runs and today’s conversations, newest first, each worded', () => {
    setItems([
      task('gift', { title: 'Gift for Ari', assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(12) }),
      task('phone', { title: 'Phone plans', assignee: 'openclaw', aiStatus: 'done', aiStatusAt: ago(60) }),
      task('plumber', { title: 'Find a plumber', assignee: 'openclaw', aiStatus: 'failed', aiStatusAt: ago(90) }),
      task('taxes', { title: 'File taxes' }),
    ]);
    setConversations(
      summary({ id: 'c1', title: 'Plan for today', lastMessageAt: '2026-10-02T08:02:00.000Z' }),
      summary({ id: 'c2', itemId: 'taxes', title: 'taxes', lastMessageAt: '2026-10-02T07:40:00.000Z' })
    );
    render(<AskHome />);

    const heading = screen.getByRole('heading', { name: 'With AI activity' });
    // Needs you's heading type, on the rows' inset.
    expect(heading).toHaveClass(...ASK_SECTION_HEADING.split(' '), 'px-2');
    const rows = activity();
    // Each glyph is an icon, with no text; the kind is said before the title.
    expect(rows.map((r) => r.textContent)).toEqual([
      'Working on: Gift for AriOpenClaw · 12m',
      'Came back: Phone plansback',
      "Couldn't finish: Find a plumberCouldn't finish",
      'Conversation: Plan for today8:02',
      'Item conversation: File taxes7:40',
    ]);
    // A state the kind already says is shown once and read once.
    const meta = (r: HTMLElement) => r.lastElementChild as HTMLElement;
    expect(rows.map((r) => meta(r).getAttribute('aria-hidden'))).toEqual([null, 'true', 'true', null, null]);
    // An item's conversation is drawn as History draws it: lucide's square.
    expect(rows[4].querySelector('svg[data-glyph="item"]')).not.toBeNull();
    expect(rows[3].querySelector('svg[data-glyph="general"]')).not.toBeNull();
    expect(rows.map((r) => r.dataset.state ?? null)).toEqual(['working', 'back', 'failed', null, null]);
    expect(rows.map((r) => r.dataset.askFocus)).toEqual([
      'item:gift',
      'item:phone',
      'item:plumber',
      'conv:c1',
      'conv:c2',
    ]);
  });

  it('draws "back" with the lime dot, under no opacity', () => {
    setItems([task('phone', { title: 'Phone plans', assignee: 'openclaw', aiStatus: 'done', aiStatusAt: ago(60) })]);
    render(<AskHome />);
    const dot = home().querySelector('[data-lime-dot]') as HTMLElement;
    expect(dot).toHaveClass('bg-primary');
    for (let el: HTMLElement | null = dot; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)opacity-/);
    }
  });

  it('opens the item from a run’s row', () => {
    setItems([task('gift', { title: 'Gift for Ari', assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(12) })]);
    render(<AskHome />);
    fireEvent.click(activity()[0]);
    const dialog = useUIStore.getState().activeDialog as { type: string; item?: { id: string } };
    expect(dialog.type).toBe('edit-item');
    expect(dialog.item?.id).toBe('gift');
  });

  it('pushes a general conversation from its row, to come back to that row', () => {
    setConversations(summary({ id: 'c1', title: 'Plan for today', lastMessageAt: ago(5) }));
    render(<AskHome />);
    fireEvent.click(activity()[0]);
    expect(useRailStore.getState().stacks.desktop.at(-1)).toEqual({
      kind: 'conversation',
      id: 'c1',
      returnFocus: 'conv:c1',
    });
  });

  it("opens an item's conversation as the item, asked to reveal its Conversation", () => {
    setItems([task('taxes', { title: 'File taxes' })]);
    setConversations(summary({ id: 'c2', itemId: 'taxes', title: 'taxes', lastMessageAt: ago(5) }));
    render(<AskHome />);
    fireEvent.click(activity()[0]);
    const dialog = useUIStore.getState().activeDialog as { type: string; item?: { id: string } };
    expect(dialog.item?.id).toBe('taxes');
    expect(useRailStore.getState().pendingReveal).toEqual({ itemId: 'taxes' });
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
  });

  it('reads the time on the 24-hour clock under that setting', () => {
    usePlannerStore.setState({ timeFormat: '24h' });
    setConversations(summary({ id: 'c1', title: 'Plan for today', lastMessageAt: '2026-10-02T08:02:00.000Z' }));
    render(<AskHome />);
    expect(activity()[0]).toHaveTextContent(/08:02$/);
  });

  it("lists History's conversations, not every summary this tab ever held", () => {
    // A summary outlives its place in the list (a search hit, a conversation
    // opened by id, one dropped by a refresh); only the list says what exists.
    setConversations(
      summary({ id: 'c1', title: 'Plan for today', lastMessageAt: ago(5) }),
      summary({ id: 'c3', title: 'Starred one', starred: true, lastMessageAt: ago(20) })
    );
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, c2: summary({ id: 'c2', title: 'Only a search hit', lastMessageAt: ago(1) }) },
    }));
    render(<AskHome />);
    expect(activity().map((r) => r.dataset.askFocus)).toEqual(['conv:c1', 'conv:c3']);
  });
});

/* ── chips, the box and its label ────────────────────────────────────── */

describe('the foot', () => {
  it("offers two of today's chips over the box, and the model's name under it", () => {
    setItems([task('old', { startDate: '2026-09-20' })]);
    render(<AskHome />);
    const chips = within(screen.getByTestId('chat-openers')).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Plan my day', "What's been sitting?"]);
    expect(home().querySelector('[data-ask-composer] textarea')).not.toBeNull();
    expect(within(home()).getByTestId('answerer-label')).toHaveTextContent('gpt-4o-mini');
  });

  it('turns to tomorrow in the evening', () => {
    vi.setSystemTime(Date.parse('2026-10-02T19:00:00.000Z'));
    render(<AskHome />);
    const chips = within(screen.getByTestId('chat-openers')).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Plan tomorrow', 'Review today']);
  });
});

/* ── freshness ───────────────────────────────────────────────────────── */

describe('freshness', () => {
  it('reads the agent states on showing', async () => {
    const db = await import('@/lib/db');
    vi.mocked(db.fetchAgentStates).mockClear();
    render(<AskHome />);
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);
  });
});
