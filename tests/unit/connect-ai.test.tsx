import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';

/**
 * Connect AI (components/ai/connect/connect-ai.tsx): the way in wherever
 * nothing answers yet, the setup column's setup home (host 'column') and
 * Settings → AI's not-connected state (host 'pane'). Rendered against the REAL
 * connection store with a fake route behind `fetch`.
 *
 *  - A paste checks itself only when its prefix is sure and is the box's own
 *    company's; anything else waits for Connect. Typing never checks.
 *  - The key lives in the box's value property and nowhere else: not an
 *    attribute, not the store, not the page. A refused key stays in the box;
 *    a working one leaves it at once.
 *  - Every answer has its own line, in our words, naming the company.
 *  - Success: the column becomes Ask with "It works." only for a connection
 *    that can answer; the pane hands off to its connected card. On the
 *    phone's page, the phone's stack goes home.
 *  - A question kept from `?` (lib/ask-pending.ts), in the column only: a
 *    paste never sends, a consent line names where the question goes right
 *    above whatever would send it, and each such press stamps the consent the
 *    question is later sent on. [Use it with X] only points the card at X.
 *  - Nothing in the column is lime, and no connect file has an em dash or
 *    names the AI.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { ConnectAI, GoodToKnow, GoodToKnowConnected } from '@/components/ai/connect/connect-ai';
import { KEY_FIELD_PROPS } from '@/components/ai/connect/key-field';
import {
  checkFailureCopy,
  desktopSignInLink,
  goodToKnowCopy,
  hostOf,
  labelName,
  limitCopy,
  wrongKindCopy,
} from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import {
  ASK_CLAIMED_KEY,
  __resetKeptForTests,
  clearKept,
  clearKeptQuestionState,
  keepQuestion,
  readKept,
  type KeptConsent,
} from '@/lib/ask-pending';
import { FLOW_COPY } from '@/lib/connect-flow';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import type { ModelConnectionView } from '@/lib/ai-types';
import { seedAI, NOTHING_CONNECTED, SEED_USER_ID } from './helpers/ai-fixtures';

/* ── Keys ───────────────────────────────────────────────────────────────── */

const GOOGLE = 'AIzaSyTEST-SENTINEL-9876';
const GOOGLE_AQ = 'AQ.Ab8RN6TEST-SENTINEL-9876';
const OPENAI_SURE = 'sk-proj-TEST-SENTINEL-9876';
/** A bare `sk-`: OpenAI's, or DeepSeek's, or anyone's. */
const SK_UNSURE = 'sk-TEST-SENTINEL-98765';
const ANTHROPIC = 'sk-ant-api03-TEST-SENTINEL-9876';
const OPENROUTER = 'sk-or-v1-TEST-SENTINEL-9876';
/** A key no prefix places. */
const UNKNOWN = 'gsk_TEST-SENTINEL-9876';

/* ── A fake route ───────────────────────────────────────────────────────── */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function view(over: Partial<ModelConnectionView> = {}): ModelConnectionView {
  return {
    provider: 'gemini',
    model: 'gemini-flash-latest',
    baseUrl: null,
    authMethod: 'key',
    status: 'ok',
    problem: null,
    checkedAt: '2026-10-07T12:00:00.000Z',
    limitedUntil: null,
    modelLabel: null,
    ...over,
  };
}

interface Put {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

let puts: Put[];
let putReply: (body: Put) => Response | Promise<Response>;

/** The route's answer to a key that works, for whichever provider it was sent to. */
const works = (over: Partial<ModelConnectionView> = {}, extra: Record<string, unknown> = {}) => (body: Put) =>
  json({
    connection: view({ provider: body.provider as ModelConnectionView['provider'], ...over }),
    models: [],
    listed: true,
    ...extra,
  });

let unseed: () => void = () => {};

beforeEach(() => {
  puts = [];
  putReply = () => json({ error: 'server' }, 500);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/ai/connection' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Put;
        puts.push(body);
        return putReply(body);
      }
      return json({ available: true, model: null, openclaw: {}, aiHidden: false });
    })
  );
  Element.prototype.scrollIntoView = vi.fn();
  usePlannerStore.setState({ userTimezone: 'UTC', timeFormat: '12h' } as never);
  useRailStore.getState().reset();
  unseed = seedAI(NOTHING_CONNECTED);
});

afterEach(() => {
  cleanup();
  unseed();
  clearKeptQuestionState();
  localStorage.removeItem(ASK_CLAIMED_KEY);
  __resetKeptForTests();
  vi.unstubAllGlobals();
  delete (window as unknown as { dsulDesktop?: unknown }).dsulDesktop;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

/* ── Helpers ────────────────────────────────────────────────────────────── */

type Host = 'column' | 'pane';

/** The column's card sits inside the setup column (`data-ask-setup`); the pane's in Settings. */
function renderConnect(host: Host, onConnected = vi.fn()) {
  const ui =
    host === 'column' ? (
      <aside data-ask-setup="invite">
        <ConnectAI host="column" />
      </aside>
    ) : (
      <ConnectAI host="pane" highlightId={null} onConnected={onConnected} />
    );
  return { ...render(ui), onConnected };
}

const box = (id = 'connect-key') => screen.getByTestId(id) as HTMLInputElement;
const note = (id = 'connect-note') => screen.getByTestId(id);
const status = () => screen.getByTestId('connect-status');

/** A paste, as a browser delivers one: the box reads the clipboard's text itself. */
function paste(input: HTMLElement, text: string) {
  return act(async () => {
    fireEvent.paste(input, { clipboardData: { getData: () => text } });
  });
}
function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}
const press = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });

/** A PUT held until `release` answers it. */
function holdPut() {
  let release: (r: Response) => void = () => {};
  putReply = () => new Promise<Response>((resolve) => (release = resolve));
  return (r: Response) => act(async () => release(r));
}

/** The key, nowhere but a box's value property. */
function expectKeyOnlyInValue(fragment = 'SENTINEL') {
  expect(document.body.innerHTML).not.toContain(fragment);
  expect(JSON.stringify(useAIConnectionStore.getState())).not.toContain(fragment);
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain(fragment);
  }
}

function openFold(id: 'openrouter' | 'any') {
  fireEvent.click(screen.getByTestId(`connect-fold-${id}`));
}

/* ── Both hosts ─────────────────────────────────────────────────────────── */

describe.each<Host>(['column', 'pane'])('on the %s', (host) => {
  it('a sure Google key pasted is checked at once, exactly once, and leaves the box when it works', async () => {
    const release = holdPut();
    renderConnect(host);
    expect(status()).toBeEmptyDOMElement();
    await paste(box(), `  ${GOOGLE}  `);
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);

    // While it is out: read-only and busy, never disabled; said once, in the live region.
    expect(box()).toHaveAttribute('readonly');
    expect(box()).toHaveAttribute('aria-busy', 'true');
    expect(box()).not.toBeDisabled();
    expect(status()).toHaveTextContent('Checking your key with Google…');
    expect(screen.getByTestId('connect-checking')).toHaveAttribute('aria-hidden', 'true');
    // A second paste while it is out sends nothing.
    await paste(box(), GOOGLE_AQ);
    expect(puts).toHaveLength(1);

    await release(works()(puts[0]));
    expect(box().value).toBe('');
    expect(box()).not.toHaveAttribute('readonly');
    expectKeyOnlyInValue();
  });

  it('a key that is not surely Google’s waits for Connect, and typing never checks', async () => {
    renderConnect(host);
    await paste(box(), UNKNOWN);
    expect(puts).toEqual([]);
    expect(note()).toHaveAttribute('data-note', 'undetected');
    expect(note()).toHaveTextContent('That doesn’t look like a Google key. Google’s keys start with AQ. or AIza.');

    type(box(), GOOGLE);
    expect(puts).toEqual([]);
    expect(screen.queryByTestId('connect-note')).toBeNull();
    // Connect is never `disabled`: it stays focusable, and sends.
    putReply = works();
    await press(screen.getByTestId('connect-submit'));
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
  });

  it('a refused key stays in its box, in the value property only', async () => {
    putReply = () => json({ error: 'key_rejected' }, 400);
    renderConnect(host);
    await paste(box(), GOOGLE);
    expect(note()).toHaveAttribute('data-code', 'key_rejected');
    expect(box().value).toBe(GOOGLE);
    expect(box()).not.toHaveAttribute('value');
    expect(box().type).toBe('password');
    expectKeyOnlyInValue();
  });

  it('carries every key-box attribute', () => {
    renderConnect(host);
    const key = box();
    expect(key.type).toBe(KEY_FIELD_PROPS.type);
    expect(key.name).toBe(KEY_FIELD_PROPS.name);
    expect(key.autocomplete).toBe('off');
    expect(key).toHaveAttribute('spellcheck', 'false');
    expect(key).toHaveAttribute('autocapitalize', 'none');
    expect(key).toHaveAttribute('autocorrect', 'off');
    expect(key).toHaveAttribute('data-1p-ignore');
    expect(key).toHaveAttribute('data-lpignore', 'true');
    expect(screen.getByLabelText('Your Gemini key')).toBe(key);
  });

  it('signs in with OpenRouter back to where it started', () => {
    renderConnect(host);
    const link = screen.getByTestId('connect-openrouter-signin');
    expect(link).toHaveAttribute('href', `/api/ai/openrouter/start?r=${host === 'pane' ? 'settings' : 'home'}`);
    expect(screen.getByTestId('connect-fold-openrouter-body')).toHaveTextContent(
      host === 'pane'
        ? 'OpenRouter opens in this tab and sends you back here.'
        : 'OpenRouter opens in this tab and sends you back to this column.'
    );
  });
});

