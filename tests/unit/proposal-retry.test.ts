import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Retry and partial accept — the two ways out of a card that is nearly right.
 *
 * The subtle one is what retry SENDS. Decorating the stored prompt would make
 * each retry decorate the last, so by the third the model is reading a nest of
 * "not this, not that" wrappers instead of the question. The original ask is
 * kept verbatim and the rejections are re-composed onto it every time.
 */

const applyProposal = vi.fn<(p: { summary: string; operations: unknown[] }) => number>(() => 1);

const parent = {
  type: 'task',
  id: 'parent-1',
  title: 'Write the quarterly report',
  notes: 'due before the board meeting',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
};
const existingChild = { ...parent, id: 'child-1', title: 'Pull the numbers', parentItemId: 'parent-1' };
const unrelated = { ...parent, id: 'other-1', title: 'Book the dentist', notes: undefined };

/** The planner's load state as planner-ready reads it; loaded unless a test says otherwise. */
const planner = vi.hoisted(() => ({ isLoading: false, error: null as string | null }));

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: [parent, existingChild, unrelated],
      itemTypes: [],
      routines: [],
      seasons: [],
      // plannerContext reads goals for milestoneItemIds — a proposal that
      // clears a date is a bulk date verb and must subtract milestones.
      goals: [],
      userTimezone: 'UTC',
      // A LOADED planner: accept refuses before landing now (lib/planner-ready.ts isPlannerLoaded).
      userId: 'u1',
      isLoading: planner.isLoading,
      error: planner.error,
      loadFailedUserId: planner.error ? 'u1' : null,
      applyProposal,
    }),
  },
}));

vi.mock('@/lib/ai-settings-store', () => ({
  useAISettingsStore: {
    getState: () => ({ chatTarget: 'model', systemPrompt: '' }),
  },
}));

// The gate says a model is connected, so every ask is proposed by the model.
// The gate says a model is connected. `capsFor` is computed into a hoisted
// holder after the imports: importing the fixture INSIDE this factory would
// import the very module being mocked, and the factory would wait on itself.
const gate = vi.hoisted(() => ({ caps: null as unknown, noteCallFailure: vi.fn() }));
vi.mock('@/lib/ai-connection-store', () => ({
  getAICapabilities: () => gate.caps,
  useAIConnectionStore: { getState: () => ({ noteCallFailure: gate.noteCallFailure }) },
}));

import { useProposalStore } from '@/lib/proposal-store';
import { capsFor, CONNECTED_MODEL, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';

gate.caps = capsFor(CONNECTED_MODEL);

const draft = (summary: string, count = 2) => ({
  summary,
  rationale: 'because',
  operations: Array.from({ length: count }, (_, i) => ({
    kind: 'create',
    itemType: 'task',
    title: `${summary} ${i}`,
  })),
});

/** Captures every /api/ai/propose body the store sends. */
function mockPropose(...responses: Array<ReturnType<typeof draft>>) {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const proposal = responses[Math.min(call++, responses.length - 1)];
      return { ok: true, status: 200, json: async () => ({ proposal }) };
    })
  );
  return bodies;
}

const reset = () =>
  useProposalStore.setState({
    proposal: null,
    status: 'idle',
    error: null,
    emptyMessage: null,
    lastRequest: null,
    rejected: [],
    refused: { count: 0, reasons: [] },
  });

