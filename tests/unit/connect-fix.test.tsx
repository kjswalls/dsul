import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The fix card (components/ai/connect/connect-fix.tsx): a saved connection the
 * provider stopped accepting, or one dsul can no longer read, fixed in place.
 * Two hosts: the setup column's fix home (the default, unchanged) and
 * Settings → AI's Connection card (host 'pane'). Rendered against the REAL
 * connection store with a fake route behind `fetch`. Where the column's shows,
 * and the no-model state beside it, are ask-setup.test.tsx's; the pane's card
 * around it is model-connection-panel.test.tsx's.
 *
 *  - What is wrong, in plain words: "Key saved · Google turned it down an
 *    hour ago", and a honey note.
 *  - A box for a new key, with the connect card's mechanics: a sure paste of
 *    the saved provider's key checks itself, anything else waits for Connect,
 *    another company's key gets its note. A key that works fixes it in place:
 *    never "It works.", since Ask picks up where it left off.
 *  - A fresh check of the old key, with a line for each answer.
 *  - A sign-in signs in again (home from the column, back to the pane from
 *    the pane); in the desktop app, from the browser by a copied link, or by
 *    a pasted OpenRouter key.
 *  - The pane's host: its own actions after the fresh check, the deep-link
 *    anchors, the key page inline, and the saved model riding along with a
 *    new key so a fix never resets the pick.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { ConnectFix, fixCopy } from '@/components/ai/connect/connect-fix';
import { ago } from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { FLOW_COPY } from '@/lib/connect-flow';
import { usePlannerStore } from '@/lib/planner-store';
import type { ModelConnectionView } from '@/lib/ai-types';
import { seedAI, KEY_TURNED_DOWN } from './helpers/ai-fixtures';

const NOW = Date.parse('2026-10-07T19:30:00.000Z');
const GOOGLE = 'AIzaSyTEST-SENTINEL-9876';
const OPENROUTER = 'sk-or-v1-TEST-SENTINEL-9876';
const ANTHROPIC = 'sk-ant-api03-TEST-SENTINEL-9876';
const UNKNOWN = 'gsk_TEST-SENTINEL-9876';

type Host = 'column' | 'pane';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Google Gemini's key, turned down an hour ago. */
function failing(over: Partial<ModelConnectionView> = {}): ModelConnectionView {
  return {
    provider: 'gemini',
    model: 'gemini-flash-latest',
    baseUrl: null,
    authMethod: 'key',
    status: 'failing',
    problem: 'key_rejected',
    checkedAt: new Date(NOW - 60 * 60_000).toISOString(),
    limitedUntil: null,
    modelLabel: null,
    ...over,
  };
}
const signIn = (over: Partial<ModelConnectionView> = {}) =>
  failing({ provider: 'openrouter', model: 'openai/gpt-4o-mini', authMethod: 'oauth', ...over });

type Reply = Response | ((body: Record<string, unknown>) => Response | Promise<Response>);
let puts: Record<string, unknown>[];
let patches: Record<string, unknown>[];
let putReply: Reply;
let patchReply: Reply;
const answer = (r: Reply, body: Record<string, unknown>) => (typeof r === 'function' ? r(body) : r.clone());

let unseed: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  puts = [];
  patches = [];
  putReply = json({ error: 'server' }, 500);
  patchReply = json({ error: 'server' }, 500);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (String(input) === '/api/ai/connection' && method === 'PUT') {
        puts.push(body);
        return answer(putReply, body);
      }
      if (String(input) === '/api/ai/connection' && method === 'PATCH') {
        patches.push(body);
        return answer(patchReply, body);
      }
      return json({ available: true, model: null, openclaw: {}, aiHidden: false });
    })
  );
  usePlannerStore.setState({ userTimezone: 'UTC', timeFormat: '12h' } as never);
});

