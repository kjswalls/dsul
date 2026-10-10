// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_CARD_CHANGES, PROPOSE_TOOL, makeChangeOffer, type ChangeSource } from '@/lib/ai-server/chat-changes';
import { CHAT_TOOLS, makeLookups } from '@/lib/ai-server/chat-lookups';
import { TOOLS_PROMPT, withToolsPrompt } from '@/lib/ai-server/chat-loop';
import { BEACON_SYSTEM_PROMPT, NO_CHANGES_SENTENCE } from '@/lib/beacon-system-prompt';
import type { Goal, Item } from '@/lib/planner-types';

/**
 * Chat's one changing tool (AI step 3, build step 4): propose_changes draws a
 * card and never writes.
 */

const task = (over: Record<string, unknown>) =>
  ({ type: 'task', status: 'pending', isScheduled: true, order: 0, completedDates: [], ...over }) as unknown as Item;

const ITEMS: Item[] = [
  task({ id: 't1', title: 'Dentist', startDate: '2026-10-15' }),
  task({ id: 't2', title: 'Report', startDate: '2026-10-16' }),
  task({ id: 't3', title: 'Outline', parentItemId: 't2' }),
  task({ id: 't4', title: 'Newsletter', startDate: '2026-10-17', repeatFrequency: 'daily' }),
  task({ id: 'm1', title: 'Beta ships', startDate: '2026-11-01' }),
];

function source(over: Partial<ChangeSource> = {}): ChangeSource {
  return {
    items: async () => ITEMS,
    goals: async () => [{ id: 'g', name: 'Launch', state: 'active', memberIds: [], milestoneIds: ['m1'], checkinIds: [] } as unknown as Goal],
    itemTypes: async () => ['errand'],
    ...over,
  };
}