beforeEach(() => {
  applyProposal.mockClear();
  gate.noteCallFailure.mockClear();
  gate.caps = capsFor(CONNECTED_MODEL);
  reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('retry', () => {
  it('sends the original ask again, plus what was turned down', async () => {
    const bodies = mockPropose(draft('Plan A'), draft('Plan B'));

    await useProposalStore.getState().request('ask', 'sort out my week');
    await useProposalStore.getState().retry();

    expect(bodies).toHaveLength(2);
    expect(bodies[0].prompt).toBe('sort out my week');
    expect(bodies[1].prompt).toContain('sort out my week');
    expect(bodies[1].prompt).toContain('Plan A');
  });

  it('re-composes onto the original rather than compounding decoration', async () => {
    const bodies = mockPropose(draft('Plan A'), draft('Plan B'), draft('Plan C'));

    await useProposalStore.getState().request('ask', 'sort out my week');
    await useProposalStore.getState().retry();
    await useProposalStore.getState().retry();

    const third = bodies[2].prompt as string;
    expect(third).toContain('Plan A');
    expect(third).toContain('Plan B');
    // One rejection block, not a block wrapped in a block wrapped in a block.
    expect(third.match(/Already suggested and turned down/g)).toHaveLength(1);
  });

  it('caps how many rejections travel, so the ask is never crowded out', async () => {
    const rounds = ['A', 'B', 'C', 'D', 'E'].map((n) => draft(`Plan ${n}`));
    const bodies = mockPropose(...rounds);

    await useProposalStore.getState().request('ask', 'the ask');
    for (let i = 0; i < 4; i++) await useProposalStore.getState().retry();

    const last = bodies.at(-1) as { prompt: string };
    expect(last.prompt).toContain('the ask');
    expect(last.prompt.match(/^- Plan/gm)?.length).toBeLessThanOrEqual(3);
    // The oldest rejection is the one dropped.
    expect(last.prompt).not.toContain('Plan A');
    expect(last.prompt).toContain('Plan D');
  });

  it('refuses on catch-up, which is a pure function of the planner', async () => {
    const bodies = mockPropose(draft('Plan A'));
    await useProposalStore.getState().request('catch-up');
    await useProposalStore.getState().retry();
    expect(bodies).toHaveLength(0);
  });

  it('leaves the card exactly as it is once nothing can propose', async () => {
    const bodies = mockPropose(draft('Plan A'), draft('Plan B'));
    await useProposalStore.getState().request('ask', 'sort out my week');
    const before = useProposalStore.getState();
    expect(before.status).toBe('ready');

    // The model was disconnected (or chat moved to the plugin) while the card was up.
    gate.caps = capsFor(OPENCLAW_PLUGIN);
    expect(gate.caps).toMatchObject({ proposeTarget: null });
    await useProposalStore.getState().retry();

    expect(bodies).toHaveLength(1);
    const after = useProposalStore.getState();
    expect(after.status).toBe('ready');
    expect(after.proposal).toBe(before.proposal);
    expect(after.error).toBeNull();
    // Plan A was never turned down: no retry went out to carry it.
    expect(after.rejected).toEqual([]);
  });

  it('refuses when nothing has been asked yet', async () => {
    const bodies = mockPropose(draft('Plan A'));
    await useProposalStore.getState().retry();
    expect(bodies).toHaveLength(0);
    expect(useProposalStore.getState().status).toBe('idle');
  });

  it('forgets the rejections once a fresh question is asked', async () => {
    const bodies = mockPropose(draft('Plan A'), draft('Plan B'), draft('Plan C'));

    await useProposalStore.getState().request('ask', 'first question');
    await useProposalStore.getState().retry();
    await useProposalStore.getState().request('ask', 'a different question');

    expect(bodies[2].prompt).toBe('a different question');
    expect(useProposalStore.getState().rejected).toEqual([]);
  });
});

describe('accepting before the planner has loaded', () => {
  afterEach(() => {
    planner.isLoading = false;
    planner.error = null;
  });

  it('applies nothing and keeps the card while the planner is loading or previewing', async () => {
    mockPropose(draft('Plan A', 2));
    await useProposalStore.getState().request('ask', 'x');

    planner.isLoading = true;
    expect(useProposalStore.getState().accept()).toBe(0);

    expect(applyProposal).not.toHaveBeenCalled();
    // Not "those items have changed": the card is still there to accept.
    const s = useProposalStore.getState();
    expect(s.status).toBe('ready');
    expect(s.proposal?.summary).toBe('Plan A');
    expect(s.emptyMessage).toBeNull();

    planner.isLoading = false;
    expect(useProposalStore.getState().accept()).toBe(1);
    expect(applyProposal).toHaveBeenCalledTimes(1);
  });

  it('applies nothing over a failed load’s empty store either', async () => {
    mockPropose(draft('Plan A', 2));
    await useProposalStore.getState().request('ask', 'x');

    planner.error = 'Failed to load data';
    expect(useProposalStore.getState().accept()).toBe(0);
    expect(applyProposal).not.toHaveBeenCalled();
    expect(useProposalStore.getState().status).toBe('ready');
  });
});

describe('accepting part of a plan', () => {
  it('applies only the operations handed to it', async () => {
    mockPropose(draft('Plan A', 3));
    await useProposalStore.getState().request('ask', 'x');

    const all = useProposalStore.getState().proposal!.operations;
    useProposalStore.getState().accept([all[0], all[2]]);

    expect(applyProposal).toHaveBeenCalledTimes(1);
    expect(applyProposal.mock.calls[0][0].operations).toHaveLength(2);
    // Still ONE call, so still one set(), so still one Cmd+Z.
    expect(applyProposal.mock.calls[0][0].summary).toBe('Plan A');
  });

  it('applies everything when given nothing to narrow to', async () => {
    mockPropose(draft('Plan A', 3));
    await useProposalStore.getState().request('ask', 'x');
    useProposalStore.getState().accept();
    expect(applyProposal.mock.calls[0][0].operations).toHaveLength(3);
  });

  it('writes nothing for an empty selection', async () => {
    mockPropose(draft('Plan A', 3));
    await useProposalStore.getState().request('ask', 'x');
    expect(useProposalStore.getState().accept([])).toBe(0);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it('clears the retry history on accept, so the next card starts clean', async () => {
    mockPropose(draft('Plan A'), draft('Plan B'));
    await useProposalStore.getState().request('ask', 'x');
    await useProposalStore.getState().retry();
    expect(useProposalStore.getState().rejected).not.toEqual([]);

    useProposalStore.getState().accept();
    expect(useProposalStore.getState().rejected).toEqual([]);
    expect(useProposalStore.getState().lastRequest).toBeNull();
  });

  it('clears it on dismiss too', async () => {
    mockPropose(draft('Plan A'));
    await useProposalStore.getState().request('ask', 'x');
    useProposalStore.getState().dismiss();
    expect(useProposalStore.getState().lastRequest).toBeNull();
    expect(useProposalStore.getState().rejected).toEqual([]);
  });
});

describe('breakdown', () => {
  it('asks in breakdown mode, so the route picks the steps prompt', async () => {
    const bodies = mockPropose(draft('Four steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');
    expect(bodies[0].mode).toBe('breakdown');
  });

  it('sends the one item, not the whole planner', async () => {
    // Sixty other items is noise when the question is "what are the steps
    // inside this one" — and the model uses them, proposing steps that
    // duplicate work already sitting elsewhere.
    const bodies = mockPropose(draft('Four steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');

    const context = bodies[0].itemContext as string;
    expect(context).toContain('parent-1');
    expect(context).toContain('Write the quarterly report');
    expect(context).toContain('due before the board meeting');
    expect(context).not.toContain('Book the dentist');
  });

  it('lists the steps it already has, so a second ask continues the list', async () => {
    const bodies = mockPropose(draft('More steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');
    expect(bodies[0].itemContext as string).toContain('Pull the numbers');
  });

  it('asks for steps by default, not for a plan for today', async () => {
    const bodies = mockPropose(draft('Four steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');
    expect(bodies[0].prompt).toBe('Break this into a few concrete steps.');
  });

  it('routes the answer back to the item that asked', async () => {
    mockPropose(draft('Four steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');
    expect(useProposalStore.getState().lastRequest?.surface).toBe('item:parent-1');
  });

  it('sends chat asks to the chat surface', async () => {
    mockPropose(draft('A plan'));
    await useProposalStore.getState().request('ask', 'sort out my week');
    expect(useProposalStore.getState().lastRequest?.surface).toBe('chat');
  });

  it('can be retried, staying in breakdown mode and on the same item', async () => {
    const bodies = mockPropose(draft('Four steps'), draft('Different steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'parent-1');
    await useProposalStore.getState().retry();

    expect(bodies[1].mode).toBe('breakdown');
    expect(bodies[1].itemContext as string).toContain('parent-1');
    expect(bodies[1].prompt).toContain('Four steps');
    expect(useProposalStore.getState().lastRequest?.surface).toBe('item:parent-1');
  });

  it('says so plainly when the item has gone', async () => {
    const bodies = mockPropose(draft('Four steps'));
    await useProposalStore.getState().request('breakdown', undefined, 'vanished');
    expect(bodies[0].itemContext).toContain('no longer exists');
  });
});

describe('a superseded request never lands', () => {
  /**
   * Both adversarial reviews found this independently. Without a generation
   * token the last request to RETURN wins rather than the last one ASKED — and
   * those differ, because catch-up resolves synchronously. The visible damage:
   * a card the user is reading silently mutates into unrelated lines, under a
   * `lastRequest` describing a different intent on a surface whose panel is
   * closed, with the retry button hidden because the intent no longer matches.
   */
  function deferredPropose() {
    let release!: (value: ReturnType<typeof draft>) => void;
    const pending = new Promise<ReturnType<typeof draft>>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ proposal: await pending }) }))
    );
    return release;
  }

  it('drops a slow answer once a newer request has been made', async () => {
    const release = deferredPropose();
    const slow = useProposalStore.getState().request('breakdown', undefined, 'parent-1');

    // Catch-up is computed locally and resolves synchronously — no fetch.
    vi.unstubAllGlobals();
    await useProposalStore.getState().request('catch-up');
    const afterCatchUp = useProposalStore.getState().proposal;

    release(draft('Three steps to start'));
    await slow;

    expect(useProposalStore.getState().proposal).toBe(afterCatchUp);
    expect(useProposalStore.getState().lastRequest?.intent).toBe('catch-up');
  });

  it('does not re-open a card the user has already dismissed', async () => {
    const release = deferredPropose();
    const slow = useProposalStore.getState().request('ask', 'x');

    useProposalStore.getState().dismiss();
    release(draft('A plan'));
    await slow;

    expect(useProposalStore.getState().status).toBe('idle');
    expect(useProposalStore.getState().proposal).toBeNull();
    // The bug this prevents: status 'ready' with lastRequest null passes the
    // card's surface guard on EVERY mount, so the same card renders twice.
    expect(useProposalStore.getState().lastRequest).toBeNull();
  });

  it('does not re-open a card the user has already accepted', async () => {
    // The reachable shape: a slow ask is still out when a second one answers
    // first and the user accepts THAT card. Accepting during a retry is not
    // reachable — retry clears the proposal, so the card is showing its loading
    // state and has no accept button at all.
    const release = deferredPropose();
    const slow = useProposalStore.getState().request('ask', 'x');

    mockPropose(draft('A fast plan'));
    await useProposalStore.getState().request('ask', 'y');
    useProposalStore.getState().accept();
    expect(applyProposal).toHaveBeenCalledTimes(1);

    release(draft('A late plan'));
    await slow;

    expect(useProposalStore.getState().status).toBe('idle');
    expect(useProposalStore.getState().proposal).toBeNull();
  });
});

describe('when the plan no longer applies', () => {
  it('says so instead of closing on nothing', async () => {
    // applyProposal re-validates against the CURRENT planner and can drop every
    // operation. Closing silently means the user taps "Do all of it", the card
    // vanishes, and nothing happens — not even an undo entry, because
    // applyProposal returns before arming one.
    mockPropose(draft('A plan'));
    await useProposalStore.getState().request('ask', 'x');

    applyProposal.mockReturnValueOnce(0);
    expect(useProposalStore.getState().accept()).toBe(0);
    expect(useProposalStore.getState().status).toBe('empty');
    expect(useProposalStore.getState().emptyMessage).toMatch(/nothing left to apply/i);
  });
});

describe('rejections', () => {
  it('does not let one repeated summary fill every carried slot', async () => {
    const bodies = mockPropose(draft('The same plan'));
    await useProposalStore.getState().request('ask', 'the ask');
    await useProposalStore.getState().retry();
    await useProposalStore.getState().retry();
    await useProposalStore.getState().retry();

    expect(useProposalStore.getState().rejected).toEqual(['The same plan']);
    expect((bodies.at(-1) as { prompt: string }).prompt.match(/^- /gm)).toHaveLength(1);
  });
});

describe('the request body', () => {
  it('names a target and carries no key, model or provider', async () => {
    const bodies = mockPropose(draft('Plan A'));
    await useProposalStore.getState().request('ask', 'plan my day');

    expect(Object.keys(bodies[0]).sort()).toEqual(
      ['customInstructions', 'itemContext', 'mode', 'prompt', 'target', 'todayStr'].sort()
    );
    expect(bodies[0]).toMatchObject({ target: 'model', mode: 'plan', customInstructions: '' });
  });

  it('asks nothing when the gate has no one to propose', async () => {
    // OpenClaw on the plugin path: chat works, but there is no structured
    // proposal transport, and the route never reroutes to a model (D14).
    gate.caps = capsFor(OPENCLAW_PLUGIN);
    const bodies = mockPropose(draft('Plan A'));
    await useProposalStore.getState().request('ask', 'plan my day');

    expect(bodies).toHaveLength(0);
    expect(useProposalStore.getState()).toMatchObject({
      status: 'error',
      error: 'Connect a model in Settings to ask for a plan.',
    });
  });
});

describe('a refused call', () => {
  it("shows the route's own copy and tells the gate why", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Your model provider rejected the key.', code: 'auth' }),
      }))
    );
    await useProposalStore.getState().request('ask', 'x');

    expect(useProposalStore.getState()).toMatchObject({
      status: 'error',
      error: 'Your model provider rejected the key.',
    });
    expect(gate.noteCallFailure).toHaveBeenCalledWith('auth');
  });
});

