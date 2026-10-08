import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The settings surface at the level it actually breaks: RENDERED.
 *
 * The pane-per-extension change shipped with thirteen new tests and every one
 * of them asserted the data layer. Reverting settings-shell's results loop from
 * ALL_PANES back to PANES — which drops every extension field out of the result
 * list while the rail keeps counting it — left the whole suite green. So did
 * changing a generated credential's `read` to return a token, because the only
 * secret-row test builds its own hand-written record.
 *
 * Both of those are rendering facts, so they are pinned here, against the real
 * SettingsShell and the real manifest. Four claims:
 *
 *   1. A query crosses into sub-panes and the hits are DRAWN, not merely
 *      counted — the rail number and the row count are the same number.
 *   2. No credential's value can reach the screen.
 *   3. The extension list and the extension's own pane say the same word about
 *      whether it is live.
 *   4. The AI pane's body is AIPane (components/settings/ai-pane.tsx), wired
 *      into the shell: its rows, its marks, its fold, its deep links (which
 *      wait for the connection check) and its row in search.
 */

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/day',
  useSearchParams: () => new URLSearchParams(),
}));

import { SettingsShell } from '@/components/settings/settings-shell';
import { SETTINGS, type PaneId, type SettingCtx } from '@/lib/settings/manifest';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { __armUserForTests, useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import {
  seedAI,
  paneInputFor,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  SEED_USER_ID,
  type SeedAI,
} from './helpers/ai-fixtures';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

function renderShell(pane: PaneId = 'day') {
  return render(
    <SettingsShell pane={pane} ctx={ctx} isMobile={false} onOpenDestination={() => {}} />
  );
}

/**
 * Type a query and wait for it to actually commit.
 *
 * The wait is on the live region rather than on any row: the pane's OWN rows
 * are in the DOM from first paint, so "some row exists" is true before the
 * 120ms debounce has fired and would let every assertion below run against the
 * unsearched page. The status text is computed from `results.total`, which is
 * the one number a broken results loop still gets right — so this settles even
 * in the failure mode these tests are here to catch.
 */
async function search(term: string) {
  fireEvent.change(screen.getByTestId('settings-search'), { target: { value: term } });
  await waitFor(
    () => expect(screen.getByTestId('settings-status').textContent).not.toBe(''),
    { timeout: 3000 }
  );
}

/** The rail's own number for a rail row — "Extensions 4" minus the name. */
function railCount(name: string): number {
  const rail = screen.getByRole('navigation', { name: 'Settings sections' });
  const button = Array.from(rail.querySelectorAll('button')).find((b) =>
    b.textContent?.startsWith(name)
  );
  expect(button, `no rail row named ${name}`).toBeTruthy();
  return Number(button!.textContent!.slice(name.length).trim());
}

/* ── A fake AI server, for the panes that mount the Connection section ──── */

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The connection GET's answer for a seed: what the server would say about that account (AI on, unless told). */
function statusBody(seed: SeedAI, aiHidden = false) {
  const s = paneInputFor(seed);
  return json({ available: s.available, model: s.model, openclaw: s.openclaw, aiHidden });
}

/**
 * Answer `/api/ai/connection` as `seed` does (the Connection section re-asks
 * on mount, and an answer that disagreed with the seed would overwrite it),
 * the models route with an empty list, and a PATCH {hidden} as accepted.
 * `status` replaces the GET's answer (a failure, or one held open).
 */
function answerAs(seed: SeedAI, o: { status?: () => Response | Promise<Response> } = {}) {
  let hidden = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/ai/connection' && method === 'GET') {
        return o.status ? o.status() : statusBody(seed, hidden);
      }
      if (url === '/api/ai/connection' && method === 'PATCH' && typeof body?.hidden === 'boolean') {
        hidden = body.hidden;
        return json({ aiHidden: hidden });
      }
      if (url === '/api/ai/connection/models') return json({ models: [], listed: true });
      return json({ error: 'server' }, 404);
    })
  );
}

beforeEach(() => {
  nav.push.mockReset();
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
});

afterEach(() => {
  cleanup();
  useExtensionsStore.getState().reset();
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
});