/* ── Success ────────────────────────────────────────────────────────────── */

describe('a key that works', () => {
  it('in the column: Ask, home first, with "It works." for a connection that can answer', async () => {
    act(() => useRailStore.getState().push('desktop', { kind: 'history' }));
    putReply = works({}, { freeTier: true });
    renderConnect('column');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-07T19:30:00.000Z'));
    try {
      await paste(box(), GOOGLE);
    } finally {
      vi.useRealTimers();
    }
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
    expect(useAIConnectionStore.getState().justConnected).toEqual({
      provider: 'gemini',
      model: 'gemini-flash-latest',
      freeTier: true,
      at: Date.parse('2026-10-07T19:30:00.000Z'),
    });
  });

  it('in the column: a connection saved with no model picked says nothing to cheer', async () => {
    act(() => useRailStore.getState().push('desktop', { kind: 'history' }));
    putReply = works({ model: null });
    renderConnect('column');
    await paste(box(), GOOGLE);
    expect(puts).toHaveLength(1);
    expect(useAIConnectionStore.getState().model?.model).toBeNull();
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
    expect(useRailStore.getState().stacks.desktop).toEqual([{ kind: 'history' }]);
  });

  it('in the pane: hands off to the connected card, and never sets the column’s "It works."', async () => {
    putReply = works();
    const { onConnected } = renderConnect('pane');
    await paste(box(), GOOGLE);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
  });
});

/* ── The key card ───────────────────────────────────────────────────────── */

describe('the key card', () => {
  it('leads with the free Google key, in the spec’s words', () => {
    renderConnect('column');
    const card = screen.getByTestId('connect-key-card');
    expect(card).toHaveTextContent('Free, no card');
    expect(within(card).getByRole('heading', { name: 'Get a free key from Google' })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'Anyone with a Google account can make one. It works in dsul on the web and in the desktop app.'
    );
    expect(card).toHaveTextContent('A ChatGPT or Claude subscription isn’t an API key. This free key works instead.');
    expect(screen.getByTestId('connect-steps')).toHaveTextContent('It starts with AQ. or AIza.');
    expect(within(card).getByRole('link', { name: /Open Google AI Studio/ })).toHaveAttribute(
      'href',
      'https://aistudio.google.com/apikey'
    );
    expect(card).toHaveTextContent('dsul checks it the moment you paste, with one tiny test question.');
  });

  it('a paste that is not checked is said in the live region, until the box changes or a check starts', async () => {
    renderConnect('column');
    await paste(box(), UNKNOWN);
    // The quiet note's own words: it has no live role of its own.
    expect(status()).toHaveTextContent('That doesn’t look like a Google key. Google’s keys start with AQ. or AIza.');
    expect(status().textContent).toBe(note().textContent);
    expect(within(note()).queryByRole('alert')).toBeNull();

    type(box(), `${UNKNOWN}x`);
    expect(status()).toBeEmptyDOMElement();

    await paste(box(), UNKNOWN);
    expect(status()).not.toBeEmptyDOMElement();
    const release = holdPut();
    await press(screen.getByTestId('connect-submit'));
    expect(status()).toHaveTextContent('Checking your key with Google…');
    await release(json({ error: 'key_rejected' }, 400));
    expect(status()).toBeEmptyDOMElement();

    // Another company's key has its own alert, and nothing more to say here.
    await paste(box(), ANTHROPIC);
    expect(note()).toHaveAttribute('data-note', 'wrong');
    expect(status()).toBeEmptyDOMElement();
  });

  it('a Google key starting AQ. is as sure as one starting AIza', async () => {
    putReply = works();
    renderConnect('column');
    await paste(box(), GOOGLE_AQ);
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE_AQ }]);
  });

  it('Enter sends a typed key; an empty box sends nothing', async () => {
    putReply = works();
    renderConnect('column');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(screen.queryByTestId('connect-note')).toBeNull();
    type(box(), GOOGLE);
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
  });

  it('something that can’t be a key is refused before it is sent', async () => {
    renderConnect('column');
    await paste(box(), 'AIzaX');
    expect(puts).toEqual([]);
    expect(note()).toHaveAttribute('data-note', 'invalid');
    expect(within(note()).getByRole('alert')).toHaveTextContent(
      'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.'
    );
  });

  it('the steps fold once a key is in, open on request, and come back on a refusal', async () => {
    renderConnect('column');
    const steps = screen.getByTestId('connect-steps');
    expect(steps).not.toHaveAttribute('hidden');
    expect(screen.getByRole('heading', { name: 'What you’ll see' })).toBeInTheDocument();
    expect(screen.queryByTestId('connect-steps-toggle')).toBeNull();

    await paste(box(), UNKNOWN);
    const toggle = screen.getByTestId('connect-steps-toggle');
    expect(steps).toHaveAttribute('hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Show the steps');
    fireEvent.click(toggle);
    expect(steps).not.toHaveAttribute('hidden');
    expect(toggle).toHaveTextContent('Hide the steps');

    // A new paste folds them again; a refusal brings them back.
    putReply = () => json({ error: 'key_rejected' }, 400);
    await paste(box(), UNKNOWN);
    expect(steps).toHaveAttribute('hidden');
    await press(screen.getByTestId('connect-submit'));
    expect(note()).toHaveAttribute('data-code', 'key_rejected');
    expect(steps).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('connect-steps-toggle')).toHaveAttribute('aria-expanded', 'true');

    // An empty box is the start again.
    type(box(), '');
    expect(screen.queryByTestId('connect-steps-toggle')).toBeNull();
    expect(steps).not.toHaveAttribute('hidden');
  });

  it('another company’s key: nothing sent, a note, and Use it with that company', async () => {
    putReply = works();
    renderConnect('column');
    await paste(box(), ANTHROPIC);
    expect(puts).toEqual([]);
    expect(note()).toHaveAttribute('data-note', 'wrong');
    expect(within(note()).getByRole('alert')).toHaveTextContent(
      'That looks like an Anthropic key, not a Google one. Anthropic keys work too, but they need credit on your Anthropic account.'
    );
    // The note's actions stand in for Connect.
    expect(screen.queryByTestId('connect-submit')).toBeNull();
    await press(within(note()).getByRole('button', { name: 'Use it with Anthropic' }));
    expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
    expect(document.activeElement).toBe(box());
  });

  it('Clear empties the box and puts focus back in it', async () => {
    renderConnect('column');
    await paste(box(), OPENAI_SURE);
    expect(note()).toHaveTextContent('That looks like an OpenAI key, not a Google one.');
    fireEvent.click(within(note()).getByRole('button', { name: 'Clear' }));
    expect(box().value).toBe('');
    expect(screen.queryByTestId('connect-note')).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('the route’s own wrong_provider shows the same note, with its action', async () => {
    putReply = (body) =>
      body.provider === 'gemini' ? json({ error: 'wrong_provider', detected: 'openai' }, 400) : works()(body);
    renderConnect('column');
    await paste(box(), UNKNOWN);
    await press(screen.getByTestId('connect-submit'));
    expect(note()).toHaveAttribute('data-note', 'wrong');
    expect(note()).toHaveAttribute('data-detected', 'openai');
    expect(note()).toHaveTextContent('That looks like an OpenAI key, not a Google one.');
    await press(within(note()).getByRole('button', { name: 'Use it with OpenAI' }));
    expect(puts.map((p) => p.provider)).toEqual(['gemini', 'openai']);
  });

  describe('every answer has its line', () => {
    const cases: {
      code: string;
      status: number;
      body?: Record<string, unknown>;
      line: string;
      again: boolean;
    }[] = [
      {
        code: 'key_rejected',
        status: 400,
        line: 'Google didn’t accept that key. It may be cut short, or it was deleted in AI Studio. It’s still in the box, so you can check it or paste a new one.',
        again: true,
      },
      {
        code: 'no_credit',
        status: 402,
        line: 'Google accepted the key, but the account behind it has no credit. Add credit with Google, then check again.',
        again: true,
      },
      {
        code: 'daily_limit',
        status: 429,
        body: { limitedUntil: '2026-10-08T07:00:00.000Z' },
        line: 'Google accepted the key, but today’s limit on it is used up. It resets at 7 am. Check again then, or use another key.',
        again: true,
      },
      {
        code: 'daily_limit',
        status: 429,
        line: 'Google accepted the key, but today’s limit on it is used up. Check again once it resets, or use another key.',
        again: true,
      },
      {
        code: 'region',
        status: 403,
        line: 'Google won’t answer from where dsul’s server is right now. A key from another service works instead, under “I already use…” below.',
        again: false,
      },
      { code: 'network', status: 502, line: 'Couldn’t reach Google just now. Check again in a moment.', again: true },
      {
        code: 'unreachable',
        status: 502,
        line: 'Google couldn’t answer the test question just now. Check again in a moment.',
        again: true,
      },
      { code: 'busy', status: 429, line: 'Too many tries. Wait a few minutes and try again.', again: false },
      {
        code: 'invalid',
        status: 400,
        body: { field: 'apiKey' },
        line: 'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.',
        again: false,
      },
      { code: 'server', status: 500, line: 'Something went wrong. Try again.', again: true },
    ];

    it.each(cases)('$code ($status): our words, an alert scrolled into view, the key kept', async (c) => {
      putReply = () => json({ error: c.code, ...c.body }, c.status);
      renderConnect('column');
      await paste(box(), GOOGLE);
      const n = note();
      expect(n).toHaveAttribute('data-note', 'failure');
      expect(within(n).getByRole('alert')).toHaveTextContent(c.line);
      expect(n.className).toMatch(/bg-warning\/10/);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      expect(box().value).toBe(GOOGLE);
      const again = within(n).queryByRole('button', { name: 'Check again' });
      expect(Boolean(again)).toBe(c.again);
      // The refusal names where Google's keys are made.
      expect(Boolean(within(n).queryByRole('link', { name: /Open Google AI Studio/ }))).toBe(c.code === 'key_rejected');
    });

    it('Check again sends the same key once more, focus back in the box, and scrolls the note in again', async () => {
      putReply = () => json({ error: 'unreachable' }, 502);
      renderConnect('column');
      await paste(box(), GOOGLE);
      const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
      const before = scroll.mock.calls.length;
      await press(within(note()).getByRole('button', { name: 'Check again' }));
      expect(puts).toEqual([
        { provider: 'gemini', apiKey: GOOGLE },
        { provider: 'gemini', apiKey: GOOGLE },
      ]);
      expect(document.activeElement).toBe(box());
      expect(scroll.mock.calls.length).toBeGreaterThan(before);
    });

    it('names a key from another company by that company', () => {
      expect(checkFailureCopy('key_rejected', 'openai')).toBe('OpenAI didn’t accept that key. Check that you copied all of it.');
      expect(checkFailureCopy('no_credit', 'anthropic')).toBe(
        'Anthropic accepted the key, but the account behind it may need credit, or has hit a spend limit. Add credit with Anthropic, then check again.'
      );
      expect(checkFailureCopy('region', 'gemini', { elsewhere: 'here' })).toBe(
        'Google won’t answer from where dsul’s server is right now. A key from another service works instead.'
      );
      expect(checkFailureCopy('region', 'gemini', { elsewhere: 'settings' })).toBe(
        'Google won’t answer from where dsul’s server is right now. A key from another service works instead, in Settings → AI.'
      );
      expect(checkFailureCopy('key_rejected', 'custom', { baseUrl: 'https://llm.example.com/v1' })).toBe(
        'llm.example.com didn’t accept that key. Check that you copied all of it.'
      );
      expect(wrongKindCopy('openrouter', 'gemini')).toBe(
        'That looks like an OpenRouter key, not a Google one. OpenRouter keys work too.'
      );
      expect(labelName('custom', null)).toBe('Your service');
      expect(hostOf('not a url')).toBeNull();
    });
  });

  describe('the box', () => {
    it('Show and Hide, named for what they do (never also pressed), and never changing the key', async () => {
      renderConnect('column');
      expect(screen.queryByRole('button', { name: 'Show key' })).toBeNull();
      await paste(box(), UNKNOWN);
      const show = screen.getByRole('button', { name: 'Show key' });
      // A name that swaps and a pressed state would read "Hide key, pressed"
      // while the key is on screen.
      expect(show).not.toHaveAttribute('aria-pressed');
      fireEvent.click(show);
      expect(box().type).toBe('text');
      const hide = screen.getByRole('button', { name: 'Hide key' });
      expect(hide).not.toHaveAttribute('aria-pressed');
      fireEvent.click(hide);
      expect(box().type).toBe('password');
      expect(box().value).toBe(UNKNOWN);
    });

    it('offers no Paste button where the clipboard can’t be read', () => {
      renderConnect('column');
      expect(screen.queryByTestId('connect-key-paste')).toBeNull();
    });

    it('Paste reads the clipboard, checks a sure key, and leaves focus in the box', async () => {
      const readText = vi.fn(async () => GOOGLE);
      Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
      putReply = () => json({ error: 'key_rejected' }, 400);
      renderConnect('column');
      await press(screen.getByTestId('connect-key-paste'));
      expect(readText).toHaveBeenCalledTimes(1);
      expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
      expect(document.activeElement).toBe(box());
      // The button gives way to Show once there is a key.
      expect(screen.queryByTestId('connect-key-paste')).toBeNull();
    });

    it('a refused clipboard says to paste into the box, focus in it', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: vi.fn(async () => Promise.reject(new Error('denied'))) },
        configurable: true,
      });
      renderConnect('column');
      await press(screen.getByTestId('connect-key-paste'));
      expect(screen.getByText('Paste into the box instead.')).toBeInTheDocument();
      expect(box()).toHaveAccessibleDescription(/Paste into the box instead\./);
      expect(document.activeElement).toBe(box());
      expect(puts).toEqual([]);
    });

    it('offers no Paste button in the desktop app, which reads no clipboard', () => {
      Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn() }, configurable: true });
      (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
      renderConnect('column');
      expect(screen.queryByTestId('connect-key-paste')).toBeNull();
    });

    it('is emptied before it leaves the page', async () => {
      const { unmount } = renderConnect('column');
      await paste(box(), UNKNOWN);
      const node = box();
      unmount();
      expect(node.value).toBe('');
    });
  });
});

