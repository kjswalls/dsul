import { describe, expect, it } from 'vitest';
import {
  MOD_SURFACE_FORBIDDEN_RE,
  SECRET_SHAPED_RE,
  isSafeTypedValue,
  passesLabelRule,
  passesSurfaceRule,
  surfaceMessage,
} from '@/lib/mods/labels';
import { ModManifestSchema } from '@/lib/mods/schema';

/**
 * The surface rule (lib/mods/labels.ts, memory/plans/mods.md build order 9):
 * what a panel draws, held tighter than a ⌘K label, and what the person types
 * into a mod's field, held only to not looking like a secret.
 */

const HEX40 = 'a3f9c2e81b7d4f60a9e5c3b2d1f0e8a7c6b5d4e3';

describe('passesSurfaceRule', () => {
  it('takes ordinary planning text, line by line', () => {
    for (const s of ['3 of 8 glasses', 'Glasses today', 'Pin the recovery day', 'Run 5km\nStretch after', 'Вода', '+1']) {
      expect(passesSurfaceRule(s), s).toBe(true);
    }
  });

  it('refuses sign-in, session, model and chat words, on top of the label rule', () => {
    for (const s of [
      'Signed in as kirby',
      'Reconnect your model',
      'Enter API secret',
      'Chat',
      'Ask anything',
      'Logged out',
      'Log off',
      'Your assistant',
      'Enter your 2FA code',
      'Your OTP',
      'GPT says hi',
      'Chatbot',
      'Settings',
      'Password',
    ]) {
      expect(passesSurfaceRule(s), s).toBe(false);
    }
  });

  it('refuses secret shapes, links and mixed scripts', () => {
    for (const s of [
      'sk_live_abcdef123',
      `ghp_${'a1'.repeat(10)}`,
      'glpat-abc123',
      'xoxb-123-456',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
      HEX40,
      'sk-abcdef123456',
      'https://example.com',
      'see evil.com/x',
      'Sеttings',
      'Wаter',
    ]) {
      expect(passesSurfaceRule(s), s).toBe(false);
    }
  });

  it('checks every line, and the skeleton of each', () => {
    expect(passesSurfaceRule('Water\nSign in')).toBe(false);
    expect(passesSurfaceRule('Water\nСhat')).toBe(false);
    expect(passesSurfaceRule('ＣＨＡＴ')).toBe(false);
    expect(passesSurfaceRule('Water\tlog')).toBe(false);
  });

  it('the surface words are a superset of the label words', () => {
    expect(MOD_SURFACE_FORBIDDEN_RE.test('settings')).toBe(true);
    expect(MOD_SURFACE_FORBIDDEN_RE.test('models')).toBe(true);
    expect(MOD_SURFACE_FORBIDDEN_RE.test('rapid')).toBe(false);
    expect(MOD_SURFACE_FORBIDDEN_RE.test('task')).toBe(false);
  });
});

describe('SECRET_SHAPED_RE', () => {
  it('needs a letter and a digit in a 32-character run', () => {
    expect(SECRET_SHAPED_RE.test('a'.repeat(40))).toBe(false);
    expect(SECRET_SHAPED_RE.test('1'.repeat(40))).toBe(false);
    expect(SECRET_SHAPED_RE.test(`${'a'.repeat(30)}1`)).toBe(false);
    expect(SECRET_SHAPED_RE.test(`${'a'.repeat(31)}1`)).toBe(true);
    expect(SECRET_SHAPED_RE.test(HEX40)).toBe(true);
  });
});

describe('isSafeTypedValue', () => {
  it('takes ordinary words, the app\'s own included', () => {
    for (const s of ['chat with mom', 'ask the API team', 'call the bank', '2026-10-08', '']) {
      expect(isSafeTypedValue(s), s).toBe(true);
    }
  });

  it('refuses a key, a token and invisible characters', () => {
    for (const s of ['sk-abcdef123456', 'sk_live_abcdef123', `ghp_${'x9'.repeat(10)}`, HEX40, 'a​b']) {
      expect(isSafeTypedValue(s), s).toBe(false);
    }
  });
});

describe('surfaceMessage', () => {
  it('shows a message that passes, and hides one that does not', () => {
    expect(surfaceMessage('TypeError: x is undefined')).toBe('TypeError: x is undefined');
    expect(surfaceMessage('Sign in again to continue')).toBe('(message hidden)');
    expect(surfaceMessage(`token ${HEX40}`)).toBe('(message hidden)');
  });
});

describe('the label rule is unchanged', () => {
  it('a stored build order 8 command label using "chat" still parses', () => {
    expect(passesLabelRule('Chat log')).toBe(true);
    expect(passesLabelRule('Ask mom')).toBe(true);
    expect(
      ModManifestSchema.safeParse({ version: 1, uses: ['ui'], commands: [{ id: 'chat-log', label: 'Chat log' }] }).success
    ).toBe(true);
  });
});