describe('settings search renders what it counts', () => {
  it('draws the sub-pane hits, and draws exactly as many as the rail claims', async () => {
    // The regression this exists for: grouping the results by PANES instead of
    // ALL_PANES leaves the rail saying "Extensions 4" over an empty list,
    // because paneMatchCount rolls sub-panes up and the loop does not. The two
    // numbers agreeing is the whole assertion.
    renderShell();
    await search('beeminder');

    const rendered = document.querySelectorAll('[data-setting-row^="extensions.beeminder"]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(railCount('Extensions')).toBe(rendered.length);
  });

  it('names the sub-pane a hit came from, parent included', async () => {
    // "Beeminder" alone does not say where to go; the group header is the only
    // place the result list explains where a row actually lives.
    renderShell();
    await search('beeminder');
    expect(
      screen.getByRole('heading', { name: /Extensions · Beeminder/ })
    ).toBeInTheDocument();
  });
});

describe('a credential never reaches the screen', () => {
  it('renders every secret row masked and empty, whatever read() returns', async () => {
    // read() returning '' is a contract, not an accident, and this is the half
    // of it a data-layer test cannot see: the shell passes record.read(ctx)
    // straight into the control as `value`, so a read that started answering
    // with the stored token would put the token in the box.
    // EVERY secret record: the generated extension credentials and the
    // gateway token. (The model key is not a record value at all any more: it
    // is sealed server-side and its record is an info row.)
    const secrets = SETTINGS.filter((r) => r.textVariant === 'secret');
    expect(secrets.map((r) => r.id)).toContain('beacon.gatewayToken');
    expect(secrets.length).toBeGreaterThan(1);

    renderShell();
    // The gateway token is advanced, and search leaves advanced rows out
    // unless asked: opt in first, the way a user would.
    fireEvent.click(screen.getByTitle('Include advanced settings in results'));
    // Every credential carries 'credential' as a keyword — the one query that
    // surfaces all of them at once. The toggles are all OFF here, so this also
    // pins that SEARCH still draws a dependent its pane would hide
    // (settings-shell rowFor): a hit the rail counts is a hit on screen.
    await search('credential');

    for (const record of secrets) {
      const row = document.querySelector<HTMLElement>(`[data-setting-row="${record.id}"]`);
      expect(row, `${record.id} did not render`).not.toBeNull();
      const input = row!.querySelector('input') as HTMLInputElement;
      expect(input.type, record.id).toBe('password');
      expect(input.value, record.id).toBe('');
      // And nothing echoed it back out in the row's own copy either.
      expect(row!.textContent, record.id).not.toContain('AC0123');
    }
  });
});

describe('the extension list and the extension pane agree', () => {
  // The list folds what is off, and Beeminder starts off here; unfold it so
  // every row is drawn and each test reads the word, not the fold.
  beforeEach(() => {
    try {
      localStorage.setItem('dsul-settings-extensions-off-open', '1');
    } catch {
      /* no storage */
    }
  });
  afterEach(() => {
    try {
      localStorage.removeItem('dsul-settings-extensions-off-open');
    } catch {
      /* no storage */
    }
  });

  it('says Unavailable, not On, for an extension its master switch has off', async () => {
    // Beeminder switched on with "Settle the day" off is an extension that is
    // enabled and doing nothing. The index used to read the enabled flag alone
    // and call that "On" while the pane one click away called it Unavailable —
    // and Beeminder is the one where being wrong costs money.
    act(() => {
      useExtensionsStore.setState({ enabled: { beeminder: true } });
      useReminderStore.setState({ stakesEnabled: false });
    });

    const index = renderShell('extensions');
    const row = () => document.querySelector<HTMLElement>('[data-extension-row="beeminder"]');
    expect(row()!.dataset.extensionState).toBe('Unavailable');

    // The pane's own word for the same state, from the same unavailable().
    index.unmount();
    renderShell('extensions/beeminder');
    expect(
      document.querySelector('[data-setting-row="extensions.beeminder"]')!.textContent
    ).toContain('Unavailable: needs Settle the day, in Rituals');
  });

  it('reads On once the master switch is on — and re-renders on its own', async () => {
    act(() => {
      useExtensionsStore.setState({ enabled: { beeminder: true } });
      useReminderStore.setState({ stakesEnabled: false });
    });
    renderShell('extensions');

    // The index subscribes to the two stores itself rather than riding the
    // page's ctx rebuild, so flipping the master switch is enough.
    act(() => useReminderStore.setState({ stakesEnabled: true }));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
          .extensionState
      ).toBe('On')
    );
  });

  /**
   * The two STORE-level facts outrank the record, and the order is the point.
   *
   * Asking the toggle record is the fix for the index and the pane disagreeing,
   * but a record read against a store that has not fetched yet answers with the
   * MANIFEST DEFAULT — a guess, and for any account that has ever toggled
   * something, frequently the opposite of the truth. So `available` and
   * `configsLoaded` are checked BEFORE `toggle.read`, not after. Nothing in the
   * shape of the code says so; these say it.
   */
  it('says Loading rather than guessing from the manifest default', async () => {
    act(() => {
      // The server has it ON. The store has not heard yet, so `isEnabled` would
      // fall back to the manifest default and print the opposite.
      useExtensionsStore.setState({ configsLoaded: false, enabled: {} });
      useReminderStore.setState({ stakesEnabled: true });
    });
    renderShell('extensions');
    expect(
      document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
        .extensionState
    ).toBe('Loading');

    // And it clears on its own once the fetch lands — the subscription names
    // configsLoaded, so "Loading" is not a state the row can get stuck in.
    act(() => useExtensionsStore.setState({ configsLoaded: true, enabled: { beeminder: true } }));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
          .extensionState
      ).toBe('On')
    );
  });

  it('says Unavailable for every row when the extensions table is missing', async () => {
    // `available: false` is "the migration has not run" — no row under here is
    // real, whatever its record would compute.
    act(() => {
      useExtensionsStore.setState({ available: false, configsLoaded: true });
      useReminderStore.setState({ stakesEnabled: true, remindersEnabled: true });
    });
    renderShell('extensions');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-extension-row]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dataset.extensionState, row.dataset.extensionRow).toBe('Unavailable');
    }
  });
});