describe('propose_changes', () => {
  it('turns a good call into a card, and tells the model nothing has changed yet', async () => {
    const r = await makeChangeOffer(source())({
      summary: 'Dentist to Monday',
      rationale: 'Thursday is full.',
      operations: [
        { kind: 'update', itemId: 't1', startDate: '2026-10-19' },
        { kind: 'create', title: 'Call Mum', startDate: '2026-10-18' },
        { kind: 'create', itemType: 'errand', title: 'Post parcel' },
      ],
    });
    expect(r.proposal).toEqual({
      summary: 'Dentist to Monday',
      rationale: 'Thursday is full.',
      operations: [
        { kind: 'update', itemId: 't1', startDate: '2026-10-19' },
        // A create with no type is a task.
        { kind: 'create', itemType: 'task', title: 'Call Mum', startDate: '2026-10-18' },
        { kind: 'create', itemType: 'errand', title: 'Post parcel' },
      ],
    });
    expect(r.action).toBe('Suggested "Dentist to Monday"');
    expect(r.content).toContain('Dentist: move to Mon Oct 19');
    expect(r.content).toContain('Nothing has changed yet');
    expect(r.content).not.toMatch(/^error/);
  });

  it('reads clear: [...] as the nulls that empty a field', async () => {
    const r = await makeChangeOffer(source())({
      summary: 'Off the calendar',
      operations: [{ kind: 'update', itemId: 't1', clear: ['startDate', 'startTime', 'bogus'] }],
    });
    expect(r.proposal?.operations).toEqual([{ kind: 'update', itemId: 't1', startDate: null, startTime: null }]);
  });

  it('leaves off what cannot be done, and says why, so the reply can match the card', async () => {
    const r = await makeChangeOffer(source())({
      summary: 'A few things',
      operations: [
        { kind: 'update', itemId: 't1', status: 'completed' },
        { kind: 'update', itemId: 'nope', startDate: '2026-10-20' },
        { kind: 'update', itemId: 't3', startDate: '2026-10-20' },
        { kind: 'update', itemId: 't4', status: 'completed' },
        { kind: 'update', itemId: 'm1', clear: ['startDate'] },
        { kind: 'update', itemId: 't2', status: 'done' },
        { kind: 'create', itemType: 'ritual', title: 'Stretch' },
      ],
    });
    expect(r.proposal?.operations).toEqual([{ kind: 'update', itemId: 't1', status: 'completed' }]);
    for (const reason of [
      'item no longer exists',
      'subtasks are managed inside their parent',
      'recurring items are completed per-date',
      'a goal milestone keeps its target date',
      '"done" is not a valid status',
      'cannot create items of type "ritual"',
    ]) {
      expect(r.content).toContain(reason);
    }
  });

  it('offers no card when nothing survives, and says what to fix', async () => {
    const r = await makeChangeOffer(source())({ summary: 'x', operations: [{ kind: 'update', itemId: 'nope', title: 'y' }] });
    expect(r.proposal).toBeUndefined();
    expect(r.content).toMatch(/^error: none of those changes can be offered/);
  });

  it('refuses a malformed card, too many changes, and a second card in one turn', async () => {
    const offer = makeChangeOffer(source());
    const bad = await offer({ operations: [{ kind: 'create' }] });
    expect(bad.proposal).toBeUndefined();
    expect(bad.content).toMatch(/^error: the card could not be read/);

    const many = await offer({
      summary: 'Lots',
      operations: Array.from({ length: MAX_CARD_CHANGES + 1 }, (_, i) => ({ kind: 'create', title: `T${i}` })),
    });
    expect(many.content).toMatch(new RegExp(`at most ${MAX_CARD_CHANGES} changes`));

    const first = await offer({ summary: 'One', operations: [{ kind: 'create', title: 'A' }] });
    expect(first.proposal).toBeDefined();
    const second = await offer({ summary: 'Two', operations: [{ kind: 'create', title: 'B' }] });
    expect(second.proposal).toBeUndefined();
    expect(second.content).toMatch(/already offered a card/);
  });

  it('still offers a card when the types cannot be read: only custom creates are left off', async () => {
    const r = await makeChangeOffer(source({ itemTypes: async () => null }))({
      summary: 'x',
      operations: [
        { kind: 'create', title: 'A' },
        { kind: 'create', itemType: 'errand', title: 'B' },
      ],
    });
    expect(r.proposal?.operations).toEqual([{ kind: 'create', itemType: 'task', title: 'A' }]);
  });

  it('offers a tick or a skip as a verb, with no type, and leaves off one the item cannot take', async () => {
    const r = await makeChangeOffer(source())({
      summary: 'Newsletter done, dentist skipped',
      operations: [
        { kind: 'verb', verb: 'complete', itemId: 't4', date: '2026-10-17' },
        { kind: 'verb', verb: 'skip', itemId: 't1' },
      ],
    });
    expect(r.proposal?.operations).toEqual([{ kind: 'verb', verb: 'complete', itemId: 't4', date: '2026-10-17' }]);
    expect(r.content).toContain('Newsletter: done on');
    expect(r.content).toMatch(/Dentist: skip today: .*cannot be skipped/);
  });

  it('is offered beside the lookups, and runs through them', async () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual(['find_items', 'planner_overview', 'item_activity', 'propose_changes']);
    // No union types: not every provider's schema dialect takes them.
    expect(JSON.stringify(PROPOSE_TOOL.parameters)).not.toMatch(/"type":\[|null/);
    const lookups = makeLookups({
      items: async () => ITEMS,
      projects: async () => [],
      routines: async () => [],
      seasons: async () => [],
      goals: async () => [],
      events: async () => [],
      itemTypes: async () => [],
    });
    const r = await lookups.run({ id: 'c', name: 'propose_changes', args: { summary: 'S', operations: [{ kind: 'create', title: 'A' }] } });
    expect(r.proposal?.summary).toBe('S');
  });
});

describe('the prompt with tools', () => {
  it("swaps the base prompt's 'cannot change' for the card, and adds the tools prompt before the snapshot", () => {
    expect(BEACON_SYSTEM_PROMPT).toContain(NO_CHANGES_SENTENCE);
    const out = withToolsPrompt([`${BEACON_SYSTEM_PROMPT}\n\nBe brief.`, 'SNAPSHOT']);
    expect(out[0]).not.toContain('You cannot change the planner');
    expect(out[0]).toContain('propose_changes');
    expect(out[0]).toContain('Be brief.');
    expect(out.slice(1)).toEqual([TOOLS_PROMPT, 'SNAPSHOT']);
  });
});
