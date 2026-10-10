import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * "Write with AI" in Settings → Make (components/settings/make-write.tsx and
 * its place in make-pane.tsx): shown only on `canMake`, no AI call but the
 * Write press, a checked draft as a card, Install saving switched off, Edit
 * opening the builder prefilled, and plain words when the reply is no use.
 */

const h = vi.hoisted(() => ({
  inputs: null as null | Record<string, unknown>,
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  search: '',
  sandbox: {
    status: 'idle' as string,
    ensure: null as null | (() => Promise<string>),
    scratch: null as null | ((source: string) => Promise<unknown>),
  },
}));

// The mod sandbox, as Write sees it: what ensure() and scratch() answer.
vi.mock('@/lib/mods/sandbox-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mods/sandbox-host')>();
  return {
    ...actual,
    modSandbox: {
      ...actual.modSandbox,
      status: () => h.sandbox.status,
      ensure: () => h.sandbox.ensure!(),
      scratch: (source: string) => h.sandbox.scratch!(source),
    },
  };
});

vi.mock('@/lib/ai-connection-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-connection-store')>();
  const { resolveAICapabilities, NO_AI } = await import('@/lib/ai-registry');
  const caps = () => (h.inputs ? resolveAICapabilities(h.inputs as never) : NO_AI);
  return { ...actual, useAICapabilities: () => caps(), getAICapabilities: () => caps() };
});

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'in', 'gte', 'like']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.insert = async (payload: Record<string, unknown>) => {
      h.inserts.push({ table, payload });
      return { error: null };
    };
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return b;
  };
  return { createClient: () => ({ from: builder, auth: { getUser: async () => ({ data: { user: null } }) } }) };
});

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItemTypes: vi.fn(async () => [{ name: 'chore', label: 'Chore' }]),
    fetchProjects: vi.fn(async () => []),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/make',
  useSearchParams: () => new URLSearchParams(h.search),
}));

import { MakePane } from '@/components/settings/make-pane';
import {
  CUT_SHORT_COPY,
  MakeWrite,
  UNREADABLE_COPY,
  WRITE_SANDBOX_RETRY_COPY,
  WRITE_SANDBOX_WORDS,
} from '@/components/settings/make-write';
import { useModsStore } from '@/lib/mods-store';
import { useUserThemes } from '@/lib/user-themes/store';
import { DRAFT_SLUG } from '@/lib/user-themes/css';
import { CONTRAST_PROBLEM } from '@/lib/make-draft';
import { MAKE_EXAMPLES } from '@/lib/ai-server/make-prompt';
import type { SettingCtx } from '@/lib/settings/manifest';
import { MOD_TEMPLATE } from '@/lib/mods/template';

const USER = '11111111-1111-4111-8111-111111111111';
const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: USER };

const MODEL_OK = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: null,
  authMethod: 'key',
  status: 'ok',
  problem: null,
  checkedAt: null,
};
const NO_OPENCLAW = { gateway: false, pluginChat: false, agent: false, agentId: null };
const READY = { phase: 'ready', available: true, model: MODEL_OK, openclaw: NO_OPENCLAW, choice: 'model', aiHidden: false };

const ACTIONS = {
  createRecipe: useModsStore.getState().createRecipe,
  createTheme: useModsStore.getState().createTheme,
  createLook: useModsStore.getState().createLook,
  hydrate: useModsStore.getState().hydrate,
};

let fetchSpy: ReturnType<typeof vi.fn>;
function replyWith(obj: unknown) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const half = Math.floor(text.length / 2);
  const body = [text.slice(0, half), text.slice(half)].map((c) => `data: ${JSON.stringify({ content: c })}\n\n`).join('');
  fetchSpy.mockResolvedValueOnce(new Response(body + 'data: [DONE]\n\n', { status: 200 }));
}

