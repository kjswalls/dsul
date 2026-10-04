import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ITEM_ASKS,
  ITEM_ASK_ORDER,
  canBreakDown,
  isSitting,
  itemAsksFor,
  type ItemAskContext,
  type ItemAskId,
} from '@/lib/item-asks';
import { hydrateCustomTypes } from '@/lib/item-registry';
import type { Item, ItemTypeDef } from '@/lib/planner-types';

/**
 * What can be asked of the AI about one item (lib/item-asks.ts). What each ask
 * DOES is lib/open-chat.ts's business and is tested there; the right-click
 * menu's rendering is item-context-menu.test.tsx's. This pins the declarations:
 * the gate is obeyed (fail closed), each ask is offered only on the items its
 * capability question admits (never task-vs-habit by name), the submenu stays
 * short, the wording follows the item, and the copy contract holds.
 */

const TODAY = '2026-10-04';
const YESTERDAY = '2026-10-03';
const LAST_MONTH = '2026-09-01';
const NEXT_WEEK = '2026-10-11';

const ctxFor = (over: Partial<ItemAskContext> = {}): ItemAskContext => ({
  todayStr: TODAY,
  inactiveIds: new Set(),
  milestoneIds: new Set(),
  hasConversation: false,
  canChat: true,
  canPropose: true,
  ...over,
});

/**
 * The three states the gate can actually be in (lib/ai-registry.ts):
 * nothing answers; something answers but cannot propose (OpenClaw on the
 * plugin path); a model or the OpenClaw gateway answers and proposes.
 * canPropose without canChat is not a state the truth table produces.
 */
const GATES = {
  none: { canChat: false, canPropose: false },
  chatOnly: { canChat: true, canPropose: false },
  full: { canChat: true, canPropose: true },
} as const;

const task = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 't1',
    type: 'task',
    title: 'Fix sink',
    status: 'pending',
    order: 0,
    isScheduled: false,
    completedDates: [],
    ...over,
  }) as unknown as Item;

const habit = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'h1',
    type: 'habit',
    title: 'Stretch',
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    streak: 0,
    ...over,
  }) as unknown as Item;

const custom = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'c1',
    type: 'custom',
    customType: 'errand',
    title: 'Post office',
    status: 'pending',
    isScheduled: false,
    completedDates: [],
    ...over,
  }) as unknown as Item;

/** Every item shape the menu can be opened on, by name. */
const FIXTURES: Record<string, Item> = {
  undated: task(),
  dated: task({ startDate: TODAY, isScheduled: true, timeBucket: 'anytime' }),
  future: task({ startDate: NEXT_WEEK, isScheduled: true }),
  timed: task({ startDate: TODAY, isScheduled: true, startTime: '09:00' }),
  sitting: task({ startDate: YESTERDAY, isScheduled: true }),
  recurringTask: task({ startDate: LAST_MONTH, isScheduled: true, repeatFrequency: 'daily' }),
  habit: habit(),
  doneHabit: habit({ status: 'done', completedDates: [TODAY] }),
  custom: custom(),
  subtask: task({ id: 's1', parentItemId: 't0' }),
  sittingSubtask: task({ id: 's1', parentItemId: 't0', startDate: YESTERDAY, isScheduled: true }),
  completed: task({ status: 'completed', startDate: YESTERDAY, isScheduled: true }),
  cancelled: task({ status: 'cancelled', startDate: YESTERDAY, isScheduled: true }),
  completedCustom: custom({ status: 'completed' }),
};

const ids = (item: Item, ctx: ItemAskContext = ctxFor()): ItemAskId[] => itemAsksFor(item, ctx).map((a) => a.id);

beforeAll(() => {
  // Through the registry, as the planner store hydrates it — a custom type
  // answers every capability question from its config, never from its name.
  hydrateCustomTypes([{ id: 'type-errand', name: 'errand', label: 'Errand', labelPlural: 'Errands' } as ItemTypeDef]);
});
afterAll(() => hydrateCustomTypes([]));

