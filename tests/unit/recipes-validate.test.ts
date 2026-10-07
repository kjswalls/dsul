import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pure rules around a recipe: validateRecipe and parseRecipe
 * (lib/recipes/validate.ts), the builder's draft round trip
 * (lib/recipes/draft.ts), the stake slugs, and the goal map's move.
 */

import { parseRecipe, validateRecipe } from '@/lib/recipes/validate';
import { blankDraft, blankStep, draftToManifest, manifestToDraft } from '@/lib/recipes/draft';
import { STAKE_EXTENSION_SLUGS } from '@/lib/recipes/stake-lock';
import { matchesTrigger } from '@/lib/recipes/filters';
import { STAKE_ADAPTERS } from '@/lib/stakes/settle';
import * as beeminder from '@/lib/stakes/beeminder';
import * as goalMap from '@/lib/stakes/goal-map';
import { RecipeManifestSchema, type RecipeManifest } from '@/lib/mods/schema';

const env = { customTypeNames: ['errand'] };
const ID = '00000000-0000-4000-8000-000000000001';

const m = (over: Record<string, unknown>): RecipeManifest =>
  RecipeManifestSchema.parse({ version: 1, trigger: { on: 'item.completed' }, steps: [{ do: 'toast', text: 'x' }], ...over });

describe('validateRecipe', () => {
  it('passes a plain recipe', () => {
    expect(validateRecipe(m({}), env)).toEqual([]);
  });

  it('refuses item filters and "the item that started it" when no item starts it', () => {
    expect(validateRecipe(m({ trigger: { on: 'day.opened' }, filters: { types: ['task'] } }), env)).toEqual([
      'Item filters only work when an item starts the recipe.',
    ]);
    expect(validateRecipe(m({ trigger: { on: 'command' }, steps: [{ do: 'complete', item: 'trigger' }] }), env)).toEqual([
      'Pick an item for step 1.',
    ]);
    // Weekdays go with any trigger.
    expect(validateRecipe(m({ trigger: { on: 'review.saved' }, filters: { weekdays: [1] } }), env)).toEqual([]);
  });

  it('refuses "still open today" on a tick or a skip, which close the loop it asks about', () => {
    const problem = '"Still open today" never matches a tick or a skip.';
    for (const on of ['item.completed', 'item.skipped']) {
      expect(validateRecipe(m({ trigger: { on }, filters: { openToday: true } }), env)).toEqual([problem]);
    }
    for (const on of ['item.uncompleted', 'item.created']) {
      expect(validateRecipe(m({ trigger: { on }, filters: { openToday: true } }), env)).toEqual([]);
    }
  });

  it('refuses a time trigger and an anytime part of day', () => {
    expect(validateRecipe(m({ trigger: { on: 'time', at: '07:00' } }), env)).toEqual([
      'Recipes that run at a set time are not available yet.',
    ]);
    expect(validateRecipe(m({ trigger: { on: 'bucket.changed', bucket: 'anytime' } }), env)).toEqual([
      'Pick morning, afternoon or evening.',
    ]);
  });

  it('takes one of your themes by its slug, and refuses a slug of the wrong shape', () => {
    const steps = [
      { do: 'setTheme', mode: 'light', theme: 'u-abcdef01' },
      { do: 'setTheme', mode: 'dark', theme: 'u-abcdef01' },
      { do: 'setTheme', mode: 'light', theme: 'u-moss' },
    ];
    expect(validateRecipe(m({ steps }), env)).toEqual(['Pick a light theme for step 3.']);
  });

  it('takes one of your Looks by its ref, and refuses a ref of the wrong shape', () => {
    const steps = [
      { do: 'applyLook', look: 'u-abcdef01' },
      { do: 'applyLook', look: 'u-moss' },
      { do: 'applyLook', look: 'nothing' },
    ];
    expect(validateRecipe(m({ steps }), env)).toEqual(['Pick a Look for step 2.', 'Pick a Look for step 3.']);
  });

  it('refuses a habit, an unknown type, an unknown theme or Look', () => {
    const steps = [
      { do: 'create', type: 'habit', title: 'Daily' },
      { do: 'create', type: 'nope', title: 'X' },
      { do: 'create', type: 'errand', title: 'Fine' },
      { do: 'setTheme', mode: 'light', theme: 'night' },
      { do: 'setTheme', mode: 'dark', theme: 'night' },
      { do: 'applyLook', look: 'nothing' },
      { do: 'applyLook', look: 'console' },
    ];
    expect(validateRecipe(m({ steps }), env)).toEqual([
      'Step 1 cannot add habits.',
      'Step 2 adds a type that does not exist.',
      'Pick a light theme for step 4.',
      'Pick a Look for step 6.',
    ]);
  });

  it('parseRecipe: only a recipe row whose manifest passes both', () => {
    const ok = { kind: 'recipe' as const, manifest: { version: 1, trigger: { on: 'command' }, steps: [{ do: 'toast', text: 'x' }] } };
    expect(parseRecipe(ok, env)?.trigger.on).toBe('command');
    expect(parseRecipe({ ...ok, kind: 'mod' }, env)).toBeNull();
    expect(parseRecipe({ ...ok, manifest: { version: 2 } }, env)).toBeNull();
    expect(parseRecipe({ ...ok, manifest: { ...ok.manifest, trigger: { on: 'time', at: '07:00' } } }, env)).toBeNull();
  });
});