beforeEach(() => {
  h.inputs = { ...READY };
  h.inserts = [];
  h.search = '';
  h.sandbox.status = 'idle';
  h.sandbox.ensure = vi.fn(async () => 'ready');
  h.sandbox.scratch = vi.fn(async () => {
    throw new Error('unexpected scratch');
  });
  useModsStore.getState().reset();
  useModsStore.setState({ ...ACTIONS, available: true, loaded: true, failed: false, hydratedUserId: USER, rows: [], safeMode: false });
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
  fetchSpy = vi.fn(async () => {
    throw new Error('unexpected fetch');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const write = (onEdit = vi.fn()) => render(<MakeWrite userId={USER} onEdit={onEdit} />);
const ask = (text: string) => fireEvent.change(screen.getByTestId('make-write-ask'), { target: { value: text } });
const press = () => fireEvent.click(screen.getByTestId('make-write-go'));

describe('the gate', () => {
  it.each([
    ['unknown', { phase: 'unknown' }],
    ['a failed status read', { phase: 'error' }],
    ['OpenClaw only', { model: null, openclaw: { gateway: true, pluginChat: false, agent: true, agentId: 'a' } }],
    ['a failing model', { model: { ...MODEL_OK, status: 'failing' } }],
    ['"No AI, thanks"', { aiHidden: true }],
    ['OpenClaw chosen on this device', { choice: 'openclaw', openclaw: { gateway: true, pluginChat: false, agent: true, agentId: 'a' } }],
  ])('hidden while %s', (_label, over) => {
    h.inputs = { ...READY, ...over };
    write();
    expect(screen.queryByTestId('make-write')).toBeNull();
  });

  it('shown for a working model of this device', () => {
    write();
    expect(screen.getByTestId('make-write')).toBeTruthy();
    expect(screen.getByTestId('make-write-ask').getAttribute('maxLength')).toBe('1000');
    expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(true);
  });

  it('is in Make above the New buttons only when canMake', async () => {
    render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('make-write')).toBeTruthy();
    cleanup();
    h.inputs = { ...READY, model: null };
    render(<MakePane ctx={ctx} />);
    expect(screen.queryByTestId('make-write')).toBeNull();
    expect(screen.getByTestId('make-new-recipe')).toBeTruthy();
  });
});

describe('cost: only the press calls', () => {
  it('no call on mount, typing, a kind change, or ?write=theme; exactly one per press', async () => {
    h.search = 'write=theme';
    render(<MakePane ctx={ctx} />);
    expect((screen.getByTestId('make-write-kind') as HTMLSelectElement).value).toBe('theme');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('make-write-ask')));
    ask('A calm green paper');
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'look' } });
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'theme' } });
    expect((screen.getByTestId('make-write-ask') as HTMLTextAreaElement).value).toBe('A calm green paper');
    expect(fetchSpy).not.toHaveBeenCalled();

    replyWith(MAKE_EXAMPLES.theme);
    press();
    await screen.findByTestId('make-draft');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ kind: 'theme', ask: 'A calm green paper' });
  });

  it('the ask is never taken from the URL', () => {
    h.search = 'write=recipe&ask=hello';
    render(<MakePane ctx={ctx} />);
    expect((screen.getByTestId('make-write-ask') as HTMLTextAreaElement).value).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the draft card', () => {
  it('a recipe: plain steps, what it can touch, its source on demand', async () => {
    write();
    ask('When I tick Run, add Stretch');
    replyWith(MAKE_EXAMPLES.recipe);
    press();
    const card = await screen.findByTestId('make-draft');
    expect(screen.getByTestId('make-draft-name').textContent).toBe('After a run, stretch');
    const recipe = screen.getByTestId('make-draft-recipe').textContent!;
    expect(recipe).toContain('When I tick an item');
    expect(recipe).toContain('Only when the title has "Run"');
    expect(recipe).toContain('Add the task "Stretch 10 min", this evening');
    expect(recipe).toContain('Show the message "Legs next"');
    expect(screen.getByTestId('make-draft-touches').textContent).toContain('Adds items');
    expect(card.textContent).not.toMatch(/—/);
    expect(screen.queryByTestId('make-draft-source')).toBeNull();
    fireEvent.click(screen.getByTestId('make-draft-source-toggle'));
    const source = JSON.parse(screen.getByTestId('make-draft-source').textContent!);
    expect(source).toMatchObject({ version: 1, trigger: { on: 'item.completed' } });
  });

  it('a theme: a miniature through the preview twin, cleared when the card goes', async () => {
    write();
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'theme' } });
    ask('Moss');
    replyWith(MAKE_EXAMPLES.theme);
    press();
    await screen.findByTestId('make-draft-theme');
    await waitFor(() => expect(useUserThemes.getState().draft?.slug).toBe(DRAFT_SLUG));
    expect(screen.getByTestId('make-draft-theme').textContent).toContain('A light theme, starting from Paper');
    expect(screen.getByTestId('make-draft-touches').textContent).toContain('Only colours');
    fireEvent.click(screen.getByTestId('make-draft-discard'));
    expect(screen.queryByTestId('make-draft')).toBeNull();
    await waitFor(() => expect(useUserThemes.getState().draft).toBeNull());
  });

  it('a Look: its layout and both themes', async () => {
    write();
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'look' } });
    ask('Notebook');
    replyWith(MAKE_EXAMPLES.look);
    press();
    const look = await screen.findByTestId('make-draft-look');
    expect(look.textContent).toContain('Notebook.');
    expect(look.textContent).toContain('By day Paper, at night Night.');
    expect(screen.getByTestId('make-draft-touches').textContent).toContain('Your layout and your day and night themes');
  });

  it('problems hold Install; Edit still opens', async () => {
    const onEdit = vi.fn();
    write(onEdit);
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'theme' } });
    ask('Faint');
    replyWith({ kind: 'theme', name: 'Faint', manifest: { version: 1, mode: 'light', base: 'paper', tokens: { ink0: '#f0f0f0' }, contrastOverride: true } });
    press();
    expect((await screen.findByTestId('make-draft-problems')).textContent).toContain(CONTRAST_PROBLEM);
    expect(screen.getByTestId('make-draft-install').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    expect(onEdit).toHaveBeenCalledWith({
      kind: 'theme',
      initial: { name: 'Faint', manifest: expect.not.objectContaining({ contrastOverride: true }) },
    });
  });
});