describe('the gate (fail closed)', () => {
  it('offers nothing on any item when nothing can answer', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      for (const hasConversation of [false, true]) {
        expect(ids(item, ctxFor({ ...GATES.none, hasConversation })), name).toEqual([]);
      }
    }
  });

  it('offers only the conversation asks when the answerer cannot propose', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      const got = ids(item, ctxFor(GATES.chatOnly));
      expect(got, name).not.toContain('breakdown');
      expect(got, name).not.toContain('findTime');
      expect(got, name).toContain('ask');
    }
    expect(ids(FIXTURES.undated, ctxFor(GATES.chatOnly))).toEqual(['ask', 'start']);
    expect(ids(FIXTURES.habit, ctxFor(GATES.chatOnly))).toEqual(['ask', 'keep']);
  });

  it('reads each ask off the gate it needs, and only that', () => {
    const item = FIXTURES.undated;
    // ask / start / keep: canChat.
    expect(ITEM_ASKS.ask.eligible(item, ctxFor(GATES.none))).toBe(false);
    expect(ITEM_ASKS.ask.eligible(item, ctxFor(GATES.chatOnly))).toBe(true);
    expect(ITEM_ASKS.start.eligible(item, ctxFor(GATES.none))).toBe(false);
    expect(ITEM_ASKS.start.eligible(item, ctxFor(GATES.chatOnly))).toBe(true);
    expect(ITEM_ASKS.keep.eligible(FIXTURES.habit, ctxFor(GATES.none))).toBe(false);
    expect(ITEM_ASKS.keep.eligible(FIXTURES.habit, ctxFor(GATES.chatOnly))).toBe(true);
    // breakdown / findTime: canPropose.
    expect(ITEM_ASKS.breakdown.eligible(item, ctxFor(GATES.chatOnly))).toBe(false);
    expect(ITEM_ASKS.breakdown.eligible(item, ctxFor(GATES.full))).toBe(true);
    expect(ITEM_ASKS.findTime.eligible(item, ctxFor(GATES.chatOnly))).toBe(false);
    expect(ITEM_ASKS.findTime.eligible(item, ctxFor(GATES.full))).toBe(true);
    // findTime asks canChat too: it lands on Ask home.
    expect(ITEM_ASKS.findTime.eligible(item, ctxFor({ canChat: false, canPropose: true }))).toBe(false);
  });
});