afterEach(() => {
  cleanup();
  unseed();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { dsulDesktop?: unknown }).dsulDesktop;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

/**
 * The saved connection in the store, as the gate would have it, and the card
 * for it: in the column, or on the pane with a stand-in for the pane's own
 * actions.
 */
function renderFix(model: ModelConnectionView = failing(), host: Host = 'column', highlightId: string | null = null) {
  unseed = seedAI({ ...KEY_TURNED_DOWN, model });
  return render(
    <aside data-ask-setup="fix">
      {host === 'column' ? (
        <ConnectFix model={model} />
      ) : (
        <ConnectFix
          model={model}
          host="pane"
          highlightId={highlightId}
          paneActions={
            <button type="button" data-testid="pane-action">
              Use a different service
            </button>
          }
        />
      )}
    </aside>
  );
}

const card = () => screen.getByTestId('setup-fix');
const paneCard = () => screen.getByTestId('mcp-fix');
const box = () => screen.getByTestId('fix-key') as HTMLInputElement;
const status = () => screen.getByTestId('fix-status');
const recheck = () => screen.getByTestId('setup-recheck');
const paste = (input: HTMLElement, text: string) =>
  act(async () => {
    fireEvent.paste(input, { clipboardData: { getData: () => text } });
  });
const press = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });
const works = (over: Partial<ModelConnectionView> = {}) => (body: Record<string, unknown>) =>
  json({
    connection: failing({ provider: body.provider as ModelConnectionView['provider'], status: 'ok', problem: null, ...over }),
    models: [],
    listed: true,
  });

/* ── Both hosts ─────────────────────────────────────────────────────────── */