describe('Install', () => {
  it('a failed save says why and leaves Install pressable; the retry saves', async () => {
    write();
    ask('When I tick Run, add Stretch');
    replyWith(MAKE_EXAMPLES.recipe);
    press();
    await screen.findByTestId('make-draft');
    const real = useModsStore.getState().createRecipe;
    let calls = 0;
    const flaky: typeof real = async (userId, input) =>
      ++calls === 1 ? { ok: false, reason: 'Could not save it. Try again.' } : real(userId, input);
    useModsStore.setState({ createRecipe: flaky });
    await act(async () => {
      fireEvent.click(screen.getByTestId('make-draft-install'));
    });
    expect((await screen.findByTestId('make-draft-install-error')).textContent).toBe('Could not save it. Try again.');
    expect(screen.queryByTestId('make-draft-problems')).toBeNull();
    expect(screen.getByTestId('make-draft-install').hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('make-draft-install'));
    });
    await waitFor(() => expect(h.inserts).toHaveLength(1));
    expect(await screen.findByTestId('make-write-notice')).toBeTruthy();
    expect(screen.queryByTestId('make-draft')).toBeNull();
  });

  it('saves through the store, switched off', async () => {
    write();
    ask('When I tick Run, add Stretch');
    replyWith(MAKE_EXAMPLES.recipe);
    press();
    await screen.findByTestId('make-draft');
    await act(async () => {
      fireEvent.click(screen.getByTestId('make-draft-install'));
    });
    await waitFor(() => expect(h.inserts).toHaveLength(1));
    expect(h.inserts[0]).toMatchObject({
      table: 'user_mods',
      payload: { kind: 'recipe', name: 'After a run, stretch', enabled: false, user_id: USER },
    });
    expect(h.inserts[0].payload.manifest).toEqual((MAKE_EXAMPLES.recipe.manifest as object));
    expect(await screen.findByTestId('make-write-notice')).toBeTruthy();
    expect(screen.getByTestId('make-write-notice').textContent).toBe('Saved. It starts switched off.');
    expect(screen.queryByTestId('make-draft')).toBeNull();
    expect(useModsStore.getState().rows[0]).toMatchObject({ kind: 'recipe', enabled: false });
  });

  it.each(['theme', 'look'] as const)('a %s is saved switched off too', async (kind) => {
    write();
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: kind } });
    ask('x');
    replyWith(MAKE_EXAMPLES[kind]);
    press();
    await screen.findByTestId('make-draft');
    await act(async () => {
      fireEvent.click(screen.getByTestId('make-draft-install'));
    });
    await waitFor(() => expect(h.inserts).toHaveLength(1));
    expect(h.inserts[0].payload).toMatchObject({ kind, enabled: false });
  });
});

