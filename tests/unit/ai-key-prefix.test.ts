// @vitest-environment node
/**
 * lib/ai-key-prefix.ts: which company a pasted key belongs to.
 *
 * Two surfaces read this: the paste box, which checks a key it is sure about
 * at once, and the connect route, which refuses to send a key to a company it
 * was not made for. The sentinels below stand in for real keys, and the whole
 * point of the module is that no part of one comes back out, so every
 * assertion here is a provider id or a boolean.
 */

import { describe, expect, it } from 'vitest';
import {
  API_KEY_RE,
  detectKeyProvider,
  isPlausibleKey,
  isSureKey,
  mismatchedKey,
  type DetectedProvider,
} from '@/lib/ai-key-prefix';

/** Long enough to be plausible, obviously not a key. */
const body = 'SENTINEL-0000000000000000';

describe('detectKeyProvider', () => {
  it.each([
    [`sk-ant-api03-${body}`, 'anthropic'],
    [`sk-or-v1-${body}`, 'openrouter'],
    [`sk-${body}`, 'openai'],
    [`sk-proj-${body}`, 'openai'],
    [`sk-svcacct-${body}`, 'openai'],
    [`AIza${body}`, 'gemini'],
    [`AQ.${body}`, 'gemini'],
  ] as [string, DetectedProvider][])('places %s', (key, provider) => {
    expect(detectKeyProvider(key)).toBe(provider);
  });

  it('reads the longer prefixes first, so a `sk-` company is not read as OpenAI', () => {
    // Both also start `sk-`; order in the table is what keeps them apart.
    expect(detectKeyProvider(`sk-ant-${body}`)).toBe('anthropic');
    expect(detectKeyProvider(`sk-or-${body}`)).toBe('openrouter');
  });

  it('trims surrounding whitespace, the way a paste arrives', () => {
    expect(detectKeyProvider(`  sk-ant-${body}\n`)).toBe('anthropic');
    expect(detectKeyProvider(`\tAIza${body} `)).toBe('gemini');
  });

  it('is case-sensitive: a lookalike in the wrong case is nobody\'s', () => {
    expect(detectKeyProvider(`aiza${body}`)).toBeNull();
    expect(detectKeyProvider(`SK-ANT-${body}`)).toBeNull();
    expect(detectKeyProvider(`aq.${body}`)).toBeNull();
  });

  it('a bare prefix with nothing after it is not that company\'s key', () => {
    for (const p of ['sk-', 'AIza', 'AQ.']) expect(detectKeyProvider(p)).toBeNull();
    // A bare `sk-ant-` or `sk-or-` falls through to the `sk-` row, since
    // nothing follows the longer prefix. Both are under the 8 characters
    // isPlausibleKey asks for, so no route or paste box ever sees one.
    expect(isPlausibleKey('sk-ant-')).toBe(false);
    expect(isPlausibleKey('sk-or-')).toBe(false);
    // One character is enough to place it.
    expect(detectKeyProvider('sk-a')).toBe('openai');
    expect(detectKeyProvider('sk-ant-a')).toBe('anthropic');
    expect(detectKeyProvider('sk-or-a')).toBe('openrouter');
  });

  it('a shape nobody issues returns null, and so does anything but a string', () => {
    for (const key of ['', '   ', `gsk_${body}`, `pk-${body}`, body, `xai-${body}`]) {
      expect(detectKeyProvider(key)).toBeNull();
    }
    for (const junk of [null, undefined, 42, {}, [`sk-${body}`]]) {
      expect(detectKeyProvider(junk as unknown as string)).toBeNull();
    }
  });
});

describe('isSureKey', () => {
  it('is true only for a form one company alone issues', () => {
    for (const key of [
      `sk-ant-api03-${body}`,
      `sk-or-v1-${body}`,
      `AIza${body}`,
      `AQ.${body}`,
      `sk-proj-${body}`,
      `sk-svcacct-${body}`,
      `sk-admin-${body}`,
    ]) {
      expect(isSureKey(key)).toBe(true);
    }
  });

  it('a bare `sk-` is a guess, unless it carries OpenAI\'s own marker', () => {
    // DeepSeek, Moonshot and others issue `sk-` keys too.
    expect(isSureKey(`sk-${body}`)).toBe(false);
    expect(isSureKey(`sk-${body}T3BlbkFJ${body}`)).toBe(true);
    // The marker alone, with no `sk-`, says nothing.
    expect(isSureKey(`T3BlbkFJ${body}`)).toBe(false);
  });

  it('is false for anything unplaceable, and trims first', () => {
    expect(isSureKey(`gsk_${body}`)).toBe(false);
    expect(isSureKey('')).toBe(false);
    expect(isSureKey(`  sk-ant-${body}  `)).toBe(true);
  });
});

describe('mismatchedKey', () => {
  it('names the company a key was detected for, when it is not the one it is going to', () => {
    expect(mismatchedKey('openai', `sk-ant-${body}`)).toBe('anthropic');
    expect(mismatchedKey('anthropic', `sk-or-${body}`)).toBe('openrouter');
    expect(mismatchedKey('gemini', `sk-${body}`)).toBe('openai');
    expect(mismatchedKey('openrouter', `AIza${body}`)).toBe('gemini');
  });

  it('is null for a match, and for a key nothing recognises', () => {
    expect(mismatchedKey('anthropic', `sk-ant-${body}`)).toBeNull();
    expect(mismatchedKey('gemini', `AQ.${body}`)).toBeNull();
    expect(mismatchedKey('openai', `sk-proj-${body}`)).toBeNull();
    expect(mismatchedKey('openai', `gsk_${body}`)).toBeNull();
  });

  it('never fires for another service: such a host may issue any shape, `sk-` included', () => {
    for (const key of [`sk-ant-${body}`, `AIza${body}`, `sk-${body}`, `gsk_${body}`]) {
      expect(mismatchedKey('custom', key)).toBeNull();
    }
  });
});

describe('API_KEY_RE / isPlausibleKey', () => {
  it('takes printable ASCII, 8 to 512 characters', () => {
    expect(isPlausibleKey('a'.repeat(8))).toBe(true);
    expect(isPlausibleKey('a'.repeat(512))).toBe(true);
    expect(isPlausibleKey('a'.repeat(7))).toBe(false);
    expect(isPlausibleKey('a'.repeat(513))).toBe(false);
  });

  it('refuses spaces, control characters and anything outside ASCII', () => {
    expect(isPlausibleKey('sk-with space')).toBe(false);
    expect(isPlausibleKey('sk-tab\there')).toBe(false);
    expect(isPlausibleKey('sk-newline\nhere')).toBe(false);
    expect(isPlausibleKey('sk-null\u0000here')).toBe(false);
    expect(isPlausibleKey('sk-café-latte')).toBe(false);
    expect(isPlausibleKey('sk-emoji-\u{1f511}')).toBe(false);
  });

  it('trims before judging, and refuses anything but a string', () => {
    expect(isPlausibleKey(`  sk-ant-${body}\n`)).toBe(true);
    for (const junk of [null, undefined, 0, {}]) expect(isPlausibleKey(junk as unknown as string)).toBe(false);
  });

  it('is anchored at both ends', () => {
    expect(API_KEY_RE.test(`sk-${body}\nsk-second`)).toBe(false);
    expect(API_KEY_RE.test(`sk-${body}`)).toBe(true);
  });
});