describe.each(['column', 'pane'] as const)('the mechanics, on the %s host', (host) => {
  /**
   * What a new key for the saved Gemini connection sends: the column leaves the
   * model to the route; the pane carries the saved one, so a fix never resets it.
   */
  const toGemini = (apiKey: string) =>
    host === 'pane' ? { provider: 'gemini', apiKey, model: 'gemini-flash-latest' } : { provider: 'gemini', apiKey };

  it('a sure paste of the saved provider’s key checks itself, and fixes it in place', async () => {
    let release: (r: Response) => void = () => {};
    putReply = () => new Promise<Response>((r) => (release = r));
    renderFix(failing(), host);
    expect(screen.getByLabelText('New Gemini key')).toBe(box());
    expect(screen.getByText(/Your old key is replaced only once this one works\./)).toBeInTheDocument();
    expect(status()).toBeEmptyDOMElement();
    await paste(box(), GOOGLE);
    expect(puts).toEqual([toGemini(GOOGLE)]);
    expect(status()).toHaveTextContent('Checking your key with Google…');
    expect(box()).toHaveAttribute('readonly');
    expect(box()).not.toBeDisabled();

    await act(async () => release(works()({ provider: 'gemini' })));
    expect(box().value).toBe('');
    expect(useAIConnectionStore.getState().model?.status).toBe('ok');
    // A fix picks up where it left off: no "It works."
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
    expect(document.body.innerHTML).not.toContain('SENTINEL');
    expect(JSON.stringify(useAIConnectionStore.getState())).not.toContain('SENTINEL');
  });

  it('anything not surely the saved provider’s waits for Connect', async () => {
    putReply = works();
    renderFix(failing(), host);
    await paste(box(), UNKNOWN);
    expect(puts).toEqual([]);
    expect(screen.getByTestId('fix-note')).toHaveTextContent(
      'That doesn’t look like a Google key. Google’s keys start with AQ. or AIza.'
    );
    await press(screen.getByTestId('fix-submit'));
    expect(puts).toEqual([toGemini(UNKNOWN)]);
  });

  it('another company’s key: a note, and Use it with that company', async () => {
    putReply = works();
    renderFix(failing(), host);
    await paste(box(), ANTHROPIC);
    expect(puts).toEqual([]);
    const note = screen.getByTestId('fix-note');
    expect(within(note).getByRole('alert')).toHaveTextContent(
      'That looks like an Anthropic key, not a Google one. Anthropic keys work too, but they need credit on your Anthropic account.'
    );
    expect(screen.queryByTestId('fix-submit')).toBeNull();
    await press(within(note).getByRole('button', { name: 'Use it with Anthropic' }));
    // Another company's connection: the saved Gemini model has no business there.
    expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
    expect(document.activeElement).toBe(box());
  });

  it('a refused new key stays, says why, and offers to check it again', async () => {
    putReply = json({ error: 'key_rejected' }, 400);
    renderFix(failing(), host);
    await paste(box(), GOOGLE);
    const note = screen.getByTestId('fix-note');
    expect(note).toHaveAttribute('data-code', 'key_rejected');
    expect(within(note).getByRole('alert')).toHaveTextContent(/^Google didn’t accept that key\./);
    expect(box().value).toBe(GOOGLE);
    expect(box()).not.toHaveAttribute('value');
    expect(within(note).getByRole('link', { name: /Open Google AI Studio/ })).toHaveAttribute(
      'href',
      'https://aistudio.google.com/apikey'
    );
    await press(within(note).getByRole('button', { name: 'Check again' }));
    expect(puts).toEqual([toGemini(GOOGLE), toGemini(GOOGLE)]);
    expect(document.activeElement).toBe(box());
  });

  describe('a fresh check of the old key', () => {
    const stillFailing = () => json({ connection: failing() });

    it('says the provider still turns it down', async () => {
      patchReply = stillFailing();
      renderFix(failing(), host);
      expect(recheck()).toHaveTextContent('Check the old key again');
      await press(recheck());
      expect(patches).toEqual([{ recheck: true }]);
      expect(status()).toHaveTextContent('Google still turns it down. A new key above fixes it.');
    });

    it.each([
      ['key_rejected', 401, {}, 'Google still turns it down. A new key above fixes it.'],
      [
        'no_credit',
        402,
        {},
        'Google accepted the key, but the account behind it has no credit. Add credit with Google, then check again.',
      ],
      [
        'daily_limit',
        429,
        { limitedUntil: '2026-10-08T07:00:00.000Z' },
        'Google accepted the key, but today’s limit on it is used up. It resets at 7 am. Check again then, or use another key.',
      ],
      ['network', 502, {}, 'Couldn’t reach Google just now. Check again in a moment.'],
      ['unreachable', 502, {}, 'Google couldn’t answer the test question just now. Check again in a moment.'],
      ['busy', 429, {}, 'Too many tries. Wait a few minutes and try again.'],
      ['server', 500, {}, 'Couldn’t check it just now. Try again in a moment.'],
    ])('%s: its own line', async (code, httpStatus, extra, line) => {
      patchReply = json({ error: code, ...extra }, httpStatus);
      renderFix(failing(), host);
      await press(recheck());
      expect(status()).toHaveTextContent(line);
    });

    it('region: another service works instead, pointing where that is from here', async () => {
      patchReply = json({ error: 'region' }, 403);
      renderFix(failing(), host);
      await press(recheck());
      const said = 'Google won’t answer from where dsul’s server is right now. A key from another service works instead';
      // The column points at Settings → AI; on the pane, that is where it already is.
      expect(status()).toHaveTextContent(host === 'column' ? `${said}, in Settings → AI.` : `${said}.`);
      if (host === 'pane') expect(status().textContent).not.toMatch(/Settings → AI/);
    });

    it('stays focusable while it runs, and ignores a second press', async () => {
      let release: (r: Response) => void = () => {};
      patchReply = () => new Promise<Response>((r) => (release = r));
      renderFix(failing(), host);
      const button = recheck();
      button.focus();
      await press(button);
      expect(button).toHaveTextContent('Checking…');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      await press(button);
      await act(async () => release(stillFailing()));
      expect(patches).toHaveLength(1);
      expect(document.activeElement).toBe(button);
    });
  });

  it('nothing lime, whatever is said', async () => {
    const lime = () =>
      Array.from(document.querySelectorAll('[data-ask-setup] [class*="bg-primary"], [data-ask-setup] [data-slot="button-key"]'));
    putReply = json({ error: 'unreachable' }, 502);
    const { unmount } = renderFix(failing(), host);
    await paste(box(), GOOGLE);
    expect(screen.getByTestId('fix-note')).toBeInTheDocument();
    expect(lime()).toEqual([]);
    unmount();
    unseed();
    renderFix(signIn(), host);
    expect(lime()).toEqual([]);
  });
});