describe('Edit opens the builder prefilled', () => {
  it('a recipe draft opens a new recipe with its name and steps', async () => {
    render(<MakePane ctx={ctx} />);
    ask('When I tick Run, add Stretch');
    replyWith(MAKE_EXAMPLES.recipe);
    press();
    await screen.findByTestId('make-draft');
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    expect(screen.getByTestId('recipe-builder')).toBeTruthy();
    expect(screen.getByText('New recipe')).toBeTruthy();
    expect((screen.getByTestId('recipe-name') as HTMLInputElement).value).toBe('After a run, stretch');
    expect(screen.getByDisplayValue('Stretch 10 min')).toBeTruthy();
    expect(screen.getByTestId('make-write').hidden).toBe(true);
  });

  it('Cancel comes back to the same card, focus on its Edit, with no second call', async () => {
    render(<MakePane ctx={ctx} />);
    ask('When I tick Run, add Stretch');
    replyWith(MAKE_EXAMPLES.recipe);
    press();
    await screen.findByTestId('make-draft');
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('make-write').hidden).toBe(false);
    expect(screen.getByTestId('make-draft-name').textContent).toBe('After a run, stretch');
    expect((screen.getByTestId('make-write-ask') as HTMLTextAreaElement).value).toBe('When I tick Run, add Stretch');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('make-draft-edit')));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a theme draft in the editor leaves the draft slot to the editor\'s preview', async () => {
    render(<MakePane ctx={ctx} />);
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'theme' } });
    ask('Moss');
    replyWith(MAKE_EXAMPLES.theme);
    press();
    await screen.findByTestId('make-draft-theme');
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    expect(screen.getByTestId('theme-builder')).toBeTruthy();
    // The card's miniature is gone; only the theme editor draws the draft.
    expect(screen.getByTestId('make-draft-theme').children).toHaveLength(1);
    await waitFor(() => expect(useUserThemes.getState().draft?.slug).toBe(DRAFT_SLUG));
  });
});

describe('focus and announcements', () => {
  it('a draft takes focus on its heading, a failure on its message; the box stays read-only, not disabled, while it runs', async () => {
    write();
    ask('make it nice');
    let release!: (r: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((ok) => (release = ok)));
    press();
    const box = screen.getByTestId('make-write-ask') as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.disabled).toBe(false);
    await act(async () => release(new Response('data: {"content":"nope"}\n\ndata: [DONE]\n\n', { status: 200 })));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('make-write-error')));

    replyWith(MAKE_EXAMPLES.recipe);
    fireEvent.click(screen.getByTestId('make-write-retry'));
    const title = await screen.findByTestId('make-draft-name');
    expect(title.tagName).toBe('H3');
    expect(screen.getByRole('region', { name: 'After a run, stretch' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(title));
  });
});

describe('when the gate closes mid-write', () => {
  it('the request is aborted and no draft lands, even if AI comes back', async () => {
    const { rerender } = write();
    ask('x');
    let signal!: AbortSignal;
    let release!: (r: Response) => void;
    fetchSpy.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((ok) => (release = ok));
    });
    press();
    await waitFor(() => expect(signal).toBeTruthy());
    h.inputs = { ...READY, aiHidden: true };
    rerender(<MakeWrite userId={USER} onEdit={vi.fn()} />);
    expect(screen.queryByTestId('make-write')).toBeNull();
    await waitFor(() => expect(signal.aborted).toBe(true));
    h.inputs = { ...READY };
    const text = JSON.stringify(MAKE_EXAMPLES.recipe);
    await act(async () => release(new Response(`data: ${JSON.stringify({ content: text })}\n\ndata: [DONE]\n\n`, { status: 200 })));
    rerender(<MakeWrite userId={USER} onEdit={vi.fn()} />);
    expect(screen.getByTestId('make-write')).toBeTruthy();
    expect(screen.queryByTestId('make-draft')).toBeNull();
    expect(screen.queryByTestId('make-write-running')).toBeNull();
  });
});