/* ── The folds ──────────────────────────────────────────────────────────── */

describe('the folds', () => {
  it('open one at a time; a closed one stays mounted, hidden, and keeps what was typed', () => {
    renderConnect('column');
    const orBody = screen.getByTestId('connect-fold-openrouter-body');
    const anyBody = screen.getByTestId('connect-fold-any-body');
    expect(orBody).toHaveAttribute('hidden');
    expect(anyBody).toHaveAttribute('hidden');

    openFold('any');
    expect(screen.getByTestId('connect-fold-any')).toHaveAttribute('aria-expanded', 'true');
    type(box('connect-any-key'), SK_UNSURE);
    openFold('openrouter');
    expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('connect-fold-any')).toHaveAttribute('aria-expanded', 'false');
    expect(anyBody).toHaveAttribute('hidden');
    expect(box('connect-any-key').value).toBe(SK_UNSURE);
    openFold('openrouter');
    expect(orBody).toHaveAttribute('hidden');
  });

  it('OpenRouter: what happens, in the spec’s words', () => {
    renderConnect('column');
    expect(screen.getByTestId('connect-fold-openrouter')).toHaveTextContent(
      'Sign in with OpenRouterFree models on a new, free account. Nothing to copy.'
    );
    expect(screen.getByTestId('connect-fold-openrouter-body')).toHaveTextContent(
      'Make a free OpenRouter account, then come back here. On a new account, dsul picks a free model, which has a daily limit.'
    );
  });

  describe('in the desktop app', () => {
    beforeEach(() => {
      (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
    });

    it('copies a link to this same site for the browser, and says so', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderConnect('column');
      openFold('openrouter');
      expect(screen.queryByTestId('connect-openrouter-signin')).toBeNull();
      expect(screen.getByTestId('connect-openrouter-desktop')).toHaveTextContent(
        'Sign-in can’t finish inside the desktop app yet. Open dsul in your browser and sign in there. This window picks up the connection when you come back.'
      );
      expect(screen.getByTestId('connect-fold-openrouter-body')).toHaveTextContent(
        'Or use the free Google key above, which works here as it is.'
      );
      await press(screen.getByTestId('connect-copy-link'));
      // The window's own origin: a dev or staging shell never sends it to production.
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/settings/ai?start=openrouter`);
      expect(desktopSignInLink()).toBe(`${window.location.origin}/settings/ai?start=openrouter`);
      expect(status()).toHaveTextContent('Copied. Paste it into your browser.');
    });

    it('a check that starts clears "Copied", so the region never says it again when the check ends', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
      putReply = () => json({ error: 'unreachable' }, 502);
      renderConnect('column');
      await paste(box(), GOOGLE);
      openFold('openrouter');
      await press(screen.getByTestId('connect-copy-link'));
      expect(status()).toHaveTextContent('Copied. Paste it into your browser.');
      // Check again: nothing touches the box, so only the check itself clears it.
      const release = holdPut();
      await press(within(note()).getByRole('button', { name: 'Check again' }));
      expect(status()).toHaveTextContent('Checking your key with Google…');
      await release(json({ error: 'unreachable' }, 502));
      expect(note()).toHaveAttribute('data-code', 'unreachable');
      expect(status()).toBeEmptyDOMElement();
    });

    it('a copy that fails shows the link to copy by hand', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
        configurable: true,
      });
      renderConnect('column');
      openFold('openrouter');
      await press(screen.getByTestId('connect-copy-link'));
      expect(screen.getByRole('alert')).toHaveTextContent(
        `Couldn’t copy it. Open ${window.location.origin}/settings/ai?start=openrouter in your browser.`
      );
    });
  });

  describe('a sign-in that came back home without a working connection', () => {
    const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

    it('opens the OpenRouter fold on its note, which the next action spends', async () => {
      act(() => useAIConnectionStore.getState().setFlowResult('denied'));
      renderConnect('column');
      expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'true');
      const flow = screen.getByTestId('connect-flow-note');
      expect(flow).toHaveAttribute('data-flow', 'denied');
      expect(within(flow).getByRole('alert')).toHaveTextContent(FLOW_COPY.denied);
      openFold('any');
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
      expect(screen.queryByTestId('connect-flow-note')).toBeNull();
    });

    it('one that arrives while it shows opens the fold too, and leaving spends it', async () => {
      const { unmount } = renderConnect('column');
      expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'false');
      act(() => useAIConnectionStore.getState().setFlowResult('no_credit'));
      expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('connect-flow-note')).toHaveTextContent(FLOW_COPY.no_credit);
      unmount();
      await settle();
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
    });

    it('a paste spends it too', async () => {
      act(() => useAIConnectionStore.getState().setFlowResult('expired'));
      renderConnect('column');
      await paste(box(), UNKNOWN);
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
    });
  });
});

/* ── I already use… ─────────────────────────────────────────────────────── */

describe('“I already use…”', () => {
  const any = () => box('connect-any-key');

  it('says what it is for, in the spec’s words', () => {
    renderConnect('column');
    expect(screen.getByTestId('connect-fold-any')).toHaveTextContent(
      'I already use OpenAI, Anthropic, Gemini or another servicePaste a key you have, use your own server, or pair OpenClaw.'
    );
    openFold('any');
    const body = screen.getByTestId('connect-fold-any-body');
    expect(body).toHaveTextContent('Paste a key from any of them. dsul reads which service it’s for and checks it the same way.');
    expect(within(body).getByRole('link', { name: 'OpenAI' })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(within(body).getByRole('link', { name: 'Anthropic' })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys'
    );
    expect(within(body).getByRole('link', { name: 'OpenRouter' })).toHaveAttribute(
      'href',
      'https://openrouter.ai/settings/keys'
    );
    expect(body).toHaveTextContent(
      'A ChatGPT Plus or Claude Pro plan isn’t an API key. Each company bills its API on its own, with credit you add first.'
    );
    const claw = screen.getByTestId('connect-openclaw');
    expect(claw).toHaveAttribute('href', '/docs/openclaw');
    expect(claw).toHaveTextContent('Your own agent answers in Ask. The OpenClaw guide shows how to pair it.');
  });

  it.each([
    [OPENAI_SURE, 'openai', 'OpenAI key'],
    [ANTHROPIC, 'anthropic', 'Anthropic key'],
    [OPENROUTER, 'openrouter', 'OpenRouter key'],
    [GOOGLE, 'gemini', 'Gemini key'],
  ])('a sure %s is placed and checked at once', async (key, provider, chip) => {
    const release = holdPut();
    renderConnect('column');
    openFold('any');
    await paste(any(), key);
    expect(puts).toEqual([{ provider, apiKey: key }]);
    await release(json({ error: 'unreachable' }, 502));
    expect(screen.getByTestId('connect-detected')).toHaveTextContent(chip);
    // Asked about in the fold itself: the region line says nothing about "below".
    expect(screen.queryByTestId('connect-chooser')).toBeNull();
  });

  it('a typed key, however sure, waits for Connect', async () => {
    putReply = works();
    renderConnect('column');
    openFold('any');
    type(any(), ANTHROPIC);
    expect(screen.getByTestId('connect-detected')).toHaveTextContent('Anthropic key');
    expect(puts).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(any(), { key: 'Enter' });
    });
    expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
  });

  it('a bare sk- asks which service, OpenAI preselected, and sends nothing until Connect', async () => {
    putReply = works();
    renderConnect('column');
    openFold('any');
    await paste(any(), SK_UNSURE);
    expect(puts).toEqual([]);
    const chooser = screen.getByTestId('connect-chooser');
    expect(chooser).toHaveTextContent('dsul can’t tell which service this key is for.');
    const group = within(chooser).getByRole('radiogroup');
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'OpenAI',
      'Anthropic',
      'Gemini',
      'OpenRouter',
    ]);
    const openai = within(group).getByRole('radio', { name: 'OpenAI' });
    expect(openai).toHaveAttribute('aria-checked', 'true');
    expect(openai).toHaveAttribute('tabindex', '0');
    // The arrow keys move the choice.
    openai.focus();
    fireEvent.keyDown(openai, { key: 'ArrowRight' });
    expect(within(group).getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Anthropic' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await press(screen.getByTestId('connect-any-submit'));
    expect(puts).toEqual([{ provider: 'openai', apiKey: SK_UNSURE }]);
  });

  it('a key nothing places: no choice made for it, and Connect asks for one', async () => {
    renderConnect('column');
    openFold('any');
    await paste(any(), UNKNOWN);
    const radios = within(screen.getByTestId('connect-chooser')).getAllByRole('radio');
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    const submit = screen.getByTestId('connect-any-submit');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit).not.toBeDisabled();
    expect(puts).toEqual([]);
  });

  it('a paste the prefix can’t place says so in the live region; typing never does', async () => {
    const release = holdPut();
    renderConnect('column');
    openFold('any');
    type(any(), SK_UNSURE);
    expect(screen.getByTestId('connect-chooser')).toBeInTheDocument();
    expect(status()).toBeEmptyDOMElement();
    await paste(any(), UNKNOWN);
    expect(status()).toHaveTextContent('dsul can’t tell which service this key is for.');
    // A change to the box clears it, and so does a check that starts.
    type(any(), `${UNKNOWN}x`);
    expect(status()).toBeEmptyDOMElement();
    await paste(any(), UNKNOWN);
    expect(status()).toHaveTextContent('dsul can’t tell which service this key is for.');
    fireEvent.click(within(screen.getByTestId('connect-chooser')).getByRole('radio', { name: 'OpenAI' }));
    await press(screen.getByTestId('connect-any-submit'));
    expect(status()).toHaveTextContent('Checking your key with OpenAI…');
    await release(json({ error: 'unreachable' }, 502));
    expect(status()).toBeEmptyDOMElement();
  });

  it('the chooser holds still while its key is out, so the answer and Check again are about what was sent', async () => {
    const release = holdPut();
    renderConnect('column');
    openFold('any');
    await paste(any(), UNKNOWN);
    const group = within(screen.getByTestId('connect-chooser')).getByRole('radiogroup');
    const radio = (name: string) => within(group).getByRole('radio', { name });
    fireEvent.click(radio('OpenAI'));
    expect(group).not.toHaveAttribute('aria-disabled');
    await press(screen.getByTestId('connect-any-submit'));
    expect(puts.map((p) => p.provider)).toEqual(['openai']);

    // Neither a click nor the arrow keys move it, and it stays focusable.
    expect(group).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(radio('Gemini'));
    expect(radio('Gemini')).toHaveAttribute('aria-checked', 'false');
    radio('OpenAI').focus();
    fireEvent.keyDown(radio('OpenAI'), { key: 'ArrowRight' });
    expect(radio('OpenAI')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Anthropic')).toHaveAttribute('aria-checked', 'false');
    expect(radio('OpenAI')).not.toBeDisabled();
    expect(document.activeElement).toBe(radio('OpenAI'));

    await release(json({ error: 'unreachable' }, 502));
    expect(group).not.toHaveAttribute('aria-disabled');
    expect(within(note()).getByRole('alert')).toHaveTextContent('OpenAI couldn’t answer the test question just now.');
    expect(radio('OpenAI')).toHaveAttribute('aria-checked', 'true');
    // Free again once the answer is in: a new choice forgets it.
    fireEvent.click(radio('Gemini'));
    expect(radio('Gemini')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('connect-note')).toBeNull();
  });

  it('a region refusal in the fold points at another key, here', async () => {
    putReply = () => json({ error: 'region' }, 403);
    renderConnect('column');
    openFold('any');
    await paste(any(), OPENAI_SURE);
    expect(within(note()).getByRole('alert')).toHaveTextContent(
      'OpenAI won’t answer from where dsul’s server is right now. A key from another service works instead.'
    );
  });

  describe('another service', () => {
    it('asks for an address, an optional model and a key, and only Connect sends them', async () => {
      putReply = works({ provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' });
      renderConnect('column');
      openFold('any');
      const toggle = screen.getByTestId('connect-custom-toggle');
      expect(toggle).toHaveTextContent('Another serviceYour own address, if it speaks the OpenAI API and is on the internet.');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const submit = screen.getByTestId('connect-custom-submit');
      expect(submit).toHaveAttribute('aria-disabled', 'true');
      // Its keys have no prefix to go by: a paste never checks.
      await paste(box('connect-custom-key'), SK_UNSURE);
      expect(puts).toEqual([]);
      expect(submit).toHaveAttribute('aria-disabled', 'true');
      type(screen.getByTestId('connect-base-url'), ' https://api.groq.com/openai/v1 ');
      type(screen.getByTestId('connect-model-name'), 'llama 3');
      expect(screen.getByText('Model names can’t contain spaces.')).toBeInTheDocument();
      expect(submit).toHaveAttribute('aria-disabled', 'true');
      type(screen.getByTestId('connect-model-name'), 'llama-3.1-8b-instant');
      expect(submit).not.toHaveAttribute('aria-disabled');
      await press(submit);
      expect(puts).toEqual([
        {
          provider: 'custom',
          apiKey: SK_UNSURE,
          baseUrl: 'https://api.groq.com/openai/v1',
          model: 'llama-3.1-8b-instant',
        },
      ]);
    });

    it('holds the address and model still while the key is out: read-only and busy, never disabled', async () => {
      const release = holdPut();
      renderConnect('column');
      openFold('any');
      fireEvent.click(screen.getByTestId('connect-custom-toggle'));
      const url = screen.getByTestId('connect-base-url');
      const model = screen.getByTestId('connect-model-name');
      type(url, 'https://llm.example.com/v1');
      type(box('connect-custom-key'), UNKNOWN);
      expect(url).not.toHaveAttribute('readonly');
      await press(screen.getByTestId('connect-custom-submit'));
      expect(puts).toEqual([{ provider: 'custom', apiKey: UNKNOWN, baseUrl: 'https://llm.example.com/v1' }]);
      for (const field of [url, model]) {
        expect(field).toHaveAttribute('readonly');
        expect(field).toHaveAttribute('aria-busy', 'true');
        expect(field).not.toBeDisabled();
      }
      await release(json({ error: 'key_rejected' }, 400));
      for (const field of [url, model]) {
        expect(field).not.toHaveAttribute('readonly');
        expect(field).not.toHaveAttribute('aria-busy');
      }
    });

    it('names a refusal by its host', async () => {
      putReply = () => json({ error: 'key_rejected' }, 400);
      renderConnect('column');
      openFold('any');
      fireEvent.click(screen.getByTestId('connect-custom-toggle'));
      type(screen.getByTestId('connect-base-url'), 'https://llm.example.com/v1');
      type(box('connect-custom-key'), UNKNOWN);
      await press(screen.getByTestId('connect-custom-submit'));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'llm.example.com didn’t accept that key. Check that you copied all of it.'
      );
      expect(screen.getByRole('alert').textContent).not.toMatch(/\bOther\b/);
    });
  });
});

/* ── Good to know ───────────────────────────────────────────────────────── */

describe('good to know', () => {
  it('cost, what is sent, the key and taking it back, at body size', () => {
    renderConnect('column');
    const good = screen.getByTestId('connect-good-to-know');
    expect(within(good).getByRole('heading', { name: 'Good to know' })).toBeInTheDocument();
    expect(good).toHaveTextContent(
      'Cost. Google’s free key costs nothing. It has a daily limit, and AI pauses until Google resets it. dsul never charges for AI.'
    );
    expect(good).toHaveTextContent(
      'What’s sent. Only when you ask: your question and the parts of your plan it needs, from dsul’s server to Google. On the free plan, Google may use it to improve its products.'
    );
    expect(good).toHaveTextContent('Your key. Stored encrypted on dsul’s server and never shown again, not even to you.');
    expect(good).toHaveTextContent('Taking it back. Disconnect any time in Settings → AI, and dsul deletes the key.');
    expect(within(good).getByRole('link', { name: 'Settings → AI' })).toHaveAttribute('href', '/settings/ai');
    // Never fine print.
    for (const li of Array.from(good.querySelectorAll('li'))) expect(li.className).toMatch(/text-\[13px\]/);
  });
});

describe('good to know, exported', () => {
  it('is the same section on its own, for either host', () => {
    render(<GoodToKnow host="pane" />);
    const good = screen.getByTestId('connect-good-to-know');
    expect(within(good).getByRole('heading', { name: 'Good to know' })).toBeInTheDocument();
    expect(good).toHaveTextContent('Taking it back. Disconnect here any time, and dsul deletes the key.');
    expect(within(good).queryByRole('link')).toBeNull();
  });
});

describe('good to know, once connected', () => {
  const KEY =
    'Stored encrypted on dsul’s server and never shown again, not even here. The web and the desktop app share this one connection.';
  const sent = (to: string) =>
    `Only when you ask: your question and the parts of your plan it needs, from dsul’s server to ${to}`;

  it('says each fact in the connection’s own words', () => {
    const cases: [Pick<ModelConnectionView, 'provider' | 'baseUrl'>, ReturnType<typeof goodToKnowCopy>][] = [
      [
        { provider: 'gemini', baseUrl: null },
        {
          cost: 'Google’s free key has a daily limit. If you reach it, AI pauses until Google resets it. dsul never charges for AI.',
          sent: `${sent('Google')}. On the free plan, Google may use it to improve its products.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, delete it in Google AI Studio.',
        },
      ],
      [
        { provider: 'openrouter', baseUrl: null },
        {
          cost: 'OpenRouter’s free models have a daily limit. If you reach it, AI pauses until OpenRouter resets it. Other models use the credit on your OpenRouter account. dsul never charges for AI.',
          sent: `${sent('OpenRouter')}, which passes it to the model you picked.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, revoke it with OpenRouter.',
        },
      ],
      [
        { provider: 'openai', baseUrl: null },
        {
          cost: 'OpenAI bills its API to your OpenAI account. dsul never charges for AI.',
          sent: `${sent('OpenAI')}.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, revoke it with OpenAI.',
        },
      ],
      [
        { provider: 'anthropic', baseUrl: null },
        {
          cost: 'Anthropic bills its API to your Anthropic account. dsul never charges for AI.',
          sent: `${sent('Anthropic')}.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, revoke it with Anthropic.',
        },
      ],
      [
        { provider: 'custom', baseUrl: 'https://llm.example.com/v1' },
        {
          cost: 'Your service sets its own price. dsul never charges for AI.',
          sent: `${sent('llm.example.com')}.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, revoke it where you made it.',
        },
      ],
      [
        { provider: 'custom', baseUrl: null },
        {
          cost: 'Your service sets its own price. dsul never charges for AI.',
          sent: `${sent('your service')}.`,
          key: KEY,
          back: 'Disconnect above and dsul deletes the key. To cancel the key itself, revoke it where you made it.',
        },
      ],
    ];
    for (const [model, copy] of cases) expect(goodToKnowCopy(model), `${model.provider} ${model.baseUrl}`).toEqual(copy);
  });

  it('is folded on every mount, and opens onto the four facts at body size', () => {
    const { unmount } = render(<GoodToKnowConnected model={view()} />);
    const fold = screen.getByTestId('connect-good-to-know-connected');
    const toggle = screen.getByTestId('good-to-know-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Good to know');
    expect(toggle).toHaveTextContent('Cost, what’s sent, your key, and taking it back');
    expect(screen.queryByTestId('good-to-know-body')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = screen.getByTestId('good-to-know-body');
    expect(fold).toContainElement(body);
    const copy = goodToKnowCopy({ provider: 'gemini', baseUrl: null });
    expect(Array.from(body.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      `Cost. ${copy.cost}`,
      `What’s sent. ${copy.sent}`,
      `Your key. ${copy.key}`,
      `Taking it back. ${copy.back}`,
    ]);
    for (const li of Array.from(body.querySelectorAll('li'))) expect(li.className).toMatch(/text-\[13px\]/);

    // Never remembered: a new mount is folded again.
    unmount();
    render(<GoodToKnowConnected model={view()} />);
    expect(screen.getByTestId('good-to-know-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the daily limit’s words', () => {
  it('say when AI comes back, and what raises the limit, never claiming a free key', () => {
    const cases: [Pick<ModelConnectionView, 'provider' | 'baseUrl'>, string, string, string][] = [
      [
        { provider: 'gemini', baseUrl: null },
        'Google’s daily limit on this key is used up. It resets once a day, and AI comes back by itself at 7 am.',
        'Google’s daily limit on this key is used up. It resets once a day, and AI comes back by itself once it resets.',
        'A paid Google plan raises the daily limit. dsul never charges for AI.',
      ],
      [
        { provider: 'openrouter', baseUrl: null },
        'You’ve used today’s free questions. OpenRouter resets them once a day, and AI comes back by itself at 7 am.',
        'You’ve used today’s free questions. OpenRouter resets them once a day, and AI comes back by itself once it resets.',
        'Credit on your OpenRouter account raises the daily limit. dsul never charges for AI.',
      ],
      [
        { provider: 'openai', baseUrl: null },
        'Today’s limit with OpenAI is used up, and AI comes back by itself at 7 am.',
        'Today’s limit with OpenAI is used up, and AI comes back by itself once it resets.',
        'dsul never charges for AI.',
      ],
      [
        { provider: 'anthropic', baseUrl: null },
        'Today’s limit with Anthropic is used up, and AI comes back by itself at 7 am.',
        'Today’s limit with Anthropic is used up, and AI comes back by itself once it resets.',
        'dsul never charges for AI.',
      ],
      [
        { provider: 'custom', baseUrl: 'https://llm.example.com/v1' },
        'Today’s limit with llm.example.com is used up, and AI comes back by itself at 7 am.',
        'Today’s limit with llm.example.com is used up, and AI comes back by itself once it resets.',
        'dsul never charges for AI.',
      ],
    ];
    for (const [model, at, noTime, paid] of cases) {
      expect(limitCopy(model, '7 am'), model.provider).toEqual({ note: at, paid });
      expect(limitCopy(model, null), model.provider).toEqual({ note: noTime, paid });
    }
    // Gemini's daily limit is any per-day quota, paid keys included: no "free" there.
    expect(Object.values(limitCopy({ provider: 'gemini', baseUrl: null }, '7 am')).join(' ')).not.toMatch(/\bfree\b/i);
  });
});

/* ── A question kept from `?` ───────────────────────────────────────────── */

const KEPT = 'what should I do first';

/** The consent line, naming where the question goes. */
const consentLine = (company: string) =>
  `Connecting sends your question, and the parts of your plan it needs, from dsul’s server to ${company}.`;

/** The consent the kept question would be sent on, as the record holds it now. */
const consent = (): KeptConsent | null => readKept(SEED_USER_ID)?.consent ?? null;

/** A route that works, noting the consent as it stood when the key arrived. */
let consentAtPut: KeptConsent | null | undefined;
const worksNoting = (body: Put) => {
  consentAtPut = consent();
  return works()(body);
};

/** A click on a link, kept from navigating (jsdom has nowhere to go). */
function clickLink(link: HTMLElement) {
  link.addEventListener('click', (e) => e.preventDefault(), { once: true });
  fireEvent.click(link);
}

describe('with a question kept from ?', () => {
  beforeEach(() => {
    consentAtPut = undefined;
    expect(keepQuestion(KEPT)).toBe(true);
  });

  const card = () => screen.getByTestId('connect-key-card');
  const cardLine = () => within(card()).queryByTestId('connect-consent');
  const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  describe('the key card', () => {
    it('says it asks yours, and a sure Google paste only fills the box, under a line naming Google', async () => {
      renderConnect('column');
      expect(card()).toHaveTextContent('dsul checks it with one tiny test question, then asks yours.');
      expect(card()).not.toHaveTextContent('the moment you paste');
      expect(box()).toHaveAccessibleDescription('dsul checks it with one tiny test question, then asks yours.');
      expect(cardLine()).toBeNull();

      await paste(box(), GOOGLE);
      // Nothing sent, nothing checking: the box holds it, the steps fold.
      expect(puts).toEqual([]);
      expect(screen.queryByTestId('connect-checking')).toBeNull();
      expect(screen.getByTestId('connect-steps')).toHaveAttribute('hidden');
      expect(box().value).toBe(GOOGLE);
      expectKeyOnlyInValue();

      // The line takes the helper's place, and describes the box and the button right under it.
      const line = cardLine()!;
      expect(line).toHaveTextContent(consentLine('Google'));
      expect(card()).not.toHaveTextContent('then asks yours');
      expect(box()).toHaveAccessibleDescription(consentLine('Google'));
      const submit = screen.getByTestId('connect-submit');
      expect(submit).toHaveTextContent(/^Connect and ask$/);
      expect(submit).toHaveAccessibleDescription(consentLine('Google'));
      expect(follows(box(), line) && follows(line, submit)).toBe(true);
      // The page changed without a check: the region says where it would go.
      expect(status()).toHaveTextContent(consentLine('Google'));
      expect(consent()).toBeNull();

      // Connect and ask: the consent first, at the press, then the key, as ever.
      putReply = worksNoting;
      await press(submit);
      expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
      expect(consentAtPut).toEqual({ provider: 'gemini', baseUrl: null, at: expect.any(Number) });
      // Kept still: the watcher asks it once the gate lights (lib/ask-pending.ts).
      expect(readKept(SEED_USER_ID)?.text).toBe(KEPT);
    });

    it('Enter is Connect and ask; an empty box sends and stamps nothing', async () => {
      putReply = worksNoting;
      renderConnect('column');
      fireEvent.keyDown(box(), { key: 'Enter' });
      expect(consent()).toBeNull();
      type(box(), GOOGLE);
      expect(screen.getByTestId('connect-submit')).toHaveTextContent('Connect and ask');
      await act(async () => {
        fireEvent.keyDown(box(), { key: 'Enter' });
      });
      expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
      expect(consentAtPut?.provider).toBe('gemini');
    });

    it('Paste reads the clipboard and checks nothing, even a sure key', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => GOOGLE) }, configurable: true });
      renderConnect('column');
      await press(screen.getByTestId('connect-key-paste'));
      expect(puts).toEqual([]);
      expect(screen.getByTestId('connect-submit')).toHaveTextContent('Connect and ask');
      expect(document.activeElement).toBe(box());
    });

    it('a refusal keeps the line, above the note whose Check again it describes and stamps', async () => {
      putReply = () => json({ error: 'unreachable' }, 502);
      renderConnect('column');
      await paste(box(), GOOGLE);
      await press(screen.getByTestId('connect-submit'));
      expect(note()).toHaveAttribute('data-code', 'unreachable');
      // The note's Check again stands in for the button, and the line stays, above it.
      expect(screen.queryByTestId('connect-submit')).toBeNull();
      const line = cardLine()!;
      expect(line).toHaveTextContent(consentLine('Google'));
      expect(follows(line, note())).toBe(true);
      const again = within(note()).getByRole('button', { name: 'Check again' });
      expect(again).toHaveAccessibleDescription(consentLine('Google'));
      expect(box()).toHaveAccessibleDescription(consentLine('Google'));

      // Kept afresh, so nothing is stamped: Check again stamps it, then resends.
      act(() => {
        keepQuestion(KEPT);
      });
      expect(consent()).toBeNull();
      putReply = worksNoting;
      await press(within(note()).getByRole('button', { name: 'Check again' }));
      expect(puts.map((p) => p.provider)).toEqual(['gemini', 'gemini']);
      expect(consentAtPut?.provider).toBe('gemini');
    });

    it('another company’s key: Use it with that company only points Connect and ask at it', async () => {
      putReply = worksNoting;
      renderConnect('column');
      await paste(box(), ANTHROPIC);
      expect(note()).toHaveAttribute('data-note', 'wrong');
      // Its actions send nothing now, so no line stands over them.
      expect(cardLine()).toBeNull();
      expect(screen.queryByTestId('connect-submit')).toBeNull();

      await press(within(note()).getByRole('button', { name: 'Use it with Anthropic' }));
      expect(puts).toEqual([]);
      expect(consent()).toBeNull();
      expect(screen.queryByTestId('connect-note')).toBeNull();
      expect(document.activeElement).toBe(box());
      expect(cardLine()).toHaveTextContent(consentLine('Anthropic'));
      expect(status()).toHaveTextContent(consentLine('Anthropic'));
      const submit = screen.getByTestId('connect-submit');
      expect(submit).toHaveTextContent('Connect and ask');
      expect(submit).toHaveAccessibleDescription(consentLine('Anthropic'));

      await press(submit);
      expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
      expect(consentAtPut?.provider).toBe('anthropic');
    });

    it('an edit to the box takes the aim back to Google', async () => {
      renderConnect('column');
      await paste(box(), OPENAI_SURE);
      await press(within(note()).getByRole('button', { name: 'Use it with OpenAI' }));
      expect(cardLine()).toHaveTextContent(consentLine('OpenAI'));
      type(box(), GOOGLE);
      expect(cardLine()).toHaveTextContent(consentLine('Google'));
    });

    it('the route’s own wrong_provider: Use it with OpenAI arms, and Connect and ask sends there', async () => {
      putReply = (body) => (body.provider === 'gemini' ? json({ error: 'wrong_provider', detected: 'openai' }, 400) : worksNoting(body));
      renderConnect('column');
      await paste(box(), UNKNOWN);
      await press(screen.getByTestId('connect-submit'));
      expect(note()).toHaveAttribute('data-detected', 'openai');
      await press(within(note()).getByRole('button', { name: 'Use it with OpenAI' }));
      expect(puts.map((p) => p.provider)).toEqual(['gemini']);
      expect(cardLine()).toHaveTextContent(consentLine('OpenAI'));
      await press(screen.getByTestId('connect-submit'));
      expect(puts.map((p) => p.provider)).toEqual(['gemini', 'openai']);
      expect(consentAtPut?.provider).toBe('openai');
    });

    it('Clear on YOUR QUESTION puts the card back as it was: the next sure paste checks itself', async () => {
      renderConnect('column');
      act(() => clearKept());
      expect(card()).toHaveTextContent('dsul checks it the moment you paste, with one tiny test question.');
      putReply = works();
      await paste(box(), GOOGLE);
      expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
    });
  });

  describe('“I already use…”', () => {
    const any = () => box('connect-any-key');
    const body = () => screen.getByTestId('connect-fold-any-body');
    const anyLine = () => within(body()).queryAllByTestId('connect-consent').find((el) => !el.closest('[hidden]')) ?? null;

    it('a sure key waits, the line names its company, and Connect and ask sends it there', async () => {
      putReply = worksNoting;
      renderConnect('column');
      openFold('any');
      await paste(any(), ANTHROPIC);
      expect(puts).toEqual([]);
      expect(screen.getByTestId('connect-detected')).toHaveTextContent('Anthropic key');
      expect(anyLine()).toHaveTextContent(consentLine('Anthropic'));
      expect(any()).toHaveAccessibleDescription(consentLine('Anthropic'));
      expect(status()).toHaveTextContent(consentLine('Anthropic'));
      const submit = screen.getByTestId('connect-any-submit');
      expect(submit).toHaveTextContent('Connect and ask');
      expect(submit).toHaveAccessibleDescription(consentLine('Anthropic'));
      await press(submit);
      expect(puts).toEqual([{ provider: 'anthropic', apiKey: ANTHROPIC }]);
      expect(consentAtPut?.provider).toBe('anthropic');
    });

    it('a key the prefix can’t place: the line follows the choice, and names nothing until there is one', async () => {
      renderConnect('column');
      openFold('any');
      await paste(any(), SK_UNSURE);
      expect(anyLine()).toHaveTextContent(consentLine('OpenAI'));
      fireEvent.click(within(screen.getByTestId('connect-chooser')).getByRole('radio', { name: 'Anthropic' }));
      expect(anyLine()).toHaveTextContent(consentLine('Anthropic'));

      await paste(any(), UNKNOWN);
      expect(anyLine()).toBeNull();
      expect(screen.getByTestId('connect-any-submit')).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId('connect-any-submit')).toHaveTextContent('Connect and ask');
    });

    it('Use it with X arms the fold, and a new choice takes the aim back', async () => {
      putReply = (body) =>
        body.provider === 'openai' ? json({ error: 'wrong_provider', detected: 'openrouter' }, 400) : worksNoting(body);
      renderConnect('column');
      openFold('any');
      // No prefix at all, so nothing here stops it going wherever it is aimed.
      type(any(), UNKNOWN);
      const radio = (name: string) => within(screen.getByTestId('connect-chooser')).getByRole('radio', { name });
      fireEvent.click(radio('OpenAI'));
      await press(screen.getByTestId('connect-any-submit'));
      expect(note()).toHaveAttribute('data-detected', 'openrouter');
      await press(within(note()).getByRole('button', { name: 'Use it with OpenRouter' }));
      expect(puts.map((p) => p.provider)).toEqual(['openai']);
      expect(anyLine()).toHaveTextContent(consentLine('OpenRouter'));
      expect(screen.getByTestId('connect-any-submit')).toHaveAccessibleDescription(consentLine('OpenRouter'));

      fireEvent.click(radio('Gemini'));
      expect(anyLine()).toHaveTextContent(consentLine('Google'));
      fireEvent.click(radio('OpenAI'));
      await press(screen.getByTestId('connect-any-submit'));
      await press(within(note()).getByRole('button', { name: 'Use it with OpenRouter' }));
      await press(screen.getByTestId('connect-any-submit'));
      expect(puts.map((p) => p.provider)).toEqual(['openai', 'openai', 'openrouter']);
      expect(consentAtPut?.provider).toBe('openrouter');
    });

    it('Use it with X moves the chooser to X too, so the checked company is the one the line names', async () => {
      putReply = (body) =>
        body.provider === 'openai' ? json({ error: 'wrong_provider', detected: 'openrouter' }, 400) : worksNoting(body);
      renderConnect('column');
      openFold('any');
      const chooser = () => within(screen.getByTestId('connect-chooser'));
      const checked = () =>
        chooser()
          .getAllByRole('radio')
          .filter((r) => r.getAttribute('aria-checked') === 'true')
          .map((r) => r.getAttribute('data-provider'));

      // A bare `sk-` chosen as Anthropic's: the card's own mismatch offers OpenAI.
      await paste(any(), SK_UNSURE);
      fireEvent.click(chooser().getByRole('radio', { name: 'Anthropic' }));
      await press(screen.getByTestId('connect-any-submit'));
      expect(puts).toEqual([]);
      await press(within(note()).getByRole('button', { name: 'Use it with OpenAI' }));
      expect(anyLine()).toHaveTextContent(consentLine('OpenAI'));
      expect(checked()).toEqual(['openai']);

      // A key no prefix places, chosen as OpenAI's: the route says OpenRouter.
      type(any(), UNKNOWN);
      fireEvent.click(chooser().getByRole('radio', { name: 'OpenAI' }));
      await press(screen.getByTestId('connect-any-submit'));
      expect(note()).toHaveAttribute('data-detected', 'openrouter');
      await press(within(note()).getByRole('button', { name: 'Use it with OpenRouter' }));
      expect(anyLine()).toHaveTextContent(consentLine('OpenRouter'));
      expect(checked()).toEqual(['openrouter']);
      await press(screen.getByTestId('connect-any-submit'));
      expect(puts.map((p) => p.provider)).toEqual(['openai', 'openrouter']);
      expect(consentAtPut?.provider).toBe('openrouter');
    });

    it('a refusal keeps the line, above the note whose Check again it describes and stamps', async () => {
      putReply = () => json({ error: 'unreachable' }, 502);
      renderConnect('column');
      openFold('any');
      await paste(any(), ANTHROPIC);
      await press(screen.getByTestId('connect-any-submit'));
      expect(note()).toHaveAttribute('data-code', 'unreachable');
      expect(screen.queryByTestId('connect-any-submit')).toBeNull();
      const line = anyLine()!;
      expect(line).toHaveTextContent(consentLine('Anthropic'));
      expect(follows(line, note())).toBe(true);
      const again = within(note()).getByRole('button', { name: 'Check again' });
      expect(again).toHaveAccessibleDescription(consentLine('Anthropic'));

      // Kept afresh, so nothing is stamped: Check again stamps it, then resends.
      act(() => {
        keepQuestion(KEPT);
      });
      expect(consent()).toBeNull();
      putReply = worksNoting;
      await press(within(note()).getByRole('button', { name: 'Check again' }));
      expect(puts.map((p) => p.provider)).toEqual(['anthropic', 'anthropic']);
      expect(consentAtPut?.provider).toBe('anthropic');
    });

    describe('another service', () => {
      const custom = () =>
        document.getElementById(screen.getByTestId('connect-custom-toggle').getAttribute('aria-controls')!) as HTMLElement;
      const customLine = () => within(custom()).queryByTestId('connect-consent');
      const openCustom = () => {
        openFold('any');
        fireEvent.click(screen.getByTestId('connect-custom-toggle'));
      };

      it('names its host, once there is something to send', async () => {
        putReply = worksNoting;
        renderConnect('column');
        openCustom();
        type(box('connect-custom-key'), UNKNOWN);
        expect(customLine()).toBeNull();
        expect(screen.getByTestId('connect-custom-submit')).toHaveTextContent('Connect and ask');
        type(screen.getByTestId('connect-base-url'), 'https://llm.example.com/v1');
        expect(customLine()).toHaveTextContent(consentLine('llm.example.com'));
        expect(box('connect-custom-key')).toHaveAccessibleDescription(consentLine('llm.example.com'));
        expect(screen.getByTestId('connect-custom-submit')).toHaveAccessibleDescription(consentLine('llm.example.com'));
        await press(screen.getByTestId('connect-custom-submit'));
        expect(puts).toEqual([{ provider: 'custom', apiKey: UNKNOWN, baseUrl: 'https://llm.example.com/v1' }]);
        expect(consentAtPut).toEqual({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', at: expect.any(Number) });
      });

      it('a refusal keeps the host line, above the note whose Check again it describes and stamps', async () => {
        putReply = () => json({ error: 'unreachable' }, 502);
        renderConnect('column');
        openCustom();
        type(screen.getByTestId('connect-base-url'), 'https://llm.example.com/v1');
        type(box('connect-custom-key'), UNKNOWN);
        await press(screen.getByTestId('connect-custom-submit'));
        expect(note()).toHaveAttribute('data-code', 'unreachable');
        const line = customLine()!;
        expect(line).toHaveTextContent(consentLine('llm.example.com'));
        expect(follows(line, note())).toBe(true);
        const again = within(note()).getByRole('button', { name: 'Check again' });
        expect(again).toHaveAccessibleDescription(consentLine('llm.example.com'));

        act(() => {
          keepQuestion(KEPT);
        });
        expect(consent()).toBeNull();
        putReply = worksNoting;
        await press(within(note()).getByRole('button', { name: 'Check again' }));
        expect(puts.map((p) => p.provider)).toEqual(['custom', 'custom']);
        expect(puts.at(-1)).toEqual({ provider: 'custom', apiKey: UNKNOWN, baseUrl: 'https://llm.example.com/v1' });
        expect(consentAtPut).toEqual({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', at: expect.any(Number) });
      });

      it('Use it with X sends to X without the address; an edit to the address takes the aim back', async () => {
        putReply = (body) =>
          body.provider === 'custom' ? json({ error: 'wrong_provider', detected: 'anthropic' }, 400) : worksNoting(body);
        renderConnect('column');
        openCustom();
        type(screen.getByTestId('connect-base-url'), 'https://llm.example.com/v1');
        type(box('connect-custom-key'), ANTHROPIC);
        await press(screen.getByTestId('connect-custom-submit'));
        await press(within(note()).getByRole('button', { name: 'Use it with Anthropic' }));
        expect(puts).toHaveLength(1);
        expect(customLine()).toHaveTextContent(consentLine('Anthropic'));
        expect(screen.getByTestId('connect-custom-submit')).not.toHaveAttribute('aria-disabled');

        type(screen.getByTestId('connect-base-url'), 'https://llm.example.org/v1');
        expect(customLine()).toHaveTextContent(consentLine('llm.example.org'));
        type(screen.getByTestId('connect-base-url'), 'https://llm.example.com/v1');
        await press(screen.getByTestId('connect-custom-submit'));
        await press(within(note()).getByRole('button', { name: 'Use it with Anthropic' }));
        await press(screen.getByTestId('connect-custom-submit'));
        expect(puts.at(-1)).toEqual({ provider: 'anthropic', apiKey: ANTHROPIC });
        expect(consentAtPut).toEqual({ provider: 'anthropic', baseUrl: null, at: expect.any(Number) });
      });
    });
  });

  describe('the OpenRouter sign-in', () => {
    const orBody = () => screen.getByTestId('connect-fold-openrouter-body');

    it('on the web: the line sits above the sign-in, which it describes, and the press stamps OpenRouter', () => {
      renderConnect('column');
      openFold('openrouter');
      const line = within(orBody()).getByTestId('connect-consent');
      const link = screen.getByTestId('connect-openrouter-signin');
      expect(line).toHaveTextContent(consentLine('OpenRouter'));
      expect(link).toHaveAccessibleDescription(consentLine('OpenRouter'));
      // Above the button; the line about where it goes stays under it.
      const help = within(orBody()).getByText('OpenRouter opens in this tab and sends you back to this column.');
      expect(follows(line, link) && follows(link, help)).toBe(true);
      clickLink(link);
      expect(consent()).toEqual({ provider: 'openrouter', baseUrl: null, at: expect.any(Number) });
    });

    it('in the desktop app: the line sits above Copy the link, and the copy stamps OpenRouter', async () => {
      (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderConnect('column');
      openFold('openrouter');
      const line = within(orBody()).getByTestId('connect-consent');
      const copy = screen.getByTestId('connect-copy-link');
      expect(line).toHaveTextContent(consentLine('OpenRouter'));
      expect(copy).toHaveAccessibleDescription(consentLine('OpenRouter'));
      expect(follows(screen.getByTestId('connect-openrouter-desktop'), line) && follows(line, copy)).toBe(true);
      await press(copy);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(consent()?.provider).toBe('openrouter');
    });
  });

  it('the pane ignores it: a sure paste checks at once, and no line, no stamp, no "and ask"', async () => {
    putReply = worksNoting;
    renderConnect('pane');
    expect(screen.getByTestId('connect-key-card')).toHaveTextContent(
      'dsul checks it the moment you paste, with one tiny test question.'
    );
    clickLink(screen.getByTestId('connect-openrouter-signin'));
    expect(screen.getByTestId('connect-openrouter-signin')).not.toHaveAttribute('aria-describedby');
    expect(consent()).toBeNull();
    await paste(box(), GOOGLE);
    expect(puts).toEqual([{ provider: 'gemini', apiKey: GOOGLE }]);
    expect(consentAtPut).toBeNull();
    expect(screen.queryAllByTestId('connect-consent')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/and ask|asks yours/);
  });

  it('nothing lime in the column, with the line and Connect and ask up', async () => {
    renderConnect('column');
    await paste(box(), GOOGLE);
    expect(screen.getByTestId('connect-submit')).toHaveTextContent('Connect and ask');
    expect(document.querySelectorAll('[data-ask-setup] [class*="bg-primary"], [data-ask-setup] [data-slot="button-key"]')).toHaveLength(0);
    openFold('openrouter');
    expect(document.querySelectorAll('[data-ask-setup] [class*="bg-primary"], [data-ask-setup] [data-slot="button-key"]')).toHaveLength(0);
  });
});

/* ── The phone's page ───────────────────────────────────────────────────── */

describe('layout phone', () => {
  const renderPhone = (afterFolds?: ReactNode) =>
    render(
      <div data-setup-tab="invite">
        <ConnectAI host="column" layout="phone" afterFolds={afterFolds} />
      </div>
    );

  it('a key that works pops the phone’s stack home, not the desktop’s, and says "It works."', async () => {
    act(() => {
      useRailStore.getState().push('phone', { kind: 'history' });
      useRailStore.getState().push('desktop', { kind: 'history' });
    });
    putReply = works({}, { freeTier: true });
    renderPhone();
    expect(screen.getByTestId('connect-ai')).toHaveAttribute('data-layout', 'phone');
    await paste(box(), GOOGLE);
    expect(useRailStore.getState().stacks.phone).toEqual([]);
    expect(useRailStore.getState().stacks.desktop).toEqual([{ kind: 'history' }]);
    expect(useAIConnectionStore.getState().justConnected).toMatchObject({ provider: 'gemini', freeTier: true });
  });

  it('the OpenRouter sign-in comes back here, to the tab, home', () => {
    renderPhone();
    expect(screen.getByTestId('connect-openrouter-signin')).toHaveAttribute('href', '/api/ai/openrouter/start?r=home');
    expect(screen.getByTestId('connect-fold-openrouter-body')).toHaveTextContent(
      'OpenRouter opens in this tab and sends you back here.'
    );
    expect(screen.getByTestId('connect-fold-openrouter-body')).not.toHaveTextContent('column');
  });

  it('puts what it is given between the folds and Good to know', () => {
    renderPhone(<p data-testid="after-folds">Previews</p>);
    const after = screen.getByTestId('after-folds');
    const folds = screen.getByTestId('connect-folds');
    const good = screen.getByTestId('connect-good-to-know');
    expect(folds.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(after.compareDocumentPosition(good) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('connect-good-to-know')).toHaveLength(1);
  });
});

/* ── The column's rules, and the files' ─────────────────────────────────── */

describe('nothing lime in the column', () => {
  const lime = () => Array.from(document.querySelectorAll('[data-ask-setup] [class*="bg-primary"], [data-ask-setup] [data-slot="button-key"]'));

  it('whatever is open or said', async () => {
    putReply = () => json({ error: 'unreachable' }, 502);
    renderConnect('column');
    expect(lime()).toEqual([]);
    await paste(box(), GOOGLE);
    expect(within(note()).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(lime()).toEqual([]);
    openFold('openrouter');
    expect(lime()).toEqual([]);
    openFold('any');
    fireEvent.click(screen.getByTestId('connect-custom-toggle'));
    await paste(box('connect-any-key'), SK_UNSURE);
    expect(lime()).toEqual([]);
  });

  it('while the pane keeps its main action’s fill (the check would see one)', async () => {
    renderConnect('pane');
    await paste(box(), UNKNOWN);
    expect(screen.getByTestId('connect-submit').className).toMatch(/bg-foreground/);
    expect(screen.getByTestId('connect-openrouter-signin').className).toMatch(/bg-foreground/);
  });
});

describe('the connect files', () => {
  const dir = join(process.cwd(), 'components/ai/connect');
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));

  it('include every one this check was written for', () => {
    expect(files).toEqual(
      expect.arrayContaining(['connect-ai.tsx', 'connect-fix.tsx', 'connect-shared.ts', 'key-check.tsx', 'key-field.tsx'])
    );
  });

  // Whole files, comments and all: a string-picking regex misses JSX text set
  // on its own line, which is most of this copy.
  it.each(files)('%s has no em dashes, never names the AI, and says Ctrl, not ⌘', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    expect(src).not.toMatch(/—/);
    expect(src).not.toMatch(/\bBeacon\b/);
    expect(src).not.toMatch(/⌘/);
  });
});