describe('matchesTrigger', () => {
  it('a part of day with no bucket set matches any part', () => {
    expect(matchesTrigger({ on: 'bucket.changed' }, { kind: 'bucket.changed', bucket: 'evening' })).toBe(true);
    expect(matchesTrigger({ on: 'bucket.changed', bucket: 'morning' }, { kind: 'bucket.changed', bucket: 'evening' })).toBe(false);
    expect(matchesTrigger({ on: 'time', at: '07:00' }, { kind: 'command' })).toBe(false);
  });
});

describe('the builder draft', () => {
  it('round-trips a manifest', () => {
    const manifest = m({
      trigger: { on: 'item.uncompleted' },
      filters: { types: ['task'], projects: ['Work', 'Home'], title: { contains: 'run' }, weekdays: [1, 3], openToday: true },
      steps: [
        { do: 'reschedule', item: 'trigger', inDays: 2 },
        { do: 'complete', item: { id: ID } },
        { do: 'create', type: 'task', title: 'Stretch', bucket: 'evening', project: 'Work' },
        { do: 'goto', scope: 'week', layout: 'schedule' },
        { do: 'setTheme', mode: 'dark', theme: 'dusk' },
      ],
    });
    const back = draftToManifest(manifestToDraft('Name', manifest), env);
    expect(back).toEqual({ ok: true, manifest });
  });

  it('says what is missing, per step, in plain words', () => {
    const draft = { ...blankDraft(), trigger: 'day.opened' as const, steps: [blankStep('complete', false), blankStep('toast'), blankStep('create')] };
    const r = draftToManifest(draft, env);
    expect(r).toEqual({
      ok: false,
      problems: ['Give it a name.', 'Pick an item for step 1.', 'Write the message for step 2.', 'Give the item in step 3 a title.'],
    });
  });

  it('drops "still open today" on a tick, where the form hides it', () => {
    const draft = { ...blankDraft(), name: 'A', trigger: 'item.completed' as const, openToday: true, steps: [{ ...blankStep('toast'), text: 'hi' }] };
    const r = draftToManifest(draft, env);
    expect(r.ok && r.manifest.filters).toEqual({});
  });

  it('drops hidden item filters when no item starts it', () => {
    const draft = { ...blankDraft(), name: 'A', trigger: 'day.opened' as const, title: 'run', openToday: true, steps: [{ ...blankStep('toast'), text: 'hi' }] };
    const r = draftToManifest(draft, env);
    expect(r.ok && r.manifest.filters).toEqual({});
  });
});

describe('stakes', () => {
  it('the extension slugs the lock reads are the stake adapters', () => {
    expect([...STAKE_EXTENSION_SLUGS].sort()).toEqual(STAKE_ADAPTERS.map((a) => a.extensionSlug).sort());
  });

  it('the goal map moved, and beeminder.ts re-exports the same functions', () => {
    expect(beeminder.parseGoalMap).toBe(goalMap.parseGoalMap);
    expect(beeminder.goalForTitle).toBe(goalMap.goalForTitle);
    expect(goalMap.goalForTitle({ goals: 'Vitamins: vit' }, '  vitamins ')).toBe('vit');
  });
});

describe('steps are verbs, never field writes', () => {
  it('lib/recipes calls no planner write but the one create', () => {
    const dir = join(process.cwd(), 'lib/recipes');
    for (const name of readdirSync(dir)) {
      const src = readFileSync(join(dir, name), 'utf8');
      const writes = src.match(/planner\(\)\.(\w+)\(/g) ?? [];
      expect(writes.filter((w) => w !== 'planner().addTasksBulk('), name).toEqual([]);
      expect(src, name).not.toMatch(/\.(toggleTaskStatus|toggleHabitStatus|setItem\w*|moveTask\w*|update\w*|delete\w*)\(/);
    }
  });
});