describe('when the reply is no use', () => {
  it('shows plain words and Try again, which sends once more', async () => {
    write();
    ask('make it nice');
    replyWith('I made you a lovely thing!');
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(UNREADABLE_COPY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    replyWith(MAKE_EXAMPLES.recipe);
    fireEvent.click(screen.getByTestId('make-write-retry'));
    await screen.findByTestId('make-draft');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('points at the kind it sounds like', async () => {
    write();
    fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'theme' } });
    ask('when I tick Run add Stretch');
    replyWith({ kind: 'none', suggest: 'recipe' });
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(
      'That sounds like a recipe, not a theme.'
    );
    // One press writes it as the kind it named, and switches the picker.
    replyWith(MAKE_EXAMPLES.recipe);
    fireEvent.click(screen.getByTestId('make-write-as'));
    await screen.findByTestId('make-draft');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toMatchObject({ kind: 'recipe' });
    expect((screen.getByTestId('make-write-kind') as HTMLSelectElement).value).toBe('recipe');
  });

  it('a reply that opens an object and never closes it says it was cut short', async () => {
    write();
    ask('x');
    replyWith('{"kind":"recipe","name":"Long","manifest":{"version":1,"steps":[{"do":"create"');
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(CUT_SHORT_COPY);
  });

  it('a route failure reads in the route\'s own words', async () => {
    write();
    ask('x');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "You've written a lot with AI this hour. Try again later.", code: 'rate_limit' }), { status: 429 })
    );
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain('this hour');
  });
});