describe('the AI pane', () => {
  let cleanupAI: (() => void) | null = null;
  beforeEach(() => {
    calls = [];
    // The Connection section re-asks the server on mount; answer as the seed would.
    answerAs(NOTHING_CONNECTED);
  });
  afterEach(() => {
    cleanupAI?.();
    cleanupAI = null;
    __armUserForTests(null);
    vi.unstubAllGlobals();
    try {
      sessionStorage.clear();
    } catch {
      /* no storage */
    }
    window.history.replaceState(null, '', '/');
  });

  /** Seed the gate and make the server say the same thing, so the pane's mount refresh agrees. */
  function given(seed: SeedAI) {
    cleanupAI = seedAI(seed);
    answerAs(seed);
  }

  const row = (id: string) => document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
  const alias = (id: string) => document.querySelector<HTMLElement>(`[data-setting-alias="${id}"]`);
  /** Every lime class in the pane, the switch's own track and thumb left out (the house switch stays lime). */
  const lime = () =>
    Array.from(
      document.querySelectorAll('[data-testid="ai-pane"] [class*="bg-primary"], [data-testid="ai-pane"] [data-slot="button-key"]')
    ).filter((el) => el.closest('[data-slot="switch"]') === null);
  const eyebrowMark = () => {
    const eyebrow = Array.from(document.querySelectorAll('main p')).find((p) => p.textContent === 'AI');
    expect(eyebrow, 'no AI eyebrow').toBeTruthy();
    return eyebrow!.querySelector('[data-ask-mark]');
  };
  const railMark = () => {
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    const button = Array.from(rail.querySelectorAll('button')).find((b) => b.textContent === 'AI');
    return button!.querySelector('[data-ask-mark]');
  };

  it('opens with the pane body: Use AI, then the Connection section, which owns the key and model', async () => {
    given(NOTHING_CONNECTED);
    renderShell('beacon');
    expect(screen.getByTestId('ai-pane')).toBeInTheDocument();
    expect(screen.getByTestId('model-connection-panel')).toBeInTheDocument();
    // The panel's anchors, not flat rows: one id, one home.
    expect(row('beacon.apiKey')).toBeNull();
    expect(row('beacon.model')).toBeNull();
    expect(alias('beacon.apiKey')).not.toBeNull();
    expect(alias('beacon.model')).not.toBeNull();
    // Nothing connected: "No AI, thanks", not a switch.
    const use = screen.getByTestId('ai-use-row');
    expect(within(use).getByTestId('ai-no-ai-thanks')).toBeInTheDocument();
    expect(within(use).queryByRole('switch')).toBeNull();
    // On this device is hidden (F18): its rows answer through the Connection section.
    expect(screen.queryByTestId('ai-device')).toBeNull();
    expect(row('beacon.provider')).toBeNull();
    expect(row('beacon.instructions')).toBeNull();
    expect(alias('beacon.provider')).not.toBeNull();
    expect(alias('beacon.instructions')).not.toBeNull();
    expect(screen.queryByText(/\bBeacon\b/)).toBeNull();
    await act(async () => {});
  });

  it('shows On this device while nothing is connected only when chat is Off here', async () => {
    given({ ...NOTHING_CONNECTED, choice: 'none' });
    renderShell('beacon');
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    expect(row('beacon.provider')).not.toBeNull();
    expect(row('beacon.instructions')).not.toBeNull();
    await act(async () => {});
  });

  it('shows On this device once something is connected', async () => {
    given(CONNECTED_MODEL);
    renderShell('beacon');
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    expect(row('beacon.provider')).not.toBeNull();
    expect(row('beacon.instructions')).not.toBeNull();
    expect(within(screen.getByTestId('ai-use-row')).getByRole('switch')).toBeChecked();
    await act(async () => {});
  });

  it('the rail and the eyebrow wear the live mark: unlit while nothing answers, lit once something does', async () => {
    given(NOTHING_CONNECTED);
    const first = renderShell('beacon');
    expect(railMark()).toHaveAttribute('data-lit', 'false');
    expect(eyebrowMark()).toHaveAttribute('data-lit', 'false');
    await act(async () => {});
    first.unmount();
    cleanupAI?.();

    given(CONNECTED_MODEL);
    const second = renderShell('beacon');
    expect(railMark()).not.toBeNull();
    expect(railMark()).not.toHaveAttribute('data-lit');
    expect(eyebrowMark()).not.toHaveAttribute('data-lit');
    await act(async () => {});
    second.unmount();

    // On another pane, where no Connection section mounts, the rail still knows.
    renderShell('day');
    expect(railMark()).not.toHaveAttribute('data-lit');
  });

  it('has no shell Advanced fold: the gateway rows live in the OpenClaw section’s own', async () => {
    given(NOTHING_CONNECTED);
    renderShell('beacon');
    const advanced = screen.getAllByRole('button', { name: /Advanced/ });
    expect(advanced).toEqual([screen.getByTestId('openclaw-gateway-toggle')]);
    expect(row('beacon.gatewayUrl')).toBeNull();
    fireEvent.click(screen.getByTestId('openclaw-gateway-toggle'));
    expect(row('beacon.gatewayUrl')).not.toBeNull();
    expect(row('beacon.gatewayToken')).not.toBeNull();
    await act(async () => {});
  });

  it('a deep link to a gateway row opens the fold and lands on the row', async () => {
    given(NOTHING_CONNECTED);
    render(
      <SettingsShell pane="beacon" ctx={ctx} focusId="beacon.gatewayUrl" isMobile={false} onOpenDestination={() => {}} />
    );
    await waitFor(() => expect(row('beacon.gatewayUrl')?.dataset.highlight).toBe('true'));
    expect(screen.getByTestId('openclaw-gateway-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(row('beacon.gatewayUrl'));
  });

  it('a deep link to a panel-owned record lands on the panel and rings it', async () => {
    given(CONNECTED_MODEL);
    render(
      <SettingsShell
        pane="beacon"
        ctx={ctx}
        focusId="beacon.model"
        isMobile={false}
        onOpenDestination={() => {}}
      />
    );
    const target = () => alias('beacon.model')!;
    await waitFor(() => expect(target().dataset.highlight).toBe('true'));
    expect(target().contains(screen.getByTestId('model-picker'))).toBe(true);
    expect(document.activeElement).toBe(target());
  });

  describe('a cold deep link waits for the connection check', () => {
    /** A status GET held open until the test answers it. */
    function holdStatus() {
      let answer!: (seed: SeedAI) => void;
      const held = new Promise<SeedAI>((resolve) => {
        answer = resolve;
      });
      answerAs(NOTHING_CONNECTED, { status: async () => statusBody(await held) });
      return (seed: SeedAI) => act(async () => answer(seed));
    }

    function arrive(focusId: string) {
      __armUserForTests(SEED_USER_ID);
      useAIConnectionStore.setState({ phase: 'unknown' });
      const answer = holdStatus();
      window.history.pushState(null, '', `?focus=${focusId}`);
      const strip = vi.spyOn(window.history, 'replaceState');
      render(<SettingsShell pane="beacon" ctx={ctx} focusId={focusId} isMobile={false} onOpenDestination={() => {}} />);
      return { answer, strip };
    }

    afterEach(() => {
      vi.restoreAllMocks();
      useAIConnectionStore.getState().reset();
    });

    it.each([
      { id: 'beacon.provider', as: 'connected', seed: CONNECTED_MODEL, kind: 'row' },
      { id: 'beacon.provider', as: 'nothing connected', seed: NOTHING_CONNECTED, kind: 'alias' },
      { id: 'beacon.useAi', as: 'nothing connected', seed: NOTHING_CONNECTED, kind: 'row' },
    ] as const)('$id, answered as $as, lands on its $kind only after the answer', async ({ id, seed, kind }) => {
      const { answer, strip } = arrive(id);
      await act(async () => {});
      expect(strip).not.toHaveBeenCalled();
      expect(document.querySelector('[data-highlight]')).toBeNull();
      // The row the record will have is not rung while the check is out, even where one is drawn.
      if (id === 'beacon.useAi') expect(row(id)).not.toBeNull();

      await answer(seed);
      const target = () => (kind === 'row' ? row(id) : alias(id));
      await waitFor(() => expect(target()?.dataset.highlight).toBe('true'));
      expect(document.activeElement).toBe(target());
      expect(strip).toHaveBeenCalled();
      expect(window.location.search).toBe('');
    });

    it('beacon.apiKey rings nothing on the checking card, then lands on the connect card’s key box', async () => {
      const { answer, strip } = arrive('beacon.apiKey');
      await act(async () => {});
      expect(screen.getByTestId('mcp-checking')).toBeInTheDocument();
      expect(strip).not.toHaveBeenCalled();
      expect(document.querySelector('[data-highlight]')).toBeNull();

      await answer(NOTHING_CONNECTED);
      await waitFor(() => expect(alias('beacon.apiKey')?.dataset.highlight).toBe('true'));
      expect(screen.queryByTestId('mcp-checking')).toBeNull();
      expect(alias('beacon.apiKey')!.contains(screen.getByTestId('connect-key'))).toBe(true);
      expect(document.activeElement).toBe(alias('beacon.apiKey'));
    });
  });

  describe('search for "no ai"', () => {
    const hit = () => row('beacon.useAi')!;

    it('draws the pane’s own row: "No AI, thanks" while nothing is connected, and no reset', async () => {
      given(NOTHING_CONNECTED);
      renderShell('day');
      await search('no ai');
      expect(within(hit()).getByTestId('ai-no-ai-thanks')).toBeInTheDocument();
      expect(within(hit()).queryByRole('switch')).toBeNull();
      expect(within(hit()).queryByRole('button', { name: /Reset to default/ })).toBeNull();
      // The location line names the pane.
      expect(within(hit()).getByText('AI', { selector: 'p' })).toBeInTheDocument();
    });

    it('is the switch once something is connected, and turning it off writes the account', async () => {
      given(CONNECTED_MODEL);
      renderShell('day');
      await search('no ai');
      // By role alone: the label is split into highlight runs here, which
      // jsdom's name computation joins without their spaces.
      const toggle = within(hit()).getByRole('switch');
      expect(toggle).toBeChecked();
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ hidden: true }]);
    });

    it.each([
      ['while the check is out', undefined],
      ['when the check failed', { phase: 'error' } as SeedAI],
    ])('%s it has no modified bar and no reset', async (_label, seed) => {
      cleanupAI = seedAI(seed);
      answerAs(NOTHING_CONNECTED, { status: () => json({ error: 'server' }, 503) });
      renderShell('day');
      await search('no ai');
      expect(hit().className).not.toMatch(/before:bg-primary/);
      expect(within(hit()).queryByRole('button', { name: /Reset to default/ })).toBeNull();
      expect(within(hit()).queryByRole('switch')).toBeNull();
    });
  });

  describe('the modified bar on an AI row', () => {
    it('is grey while nothing answers (chat Off here, nothing connected), and the pane has no lime', async () => {
      given({ ...NOTHING_CONNECTED, choice: 'none' });
      renderShell('beacon');
      const provider = row('beacon.provider')!;
      expect(provider.className).toMatch(/before:bg-muted-foreground/);
      expect(provider.className).not.toMatch(/before:bg-primary/);
      expect(lime()).toEqual([]);
      await act(async () => {});
    });

    it('is lime once something answers', async () => {
      given(CONNECTED_MODEL);
      act(() => useAISettingsStore.setState({ systemPrompt: 'Be blunt.' }));
      renderShell('beacon');
      expect(row('beacon.instructions')!.className).toMatch(/before:bg-primary/);
      await act(async () => {});
    });
  });

  it('keeps On this device, and the focus in it, when chat is turned back on', async () => {
    given({ ...NOTHING_CONNECTED, choice: 'none' });
    renderShell('beacon');
    const control = screen.getByTestId('setting-beacon.provider');
    control.focus();
    expect(document.activeElement).toBe(control);
    act(() => useAISettingsStore.setState({ chatTarget: 'model' }));
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    expect(screen.getByTestId('setting-beacon.provider')).toBe(control);
    expect(document.activeElement).toBe(control);
    await act(async () => {});
  });

  it('search still draws the panel-owned records as rows', async () => {
    given(CONNECTED_MODEL);
    renderShell('day');
    await search('openai');
    const found = row('beacon.apiKey');
    expect(found).not.toBeNull();
    expect(found!.textContent).toContain('Saved (OpenAI)');
  });

  it('a panel-owned hit offers "Set up", which clears the search and lands on the panel', async () => {
    given(NOTHING_CONNECTED);
    const shell = (pane: PaneId, focusId?: string) => (
      <SettingsShell pane={pane} ctx={ctx} focusId={focusId} isMobile={false} onOpenDestination={() => {}} />
    );
    const view = render(shell('day'));
    const input = () => screen.getByTestId('settings-search') as HTMLInputElement;
    const anchor = () => alias('beacon.apiKey');

    await search('openai');
    const hit = row('beacon.apiKey')!;
    expect(hit.textContent).toContain('Not set up');
    // A hit with a control of its own needs no way out; only the panel's records get one.
    expect(screen.getAllByTestId('settings-set-up')).toHaveLength(1);
    fireEvent.click(within(hit).getByRole('button', { name: 'Set up API key' }));

    expect(nav.push).toHaveBeenCalledTimes(1);
    // By the pane's alias: the address bar says "ai", never "beacon".
    expect(nav.push).toHaveBeenCalledWith('/settings/ai?focus=beacon.apiKey');
    // The query is gone at once, so the pane (and its panel) is what renders, not the results.
    expect(input().value).toBe('');
    expect(row('beacon.apiKey')).toBeNull();

    // The router answers with the AI pane and the focus; the panel takes it.
    view.rerender(shell('beacon', 'beacon.apiKey'));
    expect(screen.getByTestId('model-connection-panel')).toBeInTheDocument();
    await waitFor(() => expect(anchor()?.dataset.highlight).toBe('true'));
    expect(document.activeElement).toBe(anchor());

    // The param is stripped on arrival. A second "Set up" for the same record
    // still lands: the guard against re-arrival lasts only while it is in the URL.
    view.rerender(shell('beacon'));
    input().focus();
    await search('openai');
    fireEvent.click(screen.getByRole('button', { name: 'Set up API key' }));
    expect(nav.push).toHaveBeenCalledTimes(2);
    view.rerender(shell('beacon', 'beacon.apiKey'));
    await waitFor(() => expect(document.activeElement).toBe(anchor()));
  });

  it('offers "Ask AI" on an empty search only when something can answer', async () => {
    given(NOTHING_CONNECTED);
    const first = renderShell('day');
    await search('zzqqxxnothing');
    expect(screen.queryByRole('link', { name: 'Ask AI' })).toBeNull();
    first.unmount();

    cleanupAI?.();
    given(CONNECTED_MODEL);
    renderShell('day');
    await search('zzqqxxnothing');
    expect(screen.getByRole('link', { name: 'Ask AI' })).toBeInTheDocument();
  });
});

describe('the hrefs the surface builds', () => {
  const railButton = (name: string) => {
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    const button = Array.from(rail.querySelectorAll('button')).find((b) => b.textContent?.startsWith(name));
    expect(button, `no rail row named ${name}`).toBeTruthy();
    return button!;
  };

  it('the rail goes to the AI pane by its alias, and to every other pane by its id', () => {
    renderShell('day');
    fireEvent.click(railButton('AI'));
    expect(nav.push).toHaveBeenLastCalledWith('/settings/ai');
    fireEvent.click(railButton('Keyboard'));
    expect(nav.push).toHaveBeenLastCalledWith('/settings/keyboard');
    expect(nav.push.mock.calls.flat()).not.toContain('/settings/beacon');
  });

  it("an extension's parent crumb is a real link to the index", () => {
    renderShell('extensions/beeminder');
    const crumbs = screen.getAllByRole('navigation')[0];
    expect(within(crumbs).getByRole('link', { name: 'Extensions' })).toHaveAttribute('href', '/settings/extensions');
  });

  it('the AI pane lights its one rail row', () => {
    renderShell('beacon');
    expect(railButton('AI')).toHaveAttribute('aria-current', 'true');
  });
});