describe('which asks each item gets, with the full gate', () => {
  const table: [keyof typeof FIXTURES, ItemAskId[]][] = [
    ['undated', ['ask', 'breakdown', 'start', 'findTime']],
    ['dated', ['ask', 'breakdown', 'start', 'findTime']],
    ['future', ['ask', 'breakdown', 'start', 'findTime']],
    ['sitting', ['ask', 'breakdown', 'start', 'findTime']],
    // A time already set is a time found.
    ['timed', ['ask', 'breakdown', 'start']],
    // A series' schedule is the series: no card may move it.
    ['recurringTask', ['ask', 'breakdown', 'start']],
    // Streak-counting types get their one ask instead of the task-shaped ones.
    ['habit', ['ask', 'keep']],
    // A repeating item is never finished as a whole.
    ['doneHabit', ['ask', 'keep']],
    // Custom types are task-shaped: the same asks a task gets.
    ['custom', ['ask', 'breakdown', 'start', 'findTime']],
    // One level of subtasks, and a subtask is never scheduled on its own.
    ['subtask', ['ask', 'start']],
    ['sittingSubtask', ['ask', 'start']],
    // Nothing left to start, break down or find a time for; still askable.
    ['completed', ['ask']],
    ['cancelled', ['ask']],
    ['completedCustom', ['ask']],
  ];

  it.each(table)('%s → %j', (name, expected) => {
    expect(ids(FIXTURES[name])).toEqual(expected);
  });

  it('every fixture is covered by the table', () => {
    expect(table.map(([n]) => n).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it('never moves a milestone: its start date is a target date', () => {
    const ms = task({ id: 'm1', startDate: NEXT_WEEK, isScheduled: true });
    const ctx = ctxFor({ milestoneIds: new Set(['m1']) });
    expect(ids(ms, ctx)).toEqual(['ask', 'breakdown', 'start']);
    expect(ITEM_ASKS.findTime.eligible(ms, ctx)).toBe(false);
    // The same item, not a milestone, may have a time found.
    expect(ITEM_ASKS.findTime.eligible(ms, ctxFor())).toBe(true);
    // An undated milestone too.
    const undatedMs = task({ id: 'm1' });
    expect(ITEM_ASKS.findTime.eligible(undatedMs, ctx)).toBe(false);
  });

  it('keeps findTime off a recurring custom item too', () => {
    const series = custom({ startDate: LAST_MONTH, isScheduled: true, repeatFrequency: 'weekdays' });
    expect(ids(series)).toEqual(['ask', 'breakdown', 'start']);
  });

  it('treats a recurring task as never finished, whatever its scalar status', () => {
    const series = task({ startDate: LAST_MONTH, repeatFrequency: 'daily', status: 'completed' });
    expect(ids(series)).toEqual(['ask', 'breakdown', 'start']);
  });

  it('gives habits keep, and never start, breakdown or findTime', () => {
    for (const h of [habit(), habit({ status: 'done' }), habit({ startDate: YESTERDAY }), habit({ startTime: '' })]) {
      for (const hasConversation of [false, true]) {
        const got = ids(h, ctxFor({ hasConversation }));
        expect(got).toContain('keep');
        expect(got).not.toContain('start');
        expect(got).not.toContain('breakdown');
        expect(got).not.toContain('findTime');
      }
    }
  });

  it('gives keep only to a streak-counting type', () => {
    for (const name of ['undated', 'recurringTask', 'custom', 'subtask', 'completed'] as const) {
      expect(ids(FIXTURES[name]), name).not.toContain('keep');
    }
  });

  it('lists asks in menu order', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      const got = ids(item);
      const order = got.map((id) => ITEM_ASK_ORDER.indexOf(id));
      expect(order, name).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

describe('the submenu stays short', () => {
  it('no item, in any context, yields more than four asks', () => {
    let seen = 0;
    for (const item of Object.values(FIXTURES)) {
      for (const gate of Object.values(GATES)) {
        for (const hasConversation of [false, true]) {
          for (const inactive of [false, true]) {
            for (const milestone of [false, true]) {
              const ctx = ctxFor({
                ...gate,
                hasConversation,
                inactiveIds: new Set(inactive ? [item.id] : []),
                milestoneIds: new Set(milestone ? [item.id] : []),
              });
              const got = itemAsksFor(item, ctx);
              expect(got.length).toBeLessThanOrEqual(4);
              // start and keep are one slot: never both.
              expect(got.some((a) => a.id === 'start') && got.some((a) => a.id === 'keep')).toBe(false);
              seen++;
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('every id in the order is declared, once', () => {
    expect([...ITEM_ASK_ORDER].sort()).toEqual(Object.keys(ITEM_ASKS).sort());
    for (const id of ITEM_ASK_ORDER) expect(ITEM_ASKS[id].id).toBe(id);
  });
});

describe('how each ask runs', () => {
  it('declares a kind per ask, with a prompt exactly where something is sent', () => {
    expect(ITEM_ASKS.ask.kind).toBe('compose');
    expect(ITEM_ASKS.breakdown.kind).toBe('breakdown');
    expect(ITEM_ASKS.start.kind).toBe('send');
    expect(ITEM_ASKS.findTime.kind).toBe('propose');
    expect(ITEM_ASKS.keep.kind).toBe('send');
    for (const a of Object.values(ITEM_ASKS)) {
      const sends = a.kind === 'send' || a.kind === 'propose';
      expect(typeof a.prompt === 'function', a.id).toBe(sends);
    }
  });
});

describe('the ask row', () => {
  it('continues the item’s one conversation when it has one', () => {
    const item = FIXTURES.undated;
    expect(ITEM_ASKS.ask.label(item, ctxFor({ hasConversation: false }))).toBe('Ask about this…');
    expect(ITEM_ASKS.ask.label(item, ctxFor({ hasConversation: true }))).toBe('Continue conversation');
  });

  it('is offered on every item the gate admits, finished ones included', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      expect(ITEM_ASKS.ask.eligible(item, ctxFor(GATES.chatOnly)), name).toBe(true);
    }
  });

  it('does not change the rest of the menu', () => {
    for (const item of Object.values(FIXTURES)) {
      expect(ids(item, ctxFor({ hasConversation: true }))).toEqual(ids(item, ctxFor({ hasConversation: false })));
    }
  });
});

describe('isSitting (past its date and still wanted)', () => {
  const ctx = { todayStr: TODAY, inactiveIds: new Set<string>() };

  it('is a pending one-off dated before today', () => {
    expect(isSitting(FIXTURES.sitting, ctx)).toBe(true);
    expect(isSitting(task({ startDate: LAST_MONTH }), ctx)).toBe(true);
    // Legacy full-ISO rows compare by their date.
    expect(isSitting(task({ startDate: `${YESTERDAY}T00:00:00.000Z` }), ctx)).toBe(true);
    // Custom types are date-anchored and carry forward like tasks.
    expect(isSitting(custom({ startDate: YESTERDAY }), ctx)).toBe(true);
  });

  it('is not today, the future, or undated', () => {
    expect(isSitting(FIXTURES.dated, ctx)).toBe(false);
    expect(isSitting(FIXTURES.future, ctx)).toBe(false);
    expect(isSitting(FIXTURES.undated, ctx)).toBe(false);
  });

  it('is never a series, a habit, a subtask, or finished work', () => {
    expect(isSitting(FIXTURES.recurringTask, ctx)).toBe(false);
    expect(isSitting(habit({ startDate: LAST_MONTH }), ctx)).toBe(false);
    expect(isSitting(FIXTURES.sittingSubtask, ctx)).toBe(false);
    expect(isSitting(FIXTURES.completed, ctx)).toBe(false);
    expect(isSitting(FIXTURES.cancelled, ctx)).toBe(false);
  });

  it('is not paused work: that is set aside, not sitting', () => {
    expect(isSitting(FIXTURES.sitting, { todayStr: TODAY, inactiveIds: new Set(['t1']) })).toBe(false);
    // Another item's pause is not this one's.
    expect(isSitting(FIXTURES.sitting, { todayStr: TODAY, inactiveIds: new Set(['other']) })).toBe(true);
  });

  it('reads the day it is handed, not the clock', () => {
    expect(isSitting(FIXTURES.dated, { todayStr: '2026-10-05', inactiveIds: new Set() })).toBe(true);
    expect(isSitting(FIXTURES.sitting, { todayStr: YESTERDAY, inactiveIds: new Set() })).toBe(false);
  });
});

describe('the start row follows the item', () => {
  const START_PROMPT = "Help me get started on this. What's the smallest first step I could take?";
  const UNSTUCK_PROMPT =
    "I'd like to get this moving. Help me figure out what's in the way, and one small step I could take now.";

  it('says "Help me start" on an item that is not sitting', () => {
    for (const name of ['undated', 'dated', 'future', 'timed', 'recurringTask', 'custom', 'subtask'] as const) {
      expect(ITEM_ASKS.start.label(FIXTURES[name], ctxFor()), name).toBe('Help me start');
      expect(ITEM_ASKS.start.prompt!(FIXTURES[name], ctxFor()), name).toBe(START_PROMPT);
    }
  });

  it('says "Help me get unstuck" on a past-dated pending one-off', () => {
    expect(ITEM_ASKS.start.label(FIXTURES.sitting, ctxFor())).toBe('Help me get unstuck');
    expect(ITEM_ASKS.start.prompt!(FIXTURES.sitting, ctxFor())).toBe(UNSTUCK_PROMPT);
    const sittingCustom = custom({ startDate: LAST_MONTH, isScheduled: true });
    expect(ITEM_ASKS.start.label(sittingCustom, ctxFor())).toBe('Help me get unstuck');
  });

  it('is still one row either way', () => {
    const got = ids(FIXTURES.sitting);
    expect(got.filter((id) => id === 'start')).toHaveLength(1);
  });

  it('does not call paused work stuck', () => {
    const paused = ctxFor({ inactiveIds: new Set(['t1']) });
    expect(ITEM_ASKS.start.label(FIXTURES.sitting, paused)).toBe('Help me start');
    expect(ITEM_ASKS.start.prompt!(FIXTURES.sitting, paused)).toBe(START_PROMPT);
  });

  it('keeps the same wording for a subtask whose date has passed (subtasks never sit)', () => {
    expect(ITEM_ASKS.start.label(FIXTURES.sittingSubtask, ctxFor())).toBe('Help me start');
  });
});

describe('the find-a-time row', () => {
  it('carries the item id, since the plan context may not list the item', () => {
    const item = task({ id: 'abc-123', title: 'Call the bank' });
    const prompt = ITEM_ASKS.findTime.prompt!(item, ctxFor());
    expect(prompt).toContain('[abc-123]');
    expect(prompt).toContain('"Call the bank"');
    // One item only; nothing else moves.
    expect(prompt).toMatch(/only schedule this one item/i);
  });

  it('is hidden on a type the registry says is not date-addressable', () => {
    // Habits are not; asked through the registry, not by name.
    expect(ITEM_ASKS.findTime.eligible(habit({ repeatFrequency: 'none' }), ctxFor())).toBe(false);
  });

  it('is hidden once a time is set, and offered when none is', () => {
    expect(ITEM_ASKS.findTime.eligible(FIXTURES.timed, ctxFor())).toBe(false);
    expect(ITEM_ASKS.findTime.eligible(task({ startDate: TODAY, startTime: '' }), ctxFor())).toBe(true);
  });

  it('is offered again once a set time\'s day has passed: that time was not found', () => {
    const sittingTimed = task({ startDate: YESTERDAY, isScheduled: true, startTime: '10:00' });
    expect(ids(sittingTimed)).toEqual(['ask', 'breakdown', 'start', 'findTime']);
    // Paused, it is set aside rather than sitting: no time to find for it.
    expect(ITEM_ASKS.findTime.eligible(sittingTimed, ctxFor({ inactiveIds: new Set(['t1']) }))).toBe(false);
  });

  it('is hidden on paused work: it was set aside on purpose', () => {
    expect(ITEM_ASKS.findTime.eligible(FIXTURES.undated, ctxFor({ inactiveIds: new Set(['t1']) }))).toBe(false);
  });

  it("is hidden on a task inside a project block, which has the block's time", () => {
    const inBlock = task({ startDate: TODAY, isScheduled: true, inProjectBlock: true, project: 'Work' });
    expect(ITEM_ASKS.findTime.eligible(inBlock, ctxFor())).toBe(false);
  });

  it('keeps a day the user already gave it, and looks ahead for one with none', () => {
    const ask = ITEM_ASKS.findTime.prompt!;
    expect(ask(FIXTURES.future, ctxFor())).toContain(`on ${NEXT_WEEK}`);
    expect(ask(FIXTURES.dated, ctxFor())).toContain(`on ${TODAY}`);
    expect(ask(FIXTURES.undated, ctxFor())).toMatch(/in the next few days/);
    // A day that has passed is not kept: the point is a new one.
    expect(ask(FIXTURES.sitting, ctxFor())).toMatch(/in the next few days/);
    expect(ask(FIXTURES.sitting, ctxFor())).not.toContain(YESTERDAY);
  });

  it('quotes the title safely, so a quote in it cannot break the id marker', () => {
    const prompt = ITEM_ASKS.findTime.prompt!(task({ id: 'x1', title: 'Say "hi" ] to [Sam]' }), ctxFor());
    expect(prompt).toContain('"Say \\"hi\\" ] to [Sam]" [x1]');
  });
});

describe('canBreakDown (shared with the item panel)', () => {
  it('asks canPropose', () => {
    expect(canBreakDown(FIXTURES.undated, true)).toBe(true);
    expect(canBreakDown(FIXTURES.undated, false)).toBe(false);
  });

  it('asks the registry whether the type carries subtasks', () => {
    expect(canBreakDown(FIXTURES.custom, true)).toBe(true);
    expect(canBreakDown(FIXTURES.recurringTask, true)).toBe(true);
    expect(canBreakDown(FIXTURES.habit, true)).toBe(false);
  });

  it('refuses a subtask: one level is all the panel renders', () => {
    expect(canBreakDown(FIXTURES.subtask, true)).toBe(false);
    expect(canBreakDown(task({ parentItemId: '' }), true)).toBe(true);
  });

  it('is exactly what the menu row asks, so the panel and the menu never disagree', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      for (const canChat of [false, true]) {
        for (const canPropose of [false, true]) {
          const ctx = ctxFor({ canChat, canPropose });
          expect(ITEM_ASKS.breakdown.eligible(item, ctx), name).toBe(canBreakDown(item, canPropose));
        }
      }
    }
    // A finished one-off has nothing left to break down, on either surface.
    expect(canBreakDown(FIXTURES.completed, true)).toBe(false);
  });
});

describe('copy contract', () => {
  /** Words that name a failure, count a miss, or imply lateness. */
  const FORBIDDEN = /\b(overdue|late|later|lateness|behind|miss|missed|missing|fail|failed|failure|should have|should've|neglect|neglected|slipp(ed|ing)|stale)\b/i;

  /** Every label and prompt any fixture can produce, in every context that changes wording. */
  function allCopy(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = [];
    for (const [name, item] of Object.entries(FIXTURES)) {
      for (const hasConversation of [false, true]) {
        for (const inactive of [false, true]) {
          const ctx = ctxFor({ hasConversation, inactiveIds: new Set(inactive ? [item.id] : []) });
          for (const a of Object.values(ITEM_ASKS)) {
            out.push({ where: `${a.id} label on ${name}`, text: a.label(item, ctx) });
            if (a.prompt) out.push({ where: `${a.id} prompt on ${name}`, text: a.prompt(item, ctx) });
          }
        }
      }
    }
    return out;
  }

  it('no label or prompt names a failure or implies lateness', () => {
    const copy = allCopy();
    expect(copy.length).toBeGreaterThan(0);
    for (const { where, text } of copy) expect(text, where).not.toMatch(FORBIDDEN);
  });

  it('the forbidden-word check would catch a violation', () => {
    expect('This has been overdue for a while').toMatch(FORBIDDEN);
    expect("You're behind on this").toMatch(FORBIDDEN);
    expect('I should have done this').toMatch(FORBIDDEN);
    expect('Help me get unstuck').not.toMatch(FORBIDDEN);
  });

  it('prompts sent into the item conversation say "this", never the title', () => {
    for (const [name, item] of Object.entries(FIXTURES)) {
      for (const a of Object.values(ITEM_ASKS)) {
        if (a.kind !== 'send' || !a.prompt) continue;
        for (const inactive of [false, true]) {
          const text = a.prompt(item, ctxFor({ inactiveIds: new Set(inactive ? [item.id] : []) }));
          expect(text, `${a.id} on ${name}`).not.toContain(item.title);
          expect(text, `${a.id} on ${name}`).toMatch(/\bthis\b/);
        }
      }
    }
  });

  it('prompts are phrased as the user: first person, no second-person blame', () => {
    for (const a of Object.values(ITEM_ASKS)) {
      if (!a.prompt) continue;
      for (const item of [FIXTURES.sitting, FIXTURES.undated, FIXTURES.habit]) {
        const text = a.prompt(item, ctxFor());
        expect(text, a.id).toMatch(/\b(I|me|I'd)\b|^Find\b/);
        expect(text, a.id).not.toMatch(/\byou (forgot|didn't|haven't|never)\b/i);
      }
    }
  });
});
