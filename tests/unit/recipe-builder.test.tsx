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
      for (const op of ['select', 'eq', 'is', 'order', 'limit', 'like']) b[op] = () => b;
      const data =
        table === 'mod_runs' ? runs.data : table === 'items' ? runs.items : table === 'projects' ? runs.projects : [];
      b.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve, reject);
      return b;
    },
  }),
}));
const revert = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/recipes/revert', () => ({ revertServerRun: revert.fn }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/make',
  useSearchParams: () => new URLSearchParams(),
}));

import { usePlannerStore } from '@/lib/planner-store';
import { MakePane } from '@/components/settings/make-pane';
import { useModsStore } from '@/lib/mods-store';
import { setUserThemesFromRows, useUserThemes } from '@/lib/user-themes/store';
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

  it('a timed recipe says when it runs, even with dsul closed, on the user’s own clock', () => {
    seed([
      recipeRow({
        manifest: { version: 1, trigger: { on: 'time', at: '19:00' }, filters: {}, steps: [{ do: 'create', type: 'task', title: 'x' }] },
      }),
    ]);
    const was = usePlannerStore.getState().timeFormat;
    usePlannerStore.setState({ timeFormat: '12h' });
    const { unmount } = render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('recipe-timed-hint').textContent).toBe('Runs at 7:00 pm, even with dsul closed');
    unmount();
    usePlannerStore.setState({ timeFormat: '24h' });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('recipe-timed-hint').textContent).toBe('Runs at 19:00, even with dsul closed');
    usePlannerStore.setState({ timeFormat: was });
  });
});