/* ── The setup column (the default host) ────────────────────────────────── */

describe('the column', () => {
  it('names the connection, when it was turned down, and what that means', () => {
    renderFix();
    expect(within(card()).getByRole('heading', { level: 3 })).toHaveTextContent(/^Google Gemini$/);
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Google turned it down an hour ago$/);
    expect(screen.getByTestId('fix-explain')).toHaveTextContent(
      'Google stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.'
    );
    expect(screen.queryByTestId('mcp-fix')).toBeNull();
    // Outside the card: where everything else is.
    const caption = screen.getByTestId('fix-caption');
    expect(card()).not.toContainElement(caption);
    expect(caption).toHaveTextContent('Other services, the model and Disconnect are in Settings → AI.');
    expect(within(caption).getByRole('link', { name: 'Settings → AI' })).toHaveAttribute('href', '/settings/ai');
  });

  it('a moment ago is "just now", and a key dsul cannot read needs attention, with no fresh check', () => {
    const { unmount } = renderFix(failing({ checkedAt: new Date(NOW - 20_000).toISOString() }));
    expect(screen.getByTestId('fix-line')).toHaveTextContent('Key saved · Google turned it down just now');
    unmount();
    unseed();

    renderFix(failing({ problem: 'key_unreadable' }));
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Needs attention$/);
    expect(card()).toHaveTextContent(
      'dsul can’t read your saved key anymore, so AI can’t answer right now. Paste it again and Ask picks up where it left off.'
    );
    expect(screen.queryByTestId('setup-recheck')).toBeNull();
    expect(box()).toBeInTheDocument();
  });

  it('a custom address goes by its host, never "Other"', () => {
    renderFix(failing({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' }));
    expect(within(card()).getByRole('heading', { level: 3 })).toHaveTextContent(/^llm\.example\.com$/);
    expect(screen.getByLabelText('New llm.example.com key')).toBe(box());
    expect(card().textContent).not.toMatch(/\bOther\b/);
  });

  it('a region refusal of a new key points at Settings → AI, where another service is', async () => {
    putReply = json({ error: 'region' }, 403);
    renderFix();
    await paste(box(), GOOGLE);
    expect(within(screen.getByTestId('fix-note')).getByRole('alert')).toHaveTextContent(
      'Google won’t answer from where dsul’s server is right now. A key from another service works instead, in Settings → AI.'
    );
  });

  it('a custom service’s key never checks on paste, and carries its address and model', async () => {
    putReply = works({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' });
    renderFix(failing({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' }));
    await paste(box(), 'sk-proj-TEST-SENTINEL-9876');
    expect(puts).toEqual([]);
    expect(screen.queryByTestId('fix-note')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(puts).toEqual([
      { provider: 'custom', apiKey: 'sk-proj-TEST-SENTINEL-9876', baseUrl: 'https://llm.example.com/v1', model: 'my-model' },
    ]);
  });

  it('the key page, an outline button beside the fresh check', () => {
    renderFix();
    const links = screen.getAllByRole('link', { name: /Open Google AI Studio/ });
    expect(links).toHaveLength(1);
    expect(links[0].className).toMatch(/border-input/);
    expect(recheck().className).toMatch(/\btext-sm\b/);
  });

  describe('a sign-in', () => {
    it('signs in again, back home, and has no key box', () => {
      renderFix(signIn());
      expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Signed in · OpenRouter turned it down an hour ago$/);
      expect(card()).toHaveTextContent(
        'OpenRouter stopped accepting your sign-in, so AI can’t answer right now. Sign in again and Ask picks up where it left off.'
      );
      const again = screen.getByTestId('fix-signin-again');
      expect(again).toHaveAttribute('href', '/api/ai/openrouter/start?r=home');
      expect(again).toHaveTextContent('Sign in again');
      expect(screen.queryByTestId('fix-key')).toBeNull();
      expect(recheck()).toHaveTextContent('Check again');
      expect(card().textContent).not.toMatch(/[Pp]aste/);
    });

    it('a sign-in that came back without a fix says how it ended, until the next action', async () => {
      patchReply = json({ connection: signIn() });
      renderFix(signIn());
      act(() => useAIConnectionStore.getState().setFlowResult('denied'));
      const flow = screen.getByTestId('fix-flow-note');
      expect(within(flow).getByRole('alert')).toHaveTextContent(FLOW_COPY.denied);
      await press(recheck());
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
      expect(screen.queryByTestId('fix-flow-note')).toBeNull();
      expect(status()).toHaveTextContent('OpenRouter still turns it down. Signing in again fixes it.');
    });

    it('leaving spends what the sign-in said', async () => {
      const view = renderFix(signIn());
      act(() => useAIConnectionStore.getState().setFlowResult('expired'));
      vi.useRealTimers();
      view.unmount();
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
    });

    it('in the desktop app: a link to sign in from the browser, or a pasted OpenRouter key', async () => {
      (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      putReply = works({ provider: 'openrouter', authMethod: 'key' });
      renderFix(signIn());
      expect(screen.queryByTestId('fix-signin-again')).toBeNull();
      await press(screen.getByTestId('connect-copy-link'));
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/settings/ai?start=openrouter`);
      // Said where it can be seen: the card's own line.
      expect(status()).toHaveTextContent('Copied. Paste it into your browser.');

      expect(screen.getByLabelText('New OpenRouter key')).toBe(box());
      await paste(box(), OPENROUTER);
      expect(puts).toEqual([{ provider: 'openrouter', apiKey: OPENROUTER }]);
      expect(useAIConnectionStore.getState().justConnected).toBeNull();
    });
  });
});

/* ── Settings → AI (host 'pane') ────────────────────────────────────────── */

describe('the pane', () => {
  const alias = (id: string) => document.querySelector(`[data-setting-alias="${id}"]`);

  it('names the connection in the card’s own header, with no caption and no section of its own', () => {
    renderFix(failing(), 'pane');
    expect(paneCard()).toBeInTheDocument();
    expect(screen.queryByTestId('setup-fix')).toBeNull();
    expect(screen.queryByTestId('fix-caption')).toBeNull();
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent(/^Google Gemini$/);
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Google turned it down an hour ago$/);
  });

  it('says what is paused, in a resting note that is not an alert', () => {
    renderFix(failing(), 'pane');
    const explain = screen.getByTestId('fix-explain');
    expect(explain).toHaveTextContent(
      'Google stopped accepting this key. It may have been deleted in AI Studio, or its project was turned off. Ask and plan suggestions are paused until a working key is in.'
    );
    expect(explain.querySelector('[role="alert"]')).toBeNull();
    expect(explain).not.toHaveAttribute('role');
  });

  it('the key page is a link inside the box’s help, not an outline button', () => {
    renderFix(failing(), 'pane');
    const links = screen.getAllByRole('link', { name: 'Open Google AI Studio' });
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.closest('p')).toHaveTextContent(
      'Your old key is replaced only once this one works. Open Google AI Studio'
    );
    expect(link.className).not.toMatch(/border-input/);
    expect(link.className).toMatch(/\bunderline\b/);
  });

  it('a custom service has no key page, and goes by its host', () => {
    renderFix(failing({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' }), 'pane');
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Other · llm.example.com');
    expect(screen.getByLabelText('New llm.example.com key')).toBe(box());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('its own actions come after the fresh check, one size with it', () => {
    renderFix(failing(), 'pane');
    const action = screen.getByTestId('pane-action');
    expect(paneCard()).toContainElement(action);
    expect(recheck().compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recheck().className).toMatch(/\btext-xs\b/);
    expect(recheck().className).not.toMatch(/\btext-sm\b/);
  });

  it('anchors: the model on the header, the key on the key box, ringed by a deep link', () => {
    renderFix(failing(), 'pane', 'beacon.apiKey');
    expect(document.querySelectorAll('[data-setting-alias="beacon.model"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-setting-alias="beacon.apiKey"]')).toHaveLength(1);
    expect(alias('beacon.model')!.contains(screen.getByTestId('mcp-provider'))).toBe(true);
    expect(alias('beacon.apiKey')!.contains(box())).toBe(true);
    expect(alias('beacon.apiKey')).toHaveAttribute('data-highlight', 'true');
    expect(alias('beacon.model')).not.toHaveAttribute('data-highlight');
  });

  it('a sign-in signs in again back here, and with no box the key’s anchor is the note', () => {
    renderFix(signIn(), 'pane');
    expect(screen.getByTestId('fix-signin-again')).toHaveAttribute('href', '/api/ai/openrouter/start?r=settings');
    expect(screen.queryByTestId('fix-key')).toBeNull();
    expect(screen.getByTestId('fix-explain')).toHaveTextContent(
      'OpenRouter stopped accepting your sign-in. Ask and plan suggestions are paused until you sign in again.'
    );
    expect(alias('beacon.apiKey')).toBe(screen.getByTestId('fix-explain'));
    expect(document.querySelectorAll('[data-setting-alias="beacon.apiKey"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-setting-alias="beacon.model"]')).toHaveLength(1);
  });

  it('a key dsul cannot read says so in the line, with no fresh check', () => {
    renderFix(failing({ problem: 'key_unreadable' }), 'pane');
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · dsul can’t read it anymore$/);
    expect(screen.getByTestId('fix-explain')).toHaveTextContent(
      'dsul can’t read your saved key anymore. Ask and plan suggestions are paused until a working key is in.'
    );
    expect(screen.queryByTestId('setup-recheck')).toBeNull();
  });

  it('a region refusal of a new key says another service works, without sending anyone to Settings', async () => {
    putReply = json({ error: 'region' }, 403);
    renderFix(failing(), 'pane');
    await paste(box(), GOOGLE);
    const alert = within(screen.getByTestId('fix-note')).getByRole('alert');
    expect(alert).toHaveTextContent(
      'Google won’t answer from where dsul’s server is right now. A key from another service works instead.'
    );
    expect(alert.textContent).not.toMatch(/Settings → AI/);
  });

  it('in the desktop app: a sign-in is replaced with a pasted OpenRouter key, the saved model riding along', async () => {
    (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
    putReply = works({ provider: 'openrouter', authMethod: 'key' });
    renderFix(signIn(), 'pane');
    expect(screen.queryByTestId('fix-signin-again')).toBeNull();
    expect(screen.getByTestId('connect-openrouter-desktop')).toBeInTheDocument();
    await paste(box(), OPENROUTER);
    expect(puts).toEqual([{ provider: 'openrouter', apiKey: OPENROUTER, model: 'openai/gpt-4o-mini' }]);
  });
});

/* ── The words ──────────────────────────────────────────────────────────── */

describe('fixCopy', () => {
  it('with no host is the column’s, exactly as it was', () => {
    expect(fixCopy(failing({ status: 'ok', problem: null, model: null }))).toEqual({
      status: 'No model picked',
      note: 'No model is picked yet, so AI can’t answer. Pick one in Settings → AI.',
      href: '/settings/ai?focus=beacon.model',
      action: 'Pick a model in Settings → AI',
      check: 'Check the old key again',
      still: 'Google still turns it down. A new key above fixes it.',
    });
    expect(fixCopy(failing({ problem: 'key_unreadable' }))).toEqual({
      status: 'Needs attention',
      note: 'dsul can’t read your saved key anymore, so AI can’t answer right now. Paste it again and Ask picks up where it left off.',
      href: '/settings/ai',
      action: 'Settings → AI',
      check: 'Check the old key again',
      still: 'Google still turns it down. A new key above fixes it.',
    });
    expect(fixCopy(signIn({ problem: 'key_unreadable' }))).toEqual({
      status: 'Needs attention',
      note: 'dsul can’t read your saved sign-in anymore, so AI can’t answer right now. Sign in again and Ask picks up where it left off.',
      href: '/settings/ai',
      action: 'Settings → AI',
      check: 'Check again',
      still: 'OpenRouter still turns it down. Signing in again fixes it.',
    });
    expect(fixCopy(failing())).toEqual({
      status: 'Needs attention',
      note: 'Google stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.',
      href: '/settings/ai',
      action: 'Settings → AI',
      check: 'Check the old key again',
      still: 'Google still turns it down. A new key above fixes it.',
    });
    expect(fixCopy(signIn())).toEqual({
      status: 'Needs attention',
      note: 'OpenRouter stopped accepting your sign-in, so AI can’t answer right now. Sign in again and Ask picks up where it left off.',
      href: '/settings/ai',
      action: 'Settings → AI',
      check: 'Check again',
      still: 'OpenRouter still turns it down. Signing in again fixes it.',
    });
    expect(fixCopy(failing(), 'column')).toEqual(fixCopy(failing()));
  });

  it('on the pane swaps the note only', () => {
    const cases: [ModelConnectionView, string][] = [
      [
        failing(),
        'Google stopped accepting this key. It may have been deleted in AI Studio, or its project was turned off. Ask and plan suggestions are paused until a working key is in.',
      ],
      [
        failing({ provider: 'openai', model: 'gpt-4o-mini' }),
        'OpenAI stopped accepting this key. It may have been deleted or revoked. Ask and plan suggestions are paused until a working key is in.',
      ],
      [signIn(), 'OpenRouter stopped accepting your sign-in. Ask and plan suggestions are paused until you sign in again.'],
      [
        failing({ problem: 'key_unreadable' }),
        'dsul can’t read your saved key anymore. Ask and plan suggestions are paused until a working key is in.',
      ],
      [
        signIn({ problem: 'key_unreadable' }),
        'dsul can’t read your saved sign-in anymore. Ask and plan suggestions are paused until you sign in again.',
      ],
    ];
    for (const [model, note] of cases) {
      const pane = fixCopy(model, 'pane');
      expect(pane.note, note).toBe(note);
      expect({ ...pane, note: null }).toEqual({ ...fixCopy(model), note: null });
    }
  });
});

describe('ago', () => {
  it('says how long since, as a sentence does', () => {
    expect(ago(null)).toBeNull();
    expect(ago(undefined)).toBeNull();
    expect(ago('x')).toBeNull();
    expect(ago(new Date(NOW - 30_000).toISOString())).toBe('just now');
    expect(ago(new Date(NOW - 61_000).toISOString())).toBe('a minute ago');
    expect(ago(new Date(NOW - 3 * 60_000).toISOString())).toBe('3 minutes ago');
    expect(ago(new Date(NOW - 61 * 60_000).toISOString())).toBe('an hour ago');
    expect(ago(new Date(NOW - 26 * 3_600_000).toISOString())).toBe('a day ago');
    expect(ago(new Date(NOW - 3 * 86_400_000).toISOString())).toBe('3 days ago');
  });

  it('honours an explicit now', () => {
    const at = '2026-10-07T12:00:00.000Z';
    expect(ago(at, Date.parse('2026-10-07T12:00:20.000Z'))).toBe('just now');
    expect(ago(at, Date.parse('2026-10-07T14:00:00.000Z'))).toBe('2 hours ago');
  });
});
