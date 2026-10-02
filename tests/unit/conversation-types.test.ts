// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  CHAT_LIMITS,
  DEFAULT_TITLE,
  ERROR_CODE_RE,
  UUID_RE,
  cleanText,
  cleanTitle,
  deriveTitle,
  isAnswerer,
  isMessageStatus,
} from '@/lib/conversation-types';
import { ProposalDraftSchema } from '@dsul/types';
import { MAX_ASSISTANT_CHARS, MAX_MESSAGE_CHARS } from '@/lib/ai-limits';

/**
 * lib/conversation-types.ts: the text every saved conversation string goes
 * through. Postgres refuses a lone surrogate in JSON (22P02) and U+0000 in
 * text (22P05), and counts char_length in code points, so `cleanText` must
 * leave nothing it would refuse and never cut a pair in half.
 */

const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const EMOJI = HIGH + LOW; // U+1F600
const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);
const CJK = String.fromCharCode(0x4e2d);
const LS = String.fromCharCode(0x2028);

/** No lone surrogate anywhere (what Postgres's JSON parser demands). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe('CHAT_LIMITS', () => {
  it('takes the two content caps from lib/ai-limits.ts', () => {
    expect(CHAT_LIMITS.userChars).toBe(MAX_MESSAGE_CHARS);
    expect(CHAT_LIMITS.userChars).toBe(8_000);
    expect(CHAT_LIMITS.assistantChars).toBe(MAX_ASSISTANT_CHARS);
    expect(CHAT_LIMITS.assistantChars).toBe(40_000);
    expect(CHAT_LIMITS).toMatchObject({
      titleChars: 200,
      autoTitleChars: 60,
      pageSize: 30,
      maxPageSize: 50,
      threadPage: 100,
      searchMin: 2,
      searchMax: 100,
      searchResults: 50,
      changesPerCall: 20,
    });
  });

  it('caps one tally at what one proposal can carry (ProposalSchema: at most 20 operations)', () => {
    const op = { kind: 'create', itemType: 'task', title: 'x' };
    const draft = (n: number) => ({ summary: 's', operations: Array.from({ length: n }, () => op) });
    expect(ProposalDraftSchema.safeParse(draft(CHAT_LIMITS.changesPerCall)).success).toBe(true);
    expect(ProposalDraftSchema.safeParse(draft(CHAT_LIMITS.changesPerCall + 1)).success).toBe(false);
  });
});

describe('the id and code shapes', () => {
  it('UUID_RE takes any-case uuids and nothing around them', () => {
    expect(UUID_RE.test('c0000000-0000-4000-8000-0000000000a1')).toBe(true);
    expect(UUID_RE.test('C0000000-0000-4000-8000-0000000000A1')).toBe(true);
    expect(UUID_RE.test(' c0000000-0000-4000-8000-0000000000a1')).toBe(false);
    expect(UUID_RE.test('c0000000-0000-4000-8000-0000000000a1,x')).toBe(false);
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
  });

  it('ERROR_CODE_RE is the CHECK: [a-z_], 1 to 32', () => {
    for (const ok of ['upstream', 'rate_limit', 'a', 'e'.repeat(32)]) expect(ERROR_CODE_RE.test(ok), ok).toBe(true);
    for (const bad of ['', 'e'.repeat(33), 'Upstream', 'bad code', 'quota-1', '429']) {
      expect(ERROR_CODE_RE.test(bad), bad).toBe(false);
    }
  });

  it('isAnswerer and isMessageStatus take exactly the stored values', () => {
    expect(['model', 'openclaw', 'gpt', null, undefined].map(isAnswerer)).toEqual([true, true, false, false, false]);
    expect(['complete', 'stopped', 'error', 'streaming', ''].map(isMessageStatus)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('cleanText', () => {
  it('leaves ordinary text alone', () => {
    const s = `Plan my day ${EMOJI} ${CJK}\nwith a newline\tand a tab`;
    expect(cleanText(s, 1000)).toBe(s);
  });

  it('turns a lone surrogate into U+FFFD and keeps a pair', () => {
    expect(cleanText(`a${HIGH}b`, 10)).toBe(`a${FFFD}b`);
    expect(cleanText(`a${LOW}b`, 10)).toBe(`a${FFFD}b`);
    expect(cleanText(`${LOW}${HIGH}`, 10)).toBe(`${FFFD}${FFFD}`);
    expect(cleanText(`x${HIGH}`, 10)).toBe(`x${FFFD}`);
    expect(cleanText(`${EMOJI}${HIGH}${EMOJI}`, 10)).toBe(`${EMOJI}${FFFD}${EMOJI}`);
  });

  it('matches String.prototype.toWellFormed where the runtime has it', () => {
    const native = (String.prototype as { toWellFormed?: () => string }).toWellFormed;
    if (typeof native !== 'function') return;
    const parts = ['a', HIGH, LOW, EMOJI, CJK, ' ', FFFD];
    let seed = 7;
    for (let n = 0; n < 500; n++) {
      let s = '';
      for (let i = 0; i < 12; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += parts[seed % parts.length];
      }
      expect(cleanText(s, 1000)).toBe(native.call(s));
    }
  });

  it('removes U+0000', () => {
    expect(cleanText(`a${NUL}b${NUL}${NUL}c`, 10)).toBe('abc');
    expect(cleanText(NUL, 10)).toBe('');
  });

  it('cuts to max code units, never ending on a high surrogate', () => {
    expect(cleanText('abcdef', 3)).toBe('abc');
    // 'a' + a pair is 3 units: a cut at 2 would split the pair, so it drops the half.
    expect(cleanText(`a${EMOJI}`, 2)).toBe('a');
    expect(cleanText(`a${EMOJI}`, 3)).toBe(`a${EMOJI}`);
    expect(cleanText(EMOJI.repeat(5), 5)).toBe(EMOJI.repeat(2));
  });

  it('a CJK-and-emoji paste past the user cap: at most 8,000 code points, well formed', () => {
    const paste = `${CJK}${EMOJI}`.repeat(4_000); // 12,000 units
    const out = cleanText(paste, CHAT_LIMITS.userChars);
    expect(out.length).toBeLessThanOrEqual(CHAT_LIMITS.userChars);
    expect([...out].length).toBeLessThanOrEqual(CHAT_LIMITS.userChars);
    expect(wellFormed(out)).toBe(true);
    // An odd cap whose cut lands mid-pair.
    const odd = cleanText(EMOJI.repeat(10), 7);
    expect(odd).toBe(EMOJI.repeat(3));
  });

  it('answers empty for anything that is not text, and for a cap of 0', () => {
    expect(cleanText(undefined as unknown as string, 10)).toBe('');
    expect(cleanText(42 as unknown as string, 10)).toBe('');
    expect(cleanText('abc', 0)).toBe('');
    expect(cleanText('abc', Number.NaN)).toBe('');
  });
});

describe('cleanTitle', () => {
  it('makes one line: whitespace and control runs become one space, trimmed', () => {
    expect(cleanTitle('  Plan\tmy\n\n day  ')).toBe('Plan my day');
    expect(cleanTitle(`a${String.fromCharCode(1)}b${String.fromCharCode(0x7f)}c${String.fromCharCode(0x85)}d`)).toBe('a b c d');
    expect(cleanTitle(`one${LS}two`)).toBe('one two');
    expect(cleanTitle(`x${NUL}y`)).toBe('x y');
  });

  it('cuts to 200 with nothing trailing, and is empty when nothing is left', () => {
    const long = `${'word '.repeat(60)}`;
    const out = cleanTitle(long);
    expect(out.length).toBeLessThanOrEqual(CHAT_LIMITS.titleChars);
    expect(out).toBe(out.trim());
    expect(cleanTitle('t'.repeat(300))).toBe('t'.repeat(200));
    expect(cleanTitle(' \n\t ')).toBe('');
    expect(cleanTitle(null as unknown as string)).toBe('');
  });

  it('never leaves a lone surrogate at the cut', () => {
    const out = cleanTitle(`${'t'.repeat(199)}${EMOJI}`);
    expect(out).toBe('t'.repeat(199));
    expect(wellFormed(out)).toBe(true);
  });
});

describe('deriveTitle', () => {
  it('takes the first line with something on it', () => {
    expect(deriveTitle('\n\n  Plan my day  \nand then some')).toBe('Plan my day');
    expect(deriveTitle('first\r\nsecond')).toBe('first');
    expect(deriveTitle(`first${LS}second`)).toBe('first');
  });

  it('drops a leading "?" (the command bar ask prefix)', () => {
    expect(deriveTitle('? what is next')).toBe('what is next');
    expect(deriveTitle('?? what is next')).toBe('what is next');
    expect(deriveTitle('?\nwhat is next')).toBe('what is next');
    expect(deriveTitle('is this a question?')).toBe('is this a question?');
  });

  it('collapses whitespace and strips control characters', () => {
    expect(deriveTitle(`plan\t\tthe${String.fromCharCode(7)}week`)).toBe('plan the week');
    expect(deriveTitle(`a${NUL}b`)).toBe('ab');
  });

  it('keeps a title of exactly 60', () => {
    const s = 'x'.repeat(60);
    expect(deriveTitle(s)).toBe(s);
  });

  it('cuts a longer line on a word boundary at 40 or later, with an ellipsis, at most 60 in all', () => {
    const s = 'Help me plan a calm week around the dentist and the move next door please';
    const out = deriveTitle(s);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(CHAT_LIMITS.autoTitleChars);
    const head = out.slice(0, -1);
    expect(s.startsWith(head)).toBe(true);
    expect(s[head.length]).toBe(' ');
    expect(head.length).toBeGreaterThanOrEqual(40);
  });

  it('cuts hard at 59 when no space falls at 40 or later', () => {
    const s = `short ${'y'.repeat(100)}`;
    const out = deriveTitle(s);
    expect(out).toBe(`${s.slice(0, 59)}…`);
    expect(out.length).toBe(60);
  });

  it('never splits a surrogate pair at the cut', () => {
    const s = `${'z'.repeat(58)}${EMOJI}${'z'.repeat(10)}`;
    const out = deriveTitle(s);
    expect(wellFormed(out)).toBe(true);
    expect(out).toBe(`${'z'.repeat(58)}…`);
  });

  it('is "New chat" when nothing is left', () => {
    for (const s of ['', '   ', '\n\n', '?', '? ?', NUL]) expect(deriveTitle(s), JSON.stringify(s)).toBe(DEFAULT_TITLE);
    expect(deriveTitle(undefined as unknown as string)).toBe('New chat');
  });

  it('always answers something the title CHECK accepts', () => {
    const inputs = ['plain', `${'long '.repeat(40)}`, `${EMOJI.repeat(70)}`, `\t${CJK.repeat(80)}`, `?${HIGH}x`];
    for (const s of inputs) {
      const out = deriveTitle(s);
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(CHAT_LIMITS.titleChars);
      expect(out.trim()).not.toBe('');
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(out)).toBe(false);
      expect(wellFormed(out)).toBe(true);
    }
  });
});
