import { describe, it, expect } from 'vitest';
import {
  CONTAINER_ASKS,
  MAX_NAMED_MEMBERS,
  containerAskSubject,
  containerAsksFor,
  selectionAskText,
  type ContainerAskSubject,
} from '@/lib/container-asks';
import { MAX_MENTIONED, mentionedItemIds } from '@/lib/chat-mentions';
import type { Goal, Item, Project, Routine, Season } from '@/lib/planner-types';

/**
 * What can be asked of the AI about a container or a selection
 * (lib/container-asks.ts): the gate fails closed, the words carry what the
 * container holds (the chat context does not), and a selection's words are
 * mentions the send will find again.
 */

const task = (id: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({ id, type: 'task', title, status: 'pending', order: 0, isScheduled: false, completedDates: [], ...over }) as unknown as Item;

const habit = (id: string, title: string): Item =>
  ({
    id,
    type: 'habit',
    title,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    streak: 0,
  }) as unknown as Item;

const project = { id: 'p1', name: 'Work', emoji: '' } as unknown as Project;
const routine = { id: 'r1', name: 'Mornings', state: 'active', itemIds: ['h2', 'h1'] } as unknown as Routine;
const season = { id: 's1', name: 'Summer', state: 'auto', startsOn: '2027-06-01', endsOn: '2027-08-31', itemIds: [], routineIds: [] } as unknown as Season;
const goal = { id: 'g1', name: 'Run a 10k', state: 'active', targetOn: '2027-03-01', milestoneIds: ['t1'], checkinIds: [], memberIds: [] } as unknown as Goal;

const ITEMS: Item[] = [
  task('t1', 'Draft the deck', { projectId: 'p1', project: 'Work' }),
  task('t2', 'Ship it', { projectId: 'p1', project: 'Work', status: 'completed' }),
  task('t3', 'By name only', { project: 'work' }),
  task('t4', 'A step', { projectId: 'p1', project: 'Work', parentItemId: 't1' }),
  task('t5', 'Elsewhere', { projectId: 'p2', project: 'Home' }),
  habit('h1', 'Stretch'),
  habit('h2', 'Coffee'),
];

describe('container asks', () => {
  it('fail closed: nothing is offered while nothing can answer', () => {
    expect(containerAsksFor({ canChat: false })).toEqual([]);
    expect(containerAsksFor({ canChat: true }).map((a) => a.id)).toEqual(['ask', 'plan']);
  });

  it("a project's members are its open, top-level items, by id or by folded name", () => {
    expect(containerAskSubject('project', project, ITEMS).members).toEqual(['Draft the deck', 'By name only']);
  });

  it("a routine keeps its own order, and says it in order", () => {
    const s = containerAskSubject('routine', routine, ITEMS);
    expect(s.members).toEqual(['Coffee', 'Stretch']);
    expect(CONTAINER_ASKS.plan.text(s)).toContain('It goes Coffee, then Stretch.');
  });

  it("a goal's members and target, a season's window", () => {
    const g = containerAskSubject('goal', goal, ITEMS);
    expect(g.members).toEqual(['Draft the deck']);
    expect(CONTAINER_ASKS.ask.text(g)).toBe('About my goal “Run a 10k” (aiming for 2027-03-01). It has Draft the deck. ');
    const s = containerAskSubject('season', season, ITEMS);
    expect(CONTAINER_ASKS.plan.text(s)).toBe(
      "Help me plan my “Summer” season (2027-06-01 to 2027-08-31). It's empty so far. What would help it go well?"
    );
  });

  it('labels follow the kind', () => {
    const label = (kind: ContainerAskSubject['kind']) => CONTAINER_ASKS.plan.label({ kind, name: 'x', members: [] });
    expect(label('project')).toBe('Break it down');
    expect(label('goal')).toBe('Break it down');
    expect(label('routine')).toBe('Help me plan this');
    expect(label('season')).toBe('Help me plan this');
    expect(CONTAINER_ASKS.ask.label({ kind: 'project', name: 'x', members: [] })).toBe('Ask about this…');
  });

  it('a long list is cut and counted', () => {
    const many = Array.from({ length: MAX_NAMED_MEMBERS + 3 }, (_, i) => `T${i}`);
    const text = CONTAINER_ASKS.plan.text({ kind: 'project', name: 'Big', members: many });
    expect(text).toContain(`T${MAX_NAMED_MEMBERS - 1} and 3 more.`);
    expect(text).not.toContain(`T${MAX_NAMED_MEMBERS},`);
  });

  it('copy contract: phrased as the user, no failure or lateness', () => {
    const subjects: ContainerAskSubject[] = (['project', 'routine', 'season', 'goal'] as const).flatMap((kind) => [
      { kind, name: 'X', members: [] },
      { kind, name: 'X', members: ['A', 'B'] },
    ]);
    for (const s of subjects) {
      for (const ask of Object.values(CONTAINER_ASKS)) {
        const text = ask.text(s);
        expect(text).toMatch(/\bmy\b/);
        expect(text).not.toMatch(/\b(overdue|late|behind|missed|failed|should have)\b/i);
      }
    }
  });
});

describe('selection ask', () => {
  const a = task('a', 'Call mum');
  const b = task('b', 'Book the dentist');

  it('names each item as a mention the send finds again, in order', () => {
    const text = selectionAskText([a, b], { canChat: true })!;
    expect(text).toBe('@Call mum @Book the dentist ');
    expect(mentionedItemIds(`${text}which first?`, [a, b])).toEqual(['a', 'b']);
  });

  it('is not offered when it could not carry every item', () => {
    expect(selectionAskText([a, b], { canChat: false })).toBeNull();
    expect(selectionAskText([a], { canChat: true })).toBeNull();
    const many = Array.from({ length: MAX_MENTIONED + 1 }, (_, i) => task(`m${i}`, `Item ${i}`));
    expect(selectionAskText(many, { canChat: true })).toBeNull();
    expect(selectionAskText(many.slice(0, MAX_MENTIONED), { canChat: true })).not.toBeNull();
    expect(selectionAskText([a, task('c', 'call MUM')], { canChat: true })).toBeNull();
    expect(selectionAskText([a, task('c', '  ')], { canChat: true })).toBeNull();
  });
});