describe('a mod', () => {
  const SOURCE = MOD_TEMPLATE.replace('const GOAL = 8;', 'const GOAL = 6;');
  const MANIFEST = {
    version: 1,
    uses: ['storage', 'ui'],
    commands: [{ id: 'add-glass', label: 'Add a glass', keywords: ['water', 'drink'] }],
    panels: [{ id: 'water', label: 'Water', icon: 'CupSoda', card: true }],
  };
  const ran = (manifest: unknown = MANIFEST, hooks = ['command', 'ui.resolve', 'ui.action']) => ({
    ok: true,
    manifestJson: JSON.stringify(manifest),
    hooks,
  });
  const reply = (source = SOURCE, name = 'Six glasses') => replyWith({ kind: 'mod', name, source });
  const asMod = () => fireEvent.change(screen.getByTestId('make-write-kind'), { target: { value: 'mod' } });

  it('the picker offers it; choosing it boots the sandbox and calls no model', async () => {
    write();
    const options = [...(screen.getByTestId('make-write-kind') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['recipe', 'theme', 'look', 'mod']);
    expect(h.sandbox.ensure).not.toHaveBeenCalled();
    asMod();
    await waitFor(() => expect(h.sandbox.ensure).toHaveBeenCalledTimes(1));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('make-write-privacy').textContent).toContain('never your projects’ names');
    expect(screen.getByTestId('make-write-privacy').textContent).toContain('A mod it writes cannot use AI.');
  });

  it('Write waits while the sandbox boots', async () => {
    let boot!: (s: string) => void;
    h.sandbox.ensure = vi.fn(() => new Promise<string>((ok) => (boot = ok)));
    write();
    asMod();
    ask('A water counter');
    expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(true);
    await act(async () => boot('ready'));
    expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false);
  });

  it.each(['unavailable', 'outdated'] as const)('a sandbox that is %s holds Write, says why, and sends nothing', async (status) => {
    h.sandbox.status = status;
    h.sandbox.ensure = vi.fn(async () => status);
    write();
    asMod();
    ask('A water counter');
    expect((await screen.findByTestId('make-write-sandbox')).textContent).toContain(WRITE_SANDBOX_WORDS[status]);
    expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(true);
    expect(!!screen.queryByTestId('make-write-reload')).toBe(status === 'outdated');
    press();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the card waits for the scratch run, which gets the reply\'s exact source', async () => {
    let finish!: (r: unknown) => void;
    h.sandbox.scratch = vi.fn(() => new Promise((ok) => (finish = ok)));
    write();
    asMod();
    ask('A water counter');
    await waitFor(() => expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false));
    reply();
    press();
    await waitFor(() => expect(h.sandbox.scratch).toHaveBeenCalledWith(SOURCE));
    expect(screen.getByTestId('make-write-running').textContent).toBe('Checking it…');
    expect(screen.queryByTestId('make-draft')).toBeNull();
    await act(async () => finish(ran()));
    const card = await screen.findByTestId('make-draft');
    expect(card.getAttribute('data-make-draft-kind')).toBe('mod');
    expect(screen.getByTestId('make-draft-name').textContent).toBe('Six glasses');
    expect(screen.getByTestId('make-draft-uses').textContent).toBe('It may keep its own saved data and show short messages, and open items and views from its commands.');
    expect(screen.queryByTestId('make-draft-unattended')).toBeNull();
    expect(screen.getByTestId('make-draft-hooks').textContent).toBe('As written now, it runs when one of its commands is run.');
    expect(screen.getByTestId('make-draft-commands').textContent).toContain('In the command bar as Your mod · Six glasses: Add a glass');
    expect(screen.getByTestId('make-draft-panels').textContent).toContain('shown under the braindump');
    expect(screen.getByTestId('make-draft-panels').textContent).toContain('Panel: Water, under the braindump');
    expect(screen.queryByTestId('make-draft-problems')).toBeNull();
    expect(screen.getByTestId('make-draft-install').hasAttribute('disabled')).toBe(false);
    expect(card.textContent).not.toMatch(/—/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ kind: 'mod', ask: 'A water counter' });
  });

  it('an unavailable the sandbox did not latch leaves Write open, and the next press boots it again', async () => {
    // A frame fetch that ran out answers unavailable once and leaves the sandbox idle.
    h.sandbox.ensure = vi.fn(async () => 'unavailable');
    write();
    asMod();
    ask('A water counter');
    await waitFor(() => expect(h.sandbox.ensure).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('make-write-sandbox')).toBeNull();
    expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false);
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(WRITE_SANDBOX_RETRY_COPY);
    expect(screen.queryByTestId('make-write-reload')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    h.sandbox.ensure = vi.fn(async () => 'ready');
    h.sandbox.scratch = vi.fn(async () => ran());
    reply();
    fireEvent.click(screen.getByTestId('make-write-retry'));
    expect(await screen.findByTestId('make-draft')).toBeTruthy();
    expect(h.sandbox.ensure).toHaveBeenCalled();
  });

  it.each(['unavailable', 'outdated'] as const)('a scratch run that answers %s shows Write\'s words and no card', async (status) => {
    h.sandbox.status = status;
    h.sandbox.scratch = vi.fn(async () => ({ ok: false, status }));
    write();
    asMod();
    ask('A water counter');
    await waitFor(() => expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false));
    reply();
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(WRITE_SANDBOX_WORDS[status]);
    expect(!!screen.queryByTestId('make-write-reload')).toBe(status === 'outdated');
    expect(screen.queryByTestId('make-draft')).toBeNull();
  });

  async function drafted(scratch: unknown = ran(), source = SOURCE) {
    h.sandbox.scratch = vi.fn(async () => scratch);
    asMod();
    ask('A water counter');
    await waitFor(() => expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false));
    reply(source);
    press();
    return screen.findByTestId('make-draft');
  }

  it('Install saves exactly the scratched source and manifest, switched off', async () => {
    write();
    await drafted();
    await act(async () => {
      fireEvent.click(screen.getByTestId('make-draft-install'));
    });
    await waitFor(() => expect(h.inserts).toHaveLength(1));
    expect(h.inserts[0]).toMatchObject({
      table: 'user_mods',
      payload: { kind: 'mod', name: 'Six glasses', enabled: false, user_id: USER, source: SOURCE },
    });
    expect(h.inserts[0].payload.manifest).toEqual({ ...MANIFEST, settings: [] });
    expect(screen.getByTestId('make-write-notice').textContent).toBe('Saved. It starts switched off.');
  });

  it('Edit hands over the name, the code and the manifest, marked as written by AI', async () => {
    const onEdit = vi.fn();
    write(onEdit);
    await drafted();
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    expect(onEdit).toHaveBeenCalledWith({
      kind: 'mod',
      initial: { name: 'Six glasses', source: SOURCE, manifest: { ...MANIFEST, settings: [] }, fromAI: true },
    });
  });

  it('in Make, Edit opens the mod editor and Cancel comes back to the card with one call in all', async () => {
    render(<MakePane ctx={ctx} />);
    await drafted();
    fireEvent.click(screen.getByTestId('make-draft-edit'));
    expect(screen.getByTestId('mod-editor')).toBeTruthy();
    expect(screen.getByTestId('make-write').hidden).toBe(true);
    // Prefilled with the draft, never the template.
    expect((screen.getByTestId('mod-name') as HTMLInputElement).value).toBe('Six glasses');
    expect((screen.getByTestId('mod-source') as HTMLTextAreaElement).value).toBe(SOURCE);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('make-write').hidden).toBe(false);
    expect(screen.getByTestId('make-draft-name').textContent).toBe('Six glasses');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.sandbox.scratch).toHaveBeenCalledTimes(1);
  });

  it('a draft that would not load shows no uses or panels, only why; Install is held', async () => {
    write();
    await drafted({ ok: false, fault: { code: 'load', message: 'export a register function' } });
    expect(screen.queryByTestId('make-draft-mod')).toBeNull();
    expect(screen.queryByTestId('make-draft-touches')).toBeNull();
    const problems = screen.getByTestId('make-draft-problems').textContent!;
    expect(problems).toContain('It would not load.');
    expect(problems).toContain('Your mod reported: export a register function');
    expect(screen.getByTestId('make-draft-install').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('make-draft-edit').hasAttribute('disabled')).toBe(false);
  });

  it('"items:write" shows the unattended line even with no item hook', async () => {
    write();
    await drafted(ran({ version: 1, uses: ['items:write', 'ui'], commands: [{ id: 'tidy', label: 'Tidy up' }] }, ['command']));
    expect(screen.getByTestId('make-draft-unattended').textContent).toBe(
      'It can change items when its code runs, including on its own.'
    );
  });

  it('an item hook adds an example to the unattended line, never removes it', async () => {
    write();
    await drafted(ran({ version: 1, uses: ['items:write'] }, ['item.completed']));
    expect(screen.getByTestId('make-draft-unattended').textContent).toBe(
      'It can change items when its code runs, including on its own, for example when you tick an item.'
    );
    expect(screen.getByTestId('make-draft-hooks').textContent).toBe('As written now, it runs when an item is ticked.');
  });

  it('its source shows as text, never as markup', async () => {
    const source = SOURCE.replace('// Water:', '// <img src=x onerror=alert(1)> Water:');
    write();
    await drafted(ran(), source);
    fireEvent.click(screen.getByTestId('make-draft-source-toggle'));
    const pre = screen.getByTestId('make-draft-source');
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector('img')).toBeNull();
    expect(pre.parentElement!.className).toContain('max-h-80');
  });

  it('the gate closing mid-scratch drops the result and goes back to idle', async () => {
    let finish!: (r: unknown) => void;
    h.sandbox.scratch = vi.fn(() => new Promise((ok) => (finish = ok)));
    const { rerender } = write();
    asMod();
    ask('A water counter');
    await waitFor(() => expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false));
    reply();
    press();
    await waitFor(() => expect(h.sandbox.scratch).toHaveBeenCalled());
    h.inputs = { ...READY, aiHidden: true };
    rerender(<MakeWrite userId={USER} onEdit={vi.fn()} />);
    expect(screen.queryByTestId('make-write')).toBeNull();
    await act(async () => finish(ran()));
    h.inputs = { ...READY };
    rerender(<MakeWrite userId={USER} onEdit={vi.fn()} />);
    expect(screen.queryByTestId('make-draft')).toBeNull();
    expect(screen.queryByTestId('make-write-running')).toBeNull();
  });

  it('the example sent back as it is says so', async () => {
    write();
    asMod();
    ask('A water counter');
    await waitFor(() => expect(screen.getByTestId('make-write-go').hasAttribute('disabled')).toBe(false));
    reply(MOD_TEMPLATE, 'Water');
    press();
    expect((await screen.findByTestId('make-write-error')).textContent).toContain(
      'It repeated the example instead of writing your mod.'
    );
    expect(h.sandbox.scratch).not.toHaveBeenCalled();
  });
});
