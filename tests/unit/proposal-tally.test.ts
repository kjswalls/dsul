import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * From an accepted card to History's second line. The card's surface names the
 * conversation that asked (`conv:<id>`, or an item's own conversation through
 * `item:<id>`), the planner hands back the operations it actually took after
 * re-validating them, and that tally is PATCHed on the conversation, once.
 *
 * The proposal, planner and conversations stores are all real. The db layer,
 * the propose route and the conversations API are fakes, so nothing here
 * reaches a server.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchHabitGroups: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  renameContainerMembers: vi.fn(async () => {}),
  createHabitGroup: vi.fn(async () => {}),
  updateHabitGroup: vi.fn(async () => {}),
  deleteHabitGroup: vi.fn(async () => {}),
  restoreHabitGroup: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import * as db from '@/lib/db';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  openclawWasAsked,
  useConversationsStore,
} from '@/lib/conversations-store';
import { tallyOperations } from '@/lib/conversation-summary';
import { useChatReceipts } from '@/lib/chat-receipts';
import type { Item, ProposalOperation } from '@/lib/planner-types';
import { CONNECTED_MODEL, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, summary, type FakeApi } from './helpers/conversations-fakes';

const CONV = '0b6f8d2a-3c4e-4f5a-8b9c-0d1e2f3a4b5c';
const ITEM_CONV = '1c7a9e3b-4d5f-4a6b-9cad-1e2f3a4b5c6d';

const task = (id: string, title: string, order: number): Item => ({
  type: 'task',
  id,
  title,
  status: 'pending',
  isScheduled: false,
  order,
  startDate: '2026-10-02',
  completedDates: [],
});

/** One of each kind, against task-1 and task-2. */
const PLAN: ProposalOperation[] = [
  { kind: 'update', itemId: 'task-1', startDate: '2026-10-05' },
  { kind: 'update', itemId: 'task-2', priority: 'high' },
  { kind: 'create', itemType: 'task', title: 'Book the dentist' },
  { kind: 'create', itemType: 'task', title: 'Find the insurance card', parentItemId: 'task-1' },
];

/** The propose route, answering with this plan. */
function proposeAnswers(operations: ProposalOperation[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ proposal: { summary: 'A lighter week', rationale: 'because', operations } }),
    }))
  );
}

const proposals = () => useProposalStore.getState();
const tallies = () => api.patches.filter((p) => p.patch.addChanges);

let api: FakeApi;
let unseed: () => void = () => {};

beforeEach(async () => {
  usePlannerStore.getState().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue([task('task-1', 'Email Dana', 0), task('task-2', 'Renew passport', 1)]);
  await usePlannerStore.getState().initializeStore('user-1');

  api = fakeApi();
  configureConversations({ api: api.api, transport: fakeTransport().transport });
  unseed = seedAI(CONNECTED_MODEL);
  clearChatState();
  // Two saved conversations this browser knows: a general one, and task-1's.
  useConversationsStore.setState({
    summaries: {
      [CONV]: summary({ id: CONV }),
      [ITEM_CONV]: summary({ id: ITEM_CONV, itemId: 'task-1' }),
    },
    itemIndex: { 'task-1': ITEM_CONV },
  });
  proposals().dismiss();
});

afterEach(async () => {
  await conversationsSettled();
  vi.unstubAllGlobals();
  unseed();
  unseed = () => {};
});

describe('the surface a request is stamped with', () => {
  it('names the conversation that asked', async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    expect(proposals().lastRequest?.surface).toBe(`conv:${CONV}`);
    expect(proposals().status).toBe('ready');
  });

  it('an item wins over a conversation, and neither is the catch-up card', async () => {
    proposeAnswers(PLAN);
    await proposals().request('breakdown', undefined, 'task-1', { conversationId: CONV });
    expect(proposals().lastRequest?.surface).toBe('item:task-1');
    await proposals().request('ask', 'plan it');
    expect(proposals().lastRequest?.surface).toBe('chat');
  });
});

describe('the account clear (sign-out, an account switch)', () => {
  it("drops a conversation's card and the excerpt it was asked with", async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'I asked: my biopsy came back positive. You answered: move the writing.', undefined, {
      conversationId: CONV,
    });
    expect(proposals().status).toBe('ready');

    clearChatState();
    expect(proposals().status).toBe('idle');
    expect(proposals().lastRequest).toBeNull();
    expect(proposals().proposal).toBeNull();
  });

  it('drops a plan still on its way for the last account when it lands', async () => {
    let answer: (v: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      )
    );
    const asking = proposals().request('ask', 'I asked: something private.', undefined, { conversationId: CONV });
    expect(proposals().status).toBe('loading');

    clearChatState();
    answer({ ok: true, status: 200, json: async () => ({ proposal: { summary: 'Late', rationale: 'r', operations: PLAN } }) });
    await asking;
    expect(proposals().status).toBe('idle');
    expect(proposals().lastRequest).toBeNull();
    expect(proposals().proposal).toBeNull();
  });
});

