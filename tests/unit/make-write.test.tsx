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
}));

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
import { CUT_SHORT_COPY, MakeWrite, UNREADABLE_COPY } from '@/components/settings/make-write';
import { useModsStore } from '@/lib/mods-store';
import { useUserThemes } from '@/lib/user-themes/store';
import { DRAFT_SLUG } from '@/lib/user-themes/css';
import { CONTRAST_PROBLEM } from '@/lib/make-draft';
import { MAKE_EXAMPLES } from '@/lib/ai-server/make-prompt';
import type { SettingCtx } from '@/lib/settings/manifest';

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
