import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildDsulContext } from '@/lib/ai-context';
import { BEACON_SYSTEM_PROMPT, buildBeaconSystemPrompt } from '@/lib/beacon-system-prompt';
import type { Item } from '@/lib/planner-types';

/**
 * The Beacon chat context is a pinned presentation: the registry's per-type
 * renderContextSection functions must stay byte-identical to the
 * pre-unification builder. These tests lock the exact output.
 */

describe('buildDsulContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A Wednesday, well away from midnight in any plausible test TZ.
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)); // July 15 2026, local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const items: Item[] = [
    {
      type: 'task',
      id: 't1',
      title: 'Write report',
      status: 'pending',
      isScheduled: true,
      order: 0,
      startDate: '2026-07-15',
      project: 'Work',
      timeBucket: 'morning',
      priority: 'high',
    },
    {
      type: 'task',
      id: 't2',
      title: 'Old thing',
      status: 'pending',
      isScheduled: true,
      order: 1,
      startDate: '2026-07-10',
      priority: 'low',
    },
    {
      type: 'task',
      id: 't3',
      title: 'Done thing',
      status: 'completed',
      isScheduled: true,
      order: 2,
      startDate: '2026-07-15',
    },
    {
      type: 'habit',
      id: 'h1',
      title: 'Stretch',
      project: 'Wellness',
      streak: 4,
      status: 'pending',
      completedDates: ['2026-07-15'],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'daily',
    },
    {
      type: 'habit',
      id: 'h2',
      title: 'Read',
      project: 'Growth',
      streak: 0,
      status: 'pending',
      completedDates: [],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'daily',
    },
  ];

  it('renders the exact pre-unification presentation', () => {
    const out = buildDsulContext({ items, projects: [{ id: 'p1', name: 'Work', emoji: '' }] });
    expect(out).toBe(
      [
        '## dsul Context',
        'Date: Wednesday, July 15 2026',
        '',
        "### Today's Tasks",
        '**Pending**',
        '- Write report (Project: Work, Morning, High priority)',
        '**Completed today**',
        '- Done thing ✓',
        // "Still waiting" / "from", not "Overdue" / "was" — a deliberate tone
        // change to Beacon's prompt, made with the guilt-free pass over the
        // sunrise review. See the note at the push site in lib/item-registry.ts.
        // Everything else in this string is still the frozen pre-unification
        // presentation, and this assertion is still here to catch drift in it.
        '**Still waiting**',
        '- Old thing (from Jul 10, Low)',
        '',
        '### Habits',
        '- Stretch — 🔥 4 day streak — ✓ done today',
        '- Read — no streak — pending today',
        '',
        '### Projects',
        'Work',
      ].join('\n')
    );
  });

  it('names what is coming up and what sits in the braindump, which today alone never showed', () => {
    const task = (id: string, title: string, over: Record<string, unknown>): Item =>
      ({ type: 'task', id, title, status: 'pending', order: 0, ...over }) as Item;
    const out = buildDsulContext({
      items: [
        task('c2', 'Dentist', { isScheduled: true, startDate: '2026-07-20' }),
        task('c1', 'Call mum', { isScheduled: true, startDate: '2026-07-16', project: 'Home' }),
        task('far', 'Renew passport', { isScheduled: true, startDate: '2026-08-30' }),
        task('b1', 'Fix the bike', { isScheduled: false }),
        task('b2', 'Done idea', { isScheduled: false, status: 'completed' }),
        task('s1', 'A step', { isScheduled: false, parentItemId: 'b1' }),
        task('bucket', 'Anytime thing', { isScheduled: false, timeBucket: 'anytime' }),
        task('g1', 'Learn Mandarin', { type: 'custom', customType: 'goal', isScheduled: false }),
      ],
      projects: [],
    });
    expect(out).toContain(
      ['### Coming up (next 14 days)', '- Thu, Jul 16: Call mum (Project: Home)', '- Mon, Jul 20: Dentist'].join('\n')
    );
    expect(out).toContain('### Braindump');
    expect(out).toContain('- Fix the bike');
    // Further out than two weeks, finished, a subtask, or bucketed for a day: not listed there.
    expect(out).not.toContain('Renew passport');
    expect(out).not.toContain('Done idea');
    expect(out).not.toContain('A step');
    expect(out.split('### Braindump')[1]).not.toContain('Anytime thing');
    // A custom type's own section lists every one of them already.
    expect(out.split('### Braindump')[1]).not.toContain('Learn Mandarin');
  });

  it('caps a long braindump with a count', () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      ({ type: 'task', id: `b${i}`, title: `Idea ${i}`, status: 'pending', order: i, isScheduled: false }) as Item
    );
    const out = buildDsulContext({ items: many, projects: [] });
    expect(out).toContain('- Idea 39');
    expect(out).not.toContain('- Idea 40');
    expect(out).toContain('- +5 more');
  });

  it('renders the empty-state lines', () => {
    const out = buildDsulContext({ items: [], projects: [] });
    expect(out).toContain('No tasks scheduled for today.');
    expect(out).toContain('No habits tracked.');
    expect(out).toContain('No projects.');
  });
});

describe('BEACON_SYSTEM_PROMPT', () => {
  it('is pinned byte for byte, and names no assistant', () => {
    expect(BEACON_SYSTEM_PROMPT).toBe(
      'You are a warm and encouraging AI assistant built into dsul, a daily planner for neurodivergent people. ' +
        "Each message comes with a snapshot of the user's tasks, habits, and projects: today, anything overdue, the next two weeks, and the braindump (things captured with no day yet). " +
        'Finished work and anything further out are not in it. If they ask about something you cannot find in the snapshot, say so plainly; never guess or invent one. ' +
        'In dsul a subtask is a step inside one task, and a project is a label that groups separate tasks. ' +
        'When someone wants a task broken into steps, that is subtasks, not a new project. ' +
        'You cannot change the planner from this chat: "Break it down" on a task adds its steps, and "Turn this into a plan" under a reply turns what you suggested into changes they can accept. ' +
        'Help them plan their day, break down overwhelming tasks, celebrate progress, and stay focused. ' +
        'Be concise, warm, and never judgmental. When you reference their tasks or habits, be specific and use the names they gave them.'
    );
    // The AI has no name (decision 10): the model must not introduce itself as one.
    expect(BEACON_SYSTEM_PROMPT).not.toMatch(/\bBeacon\b/);
  });

  it('announces custom-type nouns when hydrated types are passed', () => {
    const prompt = buildBeaconSystemPrompt(['goals']);
    expect(prompt).toContain("snapshot of the user's tasks, habits, goals, and projects:");
    expect(prompt).toContain('reference their tasks, habits, or goals,');
  });

  it('with no custom types equals the exported default', () => {
    expect(buildBeaconSystemPrompt([])).toBe(BEACON_SYSTEM_PROMPT);
  });
});