describe('At a time of day', () => {
  it('asks for the time, says it runs on the server, and offers only the steps it can run', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    expect(screen.queryByTestId('recipe-at')).toBeNull();
    change(screen.getByTestId('recipe-trigger'), 'time');
    expect(screen.getByTestId('recipe-at')).toBeTruthy();
    expect(screen.getByTestId('recipe-time-note').textContent).toContain('even with dsul closed');
    expect(screen.queryByTestId('recipe-phone-note')).toBeNull();
    const kinds = [...(screen.getByTestId('recipe-step-kind') as HTMLSelectElement).options].map((o) => o.value);
    // The step already there keeps its kind; the rest are the server's four.
    expect(kinds.sort()).toEqual(['complete', 'create', 'reschedule', 'skip', 'toast']);
  });

  it('refuses a screen step on save, in plain words', async () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-name'), 'Morning');
    change(screen.getByTestId('recipe-trigger'), 'time');
    change(screen.getByTestId('recipe-at'), '07:30');
    change(screen.getByTestId('recipe-step-text'), 'Hello');
    fireEvent.click(screen.getByTestId('recipe-save'));
    expect((await screen.findByTestId('recipe-problems')).textContent).toContain(
      "A recipe at a set time runs on dsul's server"
    );
  });

  it('item triggers say what a phone or reminder tick runs, worded per trigger', () => {
    seed();
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    expect(screen.getByTestId('recipe-phone-note').textContent).toBe(
      'When you tick from the iPhone app or a reminder, only add, complete, skip and reschedule steps run.'
    );
    change(screen.getByTestId('recipe-trigger'), 'item.created');
    expect(screen.getByTestId('recipe-phone-note').textContent).toBe(
      'When you add from the iPhone app, only add, complete, skip and reschedule steps run.'
    );
    change(screen.getByTestId('recipe-trigger'), 'item.skipped');
    expect(screen.getByTestId('recipe-phone-note').textContent).toBe(
      'When you skip from the iPhone app, only add, complete, skip and reschedule steps run.'
    );
    change(screen.getByTestId('recipe-trigger'), 'day.opened');
    expect(screen.queryByTestId('recipe-phone-note')).toBeNull();
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

  it('shows a server run, what it could not do, and offers Revert', async () => {
    const at = new Date().toISOString();
    const serverRun = {
      kind: 'run', server: true, day: '2026-10-07', trigger: 'time', did: 1, of: 1, skipped: 0, refused: 0, stopped: 0, ui: 2,
      steps: ['done'], undo: [['delete', '00000000-0000-4000-8000-000000000009']],
    };
    runs.data = [
      { claim_key: 'time:2026-10-07:07:30:done', summary: serverRun, at },
      { claim_key: 'item:item.completed:x:2026-10-06:done', summary: { ...serverRun, trigger: 'item.completed' }, at },
      { claim_key: 'revert:item:item.completed:x:2026-10-06:done', summary: { kind: 'claim' }, at },
      {
        claim_key: 'revert:item:item.completed:x:2026-10-06:done:done',
        summary: { kind: 'revert', of: 'item:item.completed:x:2026-10-06:done', did: 1, skipped: 0 },
        at,
      },
    ];
    revert.fn.mockResolvedValue('done');
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByText('Recent runs'));
    const list = await screen.findByTestId('recipe-runs-list');
    await waitFor(() => expect(within(list).getAllByTestId('recipe-run')).toHaveLength(2));
    const [first, second] = within(list).getAllByTestId('recipe-run');
    expect(first.textContent).toContain('on the server, 2 screen steps skipped (dsul was closed)');
    // The second was already reverted: no button, and it says so.
    expect(within(second).queryByTestId('recipe-run-revert')).toBeNull();
    expect(second.textContent).toContain('Reverted');

    fireEvent.click(within(first).getByTestId('recipe-run-revert'));
    await waitFor(() => expect(first.textContent).toContain('Reverted'));
    expect(revert.fn).toHaveBeenCalledWith(
      expect.any(String),
      'After run',
      expect.objectContaining({ claimKey: 'time:2026-10-07:07:30:done' })
    );
    expect(within(first).queryByTestId('recipe-run-revert')).toBeNull();
  });

  it('says what to do when the planner is not loaded to revert into', async () => {
    runs.data = [
      {
        claim_key: 'time:2026-10-07:07:30:done',
        summary: { kind: 'run', server: true, trigger: 'time', did: 1, of: 1, skipped: 0, refused: 0, stopped: 0, steps: ['done'], undo: [['delete', '00000000-0000-4000-8000-000000000009']] },
        at: new Date().toISOString(),
      },
    ];
    revert.fn.mockResolvedValue('unavailable');
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByText('Recent runs'));
    fireEvent.click(await screen.findByTestId('recipe-run-revert'));
    expect(await screen.findByText(/Open your planner first/)).toBeTruthy();
  });

  it('marks a run Reverted only by the Revert’s own result row, never the bare claim', async () => {
    const at = new Date().toISOString();
    const serverRun = {
      kind: 'run', server: true, trigger: 'time', did: 1, of: 1, skipped: 0, refused: 0, stopped: 0,
      steps: ['done'], undo: [['delete', '00000000-0000-4000-8000-000000000009']],
    };
    runs.data = [
      { claim_key: 'time:a:done', summary: serverRun, at },
      { claim_key: 'time:b:done', summary: serverRun, at },
      { claim_key: 'time:c:done', summary: { ...serverRun, undo: undefined, revertable: false }, at },
      { claim_key: 'revert:time:a:done', summary: { kind: 'claim' }, at },
      { claim_key: 'revert:time:b:done', summary: { kind: 'claim' }, at },
      {
        claim_key: 'revert:time:b:done:done',
        summary: { kind: 'revert', of: 'time:b:done', did: 0, skipped: 1, failed: 'planner-not-ready' },
        at,
      },
    ];
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByText('Recent runs'));
    const list = await screen.findByTestId('recipe-runs-list');
    await waitFor(() => expect(within(list).getAllByTestId('recipe-run')).toHaveLength(3));
    const [a, b, c] = within(list).getAllByTestId('recipe-run');
    expect(a.textContent).toContain('Revert started on another tab or device.');
    expect(a.textContent).not.toContain('Reverted');
    expect(b.textContent).toContain('Revert failed');
    expect(c.textContent).toContain('too large to revert');
    expect(within(list).queryByTestId('recipe-run-revert')).toBeNull();
  });

  it.each([
    ['failed', 'Couldn’t revert this run.'],
    ['nothing', 'Nothing left to put back.'],
  ] as const)('words a %s Revert apart from a planner not loaded', async (out, copy) => {
    runs.data = [
      {
        claim_key: 'time:2026-10-07:07:30:done',
        summary: { kind: 'run', server: true, trigger: 'time', did: 1, of: 1, skipped: 0, refused: 0, stopped: 0, steps: ['done'], undo: [['delete', '00000000-0000-4000-8000-000000000009']] },
        at: new Date().toISOString(),
      },
    ];
    revert.fn.mockResolvedValue(out);
    seed([recipeRow()]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByText('Recent runs'));
    fireEvent.click(await screen.findByTestId('recipe-run-revert'));
    expect(await screen.findByText(new RegExp(copy))).toBeTruthy();
    expect(screen.queryByText(/Open your planner first/)).toBeNull();
    expect(screen.queryByText(/Reverted/)).toBeNull();
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

describe('the theme step and your themes', () => {
  afterEach(() => useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' }));

  it('offers your enabled themes of that mode under Yours', () => {
    seed();
    setUserThemesFromRows(
      [
        {
          id: 'abcdef01-2345-4678-9abc-def012345678',
          userId: USER,
          kind: 'theme',
          slug: 'u-abcdef01',
          name: 'Moss',
          enabled: true,
          manifest: { version: 1, mode: 'light', base: 'paper', tokens: {} },
          disabledReason: null,
          createdAt: '2026-10-07T00:00:00Z',
          updatedAt: '2026-10-07T00:00:00Z',
        },
      ],
      false
    );
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-step-kind'), 'setTheme');
    const select = screen.getByRole('combobox', { name: 'Theme for step 1' }) as HTMLSelectElement;
    const group = select.querySelector('optgroup[label="Yours"]');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByRole('option', { name: 'Moss' }).getAttribute('value')).toBe('u-abcdef01');
    // The dark side has none.
    change(screen.getByRole('combobox', { name: 'Light or dark for step 1' }), 'dark');
    expect(
      (screen.getByRole('combobox', { name: 'Theme for step 1' }) as HTMLSelectElement).querySelector('optgroup')
    ).toBeNull();
  });

  it('keeps a saved step’s theme that is now off, and says so', () => {
    seed([
      recipeRow({
        manifest: { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'setTheme', mode: 'light', theme: 'u-deadbeef' }] },
      }),
    ]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit After run' }));
    const select = screen.getByRole('combobox', { name: 'Theme for step 1' }) as HTMLSelectElement;
    expect(select.value).toBe('u-deadbeef');
    expect(within(select).getByRole('option', { name: 'Your theme (off)' })).toBeTruthy();
  });
});

describe('the Look step and your Looks', () => {
  const lookRow = (id: string, name: string, enabled = true): UserMod => ({
    id,
    userId: USER,
    kind: 'look',
    slug: `u-${id.replace(/-/g, '').slice(0, 8)}`,
    name,
    enabled,
    manifest: { version: 1, layout: 'writer', light: 'paper', dark: 'night' },
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
  });

  it('lists your enabled Looks under Yours, by ref', () => {
    seed([lookRow('abcdef01-2345-4678-9abc-def012345678', 'Deep work'), lookRow('bbbbbbbb-2345-4678-9abc-def012345678', 'Resting', false)]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-recipe'));
    change(screen.getByTestId('recipe-step-kind'), 'applyLook');
    const select = screen.getByRole('combobox', { name: 'Look for step 1' }) as HTMLSelectElement;
    const group = select.querySelector('optgroup[label="Yours"]') as HTMLElement;
    expect(group).not.toBeNull();
    expect(within(group).getByRole('option', { name: 'Deep work' }).getAttribute('value')).toBe('u-abcdef01');
    expect(within(group).queryByRole('option', { name: 'Resting' })).toBeNull();
  });

  it('keeps a saved step’s Look that is now off, says so, and saves it back unchanged', async () => {
    const r = recipeRow({
      manifest: { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'applyLook', look: 'u-bbbbbbbb' }] },
    });
    seed([r, lookRow('bbbbbbbb-2345-4678-9abc-def012345678', 'Resting', false)]);
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit After run' }));
    const select = screen.getByRole('combobox', { name: 'Look for step 1' }) as HTMLSelectElement;
    expect(select.value).toBe('u-bbbbbbbb');
    expect(within(select).getByRole('option', { name: 'Resting (off)' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(saveRecipe).toHaveBeenCalled());
    expect(saveRecipe).toHaveBeenCalledWith(r.id, {
      name: 'After run',
      manifest: expect.objectContaining({ steps: [{ do: 'applyLook', look: 'u-bbbbbbbb' }] }),
    });
  });
});