describe("a plan asked of OpenClaw from a conversation", () => {
  it("records that OpenClaw was handed that conversation's excerpt; a model's plan does not", async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    expect(openclawWasAsked(CONV)).toBe(false);

    unseed();
    unseed = seedAI({ phase: 'ready', available: true, model: null, openclaw: { gateway: true }, choice: 'openclaw' });
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    expect(openclawWasAsked(CONV)).toBe(true);
    // An item's breakdown is the item's own surface, not a conversation's.
    await proposals().request('breakdown', undefined, 'task-1');
    expect(openclawWasAsked(ITEM_CONV)).toBe(false);
  });
});

describe('an accepted card is counted on its conversation', () => {
  it('conv:<id>: one PATCH of exactly what the planner took', async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    // task-2 goes while the card is up: the planner drops its line on accept.
    usePlannerStore.setState({ items: usePlannerStore.getState().items.filter((i) => i.id !== 'task-2') });

    expect(proposals().accept()).toBe(3);
    await conversationsSettled();

    const taken = PLAN.filter((op) => op.kind === 'create' || ('itemId' in op && op.itemId !== 'task-2'));
    expect(tallies()).toEqual([{ id: CONV, patch: { addChanges: tallyOperations(taken) } }]);
    expect(tallyOperations(taken)).toEqual({ added: 1, steps: 1, moved: 1, changed: 0 });
    expect(useConversationsStore.getState().summaries[CONV].changes).toEqual({ added: 1, steps: 1, moved: 1, changed: 0 });
  });

  it('item:<id>: counted on the item\'s own conversation', async () => {
    proposeAnswers([PLAN[3]]);
    await proposals().request('breakdown', undefined, 'task-1');
    proposals().accept();
    await conversationsSettled();
    expect(tallies()).toEqual([{ id: ITEM_CONV, patch: { addChanges: { added: 0, steps: 1, moved: 0, changed: 0 } } }]);
  });

  it.each([
    ['known to have none', null],
    ['never asked about', undefined],
  ])('item:<id> with no conversation (%s): nothing to count on, nothing sent', async (_label, index) => {
    useConversationsStore.setState({ itemIndex: index === undefined ? {} : { 'task-2': index } });
    proposeAnswers([{ kind: 'create', itemType: 'task', title: 'Step', parentItemId: 'task-2' }]);
    await proposals().request('breakdown', undefined, 'task-2');
    expect(proposals().accept()).toBe(1);
    await conversationsSettled();
    expect(api.patches).toEqual([]);
  });

  it('the catch-up card counts on nothing', async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'plan it');
    expect(proposals().accept()).toBe(4);
    await conversationsSettled();
    expect(api.patches).toEqual([]);
  });

  it('a card the planner takes nothing from sends nothing', async () => {
    proposeAnswers([PLAN[1]]);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    usePlannerStore.setState({ items: usePlannerStore.getState().items.filter((i) => i.id !== 'task-2') });
    expect(proposals().accept()).toBe(0);
    await conversationsSettled();
    expect(api.patches).toEqual([]);
  });
});

describe('the receipt an accept leaves in its conversation', () => {
  it('names the history entry the accept wrote, so its Undo takes back exactly that plan', async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    expect(proposals().accept()).toBeGreaterThan(0);

    const [r] = useChatReceipts.getState().byConversation[CONV] ?? [];
    expect(r?.tally).toEqual(tallyOperations(PLAN));
    const p = usePlannerStore.getState();
    const latest = p.actionLog[p.actionLog.length - 1 - p.historyIndex];
    expect(latest?.label).toMatch(/^Accept plan:/);
    expect(r?.actionId).toBe(latest?.id);

    p.undo();
    expect(usePlannerStore.getState().items.find((i) => i.title === 'Book the dentist')).toBeUndefined();
  });

  it('goes to the item’s own conversation for an item card, and none for the catch-up card', async () => {
    proposeAnswers(PLAN);
    await proposals().request('breakdown', undefined, 'task-1');
    proposals().accept();
    expect(useChatReceipts.getState().byConversation[ITEM_CONV]).toHaveLength(1);

    useChatReceipts.getState().reset();
    await proposals().request('ask', 'plan it');
    proposals().accept();
    expect(useChatReceipts.getState().byConversation).toEqual({});
  });

  it('is cleared with the rest of the chat on an account switch', async () => {
    proposeAnswers(PLAN);
    await proposals().request('ask', 'make my week lighter', undefined, { conversationId: CONV });
    proposals().accept();
    clearChatState();
    expect(useChatReceipts.getState().byConversation).toEqual({});
  });
});
