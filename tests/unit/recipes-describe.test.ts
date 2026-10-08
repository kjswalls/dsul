import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { describeRecipe, recipeTouches, type RecipeLabels } from '@/lib/recipes/describe';
import { RecipeManifestSchema, type RecipeManifest, type RecipeStep } from '@/lib/mods/schema';
import { STEP_WORDS, TRIGGER_WORDS } from '@/lib/ai-server/make-prompt';

/** A recipe in plain words, for the "Write with AI" draft card (lib/recipes/describe.ts). */

const LABELS: RecipeLabels = { type: (n) => (n === 'task' ? 'Task' : n), theme: (r) => `theme ${r}`, look: (r) => `Look ${r}` };

const ONE_OF_EACH: RecipeStep[] = [
  { do: 'complete', item: 'trigger' },
  { do: 'skip', item: 'trigger' },
  { do: 'unskip', item: 'trigger' },
  { do: 'pause', item: 'trigger' },
  { do: 'resume', item: 'trigger' },
  { do: 'nextDay', item: 'trigger' },
  { do: 'reschedule', item: 'trigger', inDays: 2 },
  { do: 'braindump', item: 'trigger' },
  { do: 'create', type: 'task', title: 'Stretch', bucket: 'evening', project: 'Health' },
  { do: 'toast', text: 'Legs next' },
  { do: 'goto', scope: 'week', layout: 'schedule' },
  { do: 'organize' },
  { do: 'setTheme', mode: 'dark', theme: 'night' },
  { do: 'applyLook', look: 'console' },
];

const m = (over: Partial<RecipeManifest>): RecipeManifest =>
  RecipeManifestSchema.parse({ version: 1, trigger: { on: 'item.completed' }, steps: [{ do: 'organize' }], ...over });

describe('describeRecipe', () => {
  it('has words for every step and every trigger', () => {
    expect(ONE_OF_EACH.map((s) => s.do).sort()).toEqual(Object.keys(STEP_WORDS).sort());
    const d = describeRecipe(m({ steps: ONE_OF_EACH }), LABELS);
    expect(d.steps).toEqual([
      'Complete that item',
      'Skip that item today',
      'Unskip that item',
      'Pause that item',
      'Resume that item',
      'Move that item to the next day',
      'Move that item 2 days later',
      'Move that item to the braindump',
      'Add the task "Stretch", this evening, in Health',
      'Show the message "Legs next"',
      'Go to the week, as Schedule',
      'Open Organize',
      'Set the dark theme to theme night',
      'Apply the Look Look console',
    ]);
    for (const on of Object.keys(TRIGGER_WORDS)) {
      const trigger = on === 'time' ? { on, at: '07:00' } : { on };
      const when = describeRecipe(m({ trigger: trigger as never, steps: [{ do: 'organize' }] }), LABELS).when;
      expect(when, on).toMatch(/^(When|At) /);
      expect(when).not.toMatch(/\bi\b/);
    }
  });

  it('says when, and what must match', () => {
    const d = describeRecipe(
      m({
        filters: { types: ['task'], projects: ['Health'], title: { contains: 'Run' }, weekdays: [1, 3] },
      }),
      LABELS
    );
    expect(d.when).toBe('When I tick an item');
    expect(d.only).toEqual([
      'Only for task items',
      'Only in Health',
      'Only when the title has "Run"',
      'Only on Monday, Wednesday',
    ]);
    expect(describeRecipe(m({ trigger: { on: 'time', at: '07:30' }, steps: [{ do: 'create', type: 'task', title: 'x' }] }), LABELS, '12h').when).toBe(
      'At 7:30 am each day'
    );
    expect(describeRecipe(m({ trigger: { on: 'day.opened' } }), LABELS).when).toBe('When a new day starts');
  });
});

describe('recipeTouches', () => {
  it('one line per kind of reach', () => {
    expect(recipeTouches(m({ steps: [{ do: 'complete', item: 'trigger' }] }))).toEqual([
      'Changes the item that started it (completes, skips, moves or pauses it)',
    ]);
    expect(recipeTouches(m({ steps: [{ do: 'create', type: 'task', title: 'x' }] }))).toEqual(['Adds items']);
    expect(recipeTouches(m({ steps: [{ do: 'toast', text: 'x' }] }))).toEqual(['Shows a message']);
    expect(recipeTouches(m({ steps: [{ do: 'goto', scope: 'day', layout: 'list' }] }))).toEqual([
      'Changes the view or opens Organize',
    ]);
    expect(recipeTouches(m({ steps: [{ do: 'applyLook', look: 'dsul' }] }))).toEqual(['Changes your theme or Look']);
  });

  it('a timed recipe says it runs on the server, with dsul closed', () => {
    const touches = recipeTouches(m({ trigger: { on: 'time', at: '07:00' }, steps: [{ do: 'create', type: 'task', title: 'x' }] }));
    expect(touches).toEqual(['Adds items', "Runs on dsul's server at 07:00, even with dsul closed"]);
  });

  it('no em dash anywhere', () => {
    const all = [
      ...describeRecipe(m({ steps: ONE_OF_EACH }), LABELS).steps,
      ...recipeTouches(m({ steps: ONE_OF_EACH })),
    ].join(' ');
    expect(all).not.toMatch(/—/);
  });
});
