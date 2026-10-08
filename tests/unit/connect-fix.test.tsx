import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The fix home's card (components/ai/connect/connect-fix.tsx): a saved
 * connection the provider stopped accepting, or one dsul can no longer read,
 * fixed in place in the setup column. Rendered against the REAL connection
 * store with a fake route behind `fetch`. Where it shows, and the no-model
 * state beside it, are ask-setup.test.tsx's.
 *
 *  - What is wrong, in plain words: "Key saved · Google turned it down an
 *    hour ago", and a honey note.
 *  - A box for a new key, with the connect card's mechanics: a sure paste of
 *    the saved provider's key checks itself, anything else waits for Connect,
 *    another company's key gets its note. A key that works fixes it in place:
 *    never "It works.", since Ask picks up where it left off.
 *  - A fresh check of the old key, with a line for each answer.
 *  - A sign-in signs in again, home; in the desktop app, from the browser by a
 *    copied link, or by a pasted OpenRouter key.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { ConnectFix } from '@/components/ai/connect/connect-fix';
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as { dsulDesktop?: unknown }).dsulDesktop;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

/** The saved connection in the store, as the gate would have it, and the card for it in the column. */
function renderFix(model: ModelConnectionView = failing()) {
  unseed = seedAI({ ...KEY_TURNED_DOWN, model });
  return render(
    <aside data-ask-setup="fix">
      <ConnectFix model={model} />
    </aside>
  );
}

const card = () => screen.getByTestId('setup-fix');
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

describe('what is wrong', () => {
  it('names the connection, when it was turned down, and what that means', () => {
    renderFix();
    expect(within(card()).getByRole('heading', { level: 3 })).toHaveTextContent(/^Google Gemini$/);
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Google turned it down an hour ago$/);
    expect(card()).toHaveTextContent(
      'Google stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.'
    );
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
});

describe('a new key', () => {
  it('a sure paste of the saved provider’s key checks itself, and fixes it in place', async () => {
    let release: (r: Response) => void = () => {};
    putReply = () => new Promise<Response>((r) => (release = r));
    renderFix();
    expect(screen.getByLabelText('New Gemini key')).toBe(box());
    expect(card()).toHaveTextContent('Your old key is replaced only once this one works.');
    expect(status()).toBeEmptyDOMElement();
    await paste(box(), GOOGLE);
    // The saved provider's own key: the model is the route's to keep.
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
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
    renderFix();
    await paste(box(), UNKNOWN);
    expect(puts).toEqual([]);
    expect(screen.getByTestId('fix-note')).toHaveTextContent(
      'That doesn’t look like a Google key. Google’s keys start with AQ. or AIza.'
    );
    await press(screen.getByTestId('fix-submit'));
    expect(puts).toEqual([{ provider: 'gemini', apiKey: UNKNOWN }]);
  });

  it('another company’s key: a note, and Use it with that company', async () => {
    putReply = works();
    renderFix();
    await paste(box(), ANTHROPIC);
    expect(puts).toEqual([]);
    const note = screen.getByTestId('fix-note');
    expect(within(note).getByRole('alert')).toHaveTextContent(
      'That looks like an Anthropic key, not a Google one. Anthropic keys work too, but they need credit on your Anthropic account.'
    );
    expect(screen.queryByTestId('fix-submit')).toBeNull();
    await press(within(note).getByRole('button', { name: 'Use it with Anthropic' }));
    expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
    expect(document.activeElement).toBe(box());
  });

  it('a refused new key stays, says why, and offers to check it again and where keys are made', async () => {
    putReply = json({ error: 'key_rejected' }, 400);
    renderFix();
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
    expect(puts).toHaveLength(2);
    expect(document.activeElement).toBe(box());
  });

  it('a region refusal points at Settings → AI, where another service is', async () => {
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

  it('the key page beside the fresh check', () => {
    renderFix();
    expect(screen.getAllByRole('link', { name: /Open Google AI Studio/ })).toHaveLength(1);
  });
});

describe('a fresh check of the old key', () => {
  const stillFailing = () => json({ connection: failing() });

  it('says the provider still turns it down', async () => {
    patchReply = stillFailing();
    renderFix();
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
    [
      'region',
      403,
      {},
      'Google won’t answer from where dsul’s server is right now. A key from another service works instead, in Settings → AI.',
    ],
    ['network', 502, {}, 'Couldn’t reach Google just now. Check again in a moment.'],
    ['unreachable', 502, {}, 'Google couldn’t answer the test question just now. Check again in a moment.'],
    ['busy', 429, {}, 'Too many tries. Wait a few minutes and try again.'],
    ['server', 500, {}, 'Couldn’t check it just now. Try again in a moment.'],
  ])('%s: its own line', async (code, httpStatus, extra, line) => {
    patchReply = json({ error: code, ...extra }, httpStatus);
    renderFix();
    await press(recheck());
    expect(status()).toHaveTextContent(line);
  });

  it('stays focusable while it runs, and ignores a second press', async () => {
    let release: (r: Response) => void = () => {};
    patchReply = () => new Promise<Response>((r) => (release = r));
    renderFix();
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

describe('nothing lime', () => {
  it('in any of its states', async () => {
    const lime = () => Array.from(document.querySelectorAll('[data-ask-setup] [class*="bg-primary"], [data-ask-setup] [data-slot="button-key"]'));
    putReply = json({ error: 'unreachable' }, 502);
    const { unmount } = renderFix();
    await paste(box(), GOOGLE);
    expect(screen.getByTestId('fix-note')).toBeInTheDocument();
    expect(lime()).toEqual([]);
    unmount();
    unseed();
    renderFix(signIn());
    expect(lime()).toEqual([]);
  });
});