describe('a body-less failure', () => {
  it('reports the status rather than a JSON parse error', async () => {
    // A crashed or platform-killed function returns 500 with no body at all,
    // and res.json() then throws a SyntaxError that used to reach the card.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }))
    );
    await useProposalStore.getState().request('ask', 'x');
    expect(useProposalStore.getState().status).toBe('error');
    expect(useProposalStore.getState().error).toBe('HTTP 500');
  });
});

describe('suggestions validation refused', () => {
  /**
   * The reasons are computed on every card and were thrown away at the one
   * point where somebody could read them, so a plan whose operations were
   * mostly refused rendered as a short card with no explanation.
   */
  const refusable = (summary: string) => ({
    summary,
    rationale: 'because',
    operations: [
      // A habit create — refused by canCreateType (containerRequired).
      { kind: 'create', itemType: 'habit', title: 'Meditate' },
      { kind: 'create', itemType: 'task', title: 'A real one' },
    ],
  });

  it('counts them and keeps the reasons', async () => {
    mockPropose(refusable('Mixed plan') as never);
    await useProposalStore.getState().request('ask', 'x');

    const { refused, proposal } = useProposalStore.getState();
    expect(proposal!.operations).toHaveLength(1);
    expect(refused.count).toBe(1);
    expect(refused.reasons[0]).toMatch(/cannot create items of type/i);
  });

  it('reports nothing when every operation went through', async () => {
    mockPropose(draft('All good'));
    await useProposalStore.getState().request('ask', 'x');
    expect(useProposalStore.getState().refused.count).toBe(0);
  });

  it('explains an empty card rather than claiming there was nothing to suggest', async () => {
    // Every operation refused. "No changes to suggest" would be a lie about a
    // reply that suggested plenty.
    mockPropose({
      summary: 'All refused',
      operations: [{ kind: 'create', itemType: 'habit', title: 'Meditate' }],
    } as never);
    await useProposalStore.getState().request('ask', 'x');

    const s = useProposalStore.getState();
    expect(s.status).toBe('empty');
    expect(s.refused.count).toBe(1);
    expect(s.emptyMessage).toMatch(/none of those would work/i);
  });

  it('dedupes reasons, since three identical lines say no more than one', async () => {
    mockPropose({
      summary: 'Three habits',
      operations: [
        { kind: 'create', itemType: 'habit', title: 'a' },
        { kind: 'create', itemType: 'habit', title: 'b' },
        { kind: 'create', itemType: 'habit', title: 'c' },
      ],
    } as never);
    await useProposalStore.getState().request('ask', 'x');

    const { refused } = useProposalStore.getState();
    expect(refused.count).toBe(3);
    expect(refused.reasons).toHaveLength(1);
  });

  it('clears on a fresh ask, so a stale count never rides along', async () => {
    mockPropose(refusable('Mixed') as never, draft('Clean'));
    await useProposalStore.getState().request('ask', 'x');
    expect(useProposalStore.getState().refused.count).toBe(1);

    await useProposalStore.getState().request('ask', 'y');
    expect(useProposalStore.getState().refused.count).toBe(0);
  });

  it('clears on dismiss', async () => {
    mockPropose(refusable('Mixed') as never);
    await useProposalStore.getState().request('ask', 'x');
    useProposalStore.getState().dismiss();
    expect(useProposalStore.getState().refused.count).toBe(0);
  });

  it('clears on accept too', async () => {
    mockPropose(refusable('Mixed') as never);
    await useProposalStore.getState().request('ask', 'x');
    useProposalStore.getState().accept();
    expect(useProposalStore.getState().refused.count).toBe(0);
  });
});
