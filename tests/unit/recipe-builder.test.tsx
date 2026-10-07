// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings → Make's recipe form (components/settings/recipe-builder.tsx) and
 * its recent runs (recipe-runs.tsx), drawn inside the real MakePane.
 */

const runs = vi.hoisted(() => ({ data: [] as unknown[], items: [] as unknown[], projects: [] as unknown[] }));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'is', 'order', 'limit']) b[op] = () => b;
      const data =
        table === 'mod_runs' ? runs.data : table === 'items' ? runs.items : table === 'projects' ? runs.projects : [];
      b.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve, reject);
      return b;
    },
  }),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/make',
  useSearchParams: () => new URLSearchParams(),
}));

import { MakePane } from '@/components/settings/make-pane';
import { useModsStore } from '@/lib/mods-store';
import type { UserMod } from '@/lib/mods/schema';
import type { SettingCtx } from '@/lib/settings/manifest';

const USER = 'test-user';
const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: USER };

const createRecipe = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
const saveRecipe = vi.fn(async () => true);

function recipeRow(over: Partial<UserMod> = {}): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: USER,
    kind: 'recipe',
    slug: 'after-run',
    name: 'After run',
    enabled: false,
    manifest: { version: 1, trigger: { on: 'item.completed' }, filters: { title: { contains: 'run' } }, steps: [{ do: 'toast', text: 'Legs next' }] },
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    ...over,
  };
}

function seed(rows: UserMod[] = []) {
  useModsStore.setState({ available: true, loaded: true, failed: false, rows, safeMode: false, hydratedUserId: USER, createRecipe, saveRecipe });
}

beforeEach(() => {
  createRecipe.mockClear();
  saveRecipe.mockClear();
  runs.data = [];
  runs.items = [];
  runs.projects = [];
});
afterEach(cleanup);

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('New recipe', () => {
  it('opens the form; a new day hides the item filters', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    expect(screen.getByTestId('recipe-builder')).toBeTruthy();
    expect(screen.getByTestId('recipe-item-filters')).toBeTruthy();
    change(screen.getByTestId('recipe-trigger'), 'day.opened');
    expect(screen.queryByTestId('recipe-item-filters')).toBeNull();
  });

  it('offers "still open today" only where it can match: not on a tick or a skip', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    expect(screen.queryByTestId('recipe-filter-open-today')).toBeNull();
    change(screen.getByTestId('recipe-trigger'), 'item.skipped');
    expect(screen.queryByTestId('recipe-filter-open-today')).toBeNull();
    change(screen.getByTestId('recipe-trigger'), 'item.uncompleted');
    expect(screen.getByTestId('recipe-filter-open-today')).toBeTruthy();
  });

  it('says that item changes run before messages, views and themes', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    expect(screen.getByTestId('recipe-steps-note').textContent).toBe(
      'Steps that change items happen first. Messages, views and themes come after.'
    );
    expect(screen.getByRole('group', { name: 'Type' })).toBeTruthy();
  });

  it('Cancel puts focus back on New recipe', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByTestId('make-new-recipe'));
  });

  it('a step with nothing picked says so and saves nothing', async () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-name'), 'Morning');
    change(screen.getByTestId('recipe-trigger'), 'day.opened');
    change(screen.getByTestId('recipe-step-kind'), 'complete');
    fireEvent.click(screen.getByTestId('recipe-save'));
    expect(screen.getByTestId('recipe-problems').textContent).toContain('Pick an item for step 1.');
    expect(createRecipe).not.toHaveBeenCalled();
  });

  it('a good save sends a parsed manifest, and says it is saved off', async () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-name'), 'Legs');
    change(screen.getByTestId('recipe-filter-title'), 'Run');
    change(screen.getByTestId('recipe-step-text'), 'Legs next');
    fireEvent.click(screen.getByTestId('recipe-add-step'));
    change(screen.getAllByTestId('recipe-step-kind')[1], 'create');
    change(screen.getByTestId('recipe-step-title'), 'Stretch 10 min');
    fireEvent.click(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(createRecipe).toHaveBeenCalled());
    expect(createRecipe).toHaveBeenCalledWith(USER, {
      name: 'Legs',
      manifest: {
        version: 1,
        trigger: { on: 'item.completed' },
        filters: { title: { contains: 'Run' } },
        steps: [
          { do: 'toast', text: 'Legs next' },
          { do: 'create', type: 'task', title: 'Stretch 10 min' },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId('make-notice').textContent).toBe('Saved. Switch it on to run it.'));
  });

  it('moves and removes steps', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    fireEvent.click(screen.getByTestId('recipe-add-step'));
    change(screen.getAllByTestId('recipe-step-kind')[1], 'organize');
    fireEvent.click(screen.getByLabelText('Move step 2 up'));
    expect(screen.getAllByTestId('recipe-step-kind').map((s) => (s as HTMLSelectElement).value)).toEqual(['organize', 'toast']);
    fireEvent.click(screen.getByLabelText('Remove step 1'));
    expect(screen.getAllByTestId('recipe-step-kind').map((s) => (s as HTMLSelectElement).value)).toEqual(['toast']);
  });
});

describe('pick lists', () => {
  it('offers items and projects it fetched itself, never the planner store', async () => {
    const ID = '00000000-0000-4000-8000-000000000001';
    runs.items = [{ id: ID, title: 'Water the plants' }];
    runs.projects = [{ id: 'p1', name: 'Home', emoji: '', created_at: '2026-01-01', user_id: USER }];
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-step-kind'), 'complete');
    await screen.findByRole('option', { name: 'Water the plants' });
    change(screen.getByTestId('recipe-step-item'), ID);
    expect((screen.getByTestId('recipe-step-item') as HTMLSelectElement).value).toBe(ID);
    expect(document.querySelector('#recipe-projects option[value="Home"]')).toBeTruthy();
    const src = readFileSync(join(process.cwd(), 'components/settings/recipe-builder.tsx'), 'utf8');
    expect(src).not.toMatch(/usePlannerStore/);
  });
});

describe('Edit', () => {
  it('pre-fills and saves through saveRecipe', async () => {
    const r = recipeRow();
    seed([r]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByLabelText('Edit After run'));
    expect((screen.getByTestId('recipe-name') as HTMLInputElement).value).toBe('After run');
    expect((screen.getByTestId('recipe-filter-title') as HTMLInputElement).value).toBe('run');
    expect((screen.getByTestId('recipe-step-text') as HTMLInputElement).value).toBe('Legs next');
    change(screen.getByTestId('recipe-step-text'), 'Now legs');
    fireEvent.click(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(saveRecipe).toHaveBeenCalled());
    expect(saveRecipe).toHaveBeenCalledWith(r.id, {
      name: 'After run',
      manifest: expect.objectContaining({ steps: [{ do: 'toast', text: 'Now legs' }] }),
    });
    expect(createRecipe).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('make-notice').textContent).toBe('Saved.'));
    expect(document.activeElement).toBe(screen.getByLabelText('Edit After run'));
  });

  it('a switched-on recipe that the store saved off says so', async () => {
    const r = recipeRow({ enabled: true });
    seed([r]);
    saveRecipe.mockImplementationOnce(async () => {
      useModsStore.setState((st) => ({ rows: st.rows.map((x) => ({ ...x, enabled: false })) }));
      return true;
    });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByLabelText('Edit After run'));
    change(screen.getByTestId('recipe-step-text'), 'Now legs');
    fireEvent.click(screen.getByTestId('recipe-save'));
    await waitFor(() =>
      expect(screen.getByTestId('make-notice').textContent).toBe('Saved and switched off. Switch it on to run it.')
    );
  });

  it('a step field is named by its visible label first', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-step-kind'), 'complete');
    expect(screen.getByLabelText('Which item, step 1')).toBeTruthy();
  });

  it('a timed recipe says it waits', () => {
    seed([recipeRow({ manifest: { version: 1, trigger: { on: 'time', at: '07:00' }, filters: {}, steps: [{ do: 'toast', text: 'x' }] } })]);
    render(<MakePane ctx={ctx} />);
    expect(screen.getByText('Runs at a set time. Not available yet.')).toBeTruthy();
  });
});

describe('Recent runs', () => {
  it('lists result rows only, plainly', async () => {
    runs.data = [
      { claim_key: 'day:2026-10-07:done', summary: { kind: 'run', trigger: 'day.opened', did: 3, of: 3, skipped: 0, refused: 0, stopped: 0, steps: [] }, at: new Date().toISOString() },
      { claim_key: 'day:2026-10-07', summary: { kind: 'claim' }, at: new Date().toISOString() },
      { claim_key: 'run:x', summary: { kind: 'run', trigger: 'command', did: 1, of: 2, skipped: 1, refused: 0, stopped: 0, steps: [] }, at: new Date().toISOString() },
    ];
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    const button = screen.getByRole('button', { name: 'Recent runs for After run' });
    fireEvent.click(button);
    const list = await screen.findByTestId('recipe-runs-list');
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const lines = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines[0]).toMatch(/^Did 3 of 3 · /);
    expect(lines[1]).toMatch(/^Did 1 of 2, skipped 1 · /);
  });

  it('says when there are none', async () => {
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByText('Recent runs'));
    expect(await screen.findByText('No runs yet.')).toBeTruthy();
  });
});

describe('copy', () => {
  it('has no em dash and never says Beacon', () => {
    for (const file of ['components/settings/recipe-builder.tsx', 'components/settings/recipe-runs.tsx', 'lib/recipes/draft.ts', 'lib/recipes/validate.ts', 'lib/recipes/engine.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      // String literals only would be stricter; the whole file is simpler and holds.
      expect(src, file).not.toMatch(/—/);
      expect(src, file).not.toMatch(/beacon/i);
    }
  });
});
