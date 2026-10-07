import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  ACCOUNT_COPY,
  accountLine,
  confirms,
  consequenceLines,
  doneMessage,
  joinNames,
} from '@/lib/account-copy';
import { ACCOUNT_CONFIRM_WORD, type AccountFacts, type AppleRevocation } from '@/lib/account-types';

/**
 * The words of Delete account (lib/account-copy.ts), and the copy fixture the
 * phone reads.
 *
 * Every word is spelled out below, so a change to one is a change to this file
 * too, made on purpose. The phone's words and the rules' tables are written to
 * tests/fixtures/app/account-copy.json, which DsulCore's AccountTests.swift
 * compares with its own constants and rules: a word changed here and not in
 * Account.swift turns CI red there. Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/account-copy.test.ts
 *
 * and commit the JSON with the Swift change. Never hand-edit it. The tables
 * are the phone's (`web: false`); the web's two Apple variants are asserted
 * here only.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/app/account-copy.json');
// The confirms table's space cases are invisible as written, so they are
// escaped in the file; JSON.parse on either side reads the same characters.
const INVISIBLE = /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
const serialize = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) +
  '\n';

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

const NONE: AccountFacts = {
  userId: USER,
  email: null,
  appleIds: [],
  appleRevocable: false,
  beeminder: false,
  ledger: false,
  openclaw: false,
  keyServices: [],
  modelProviderName: null,
};

/** The facts fixture's body (tests/fixtures/app/account-facts.json). */
const EXAMPLE: AccountFacts = {
  userId: USER,
  email: 'kirby@example.com',
  appleIds: ['001234.dsul.0001'],
  appleRevocable: true,
  beeminder: true,
  ledger: true,
  openclaw: false,
  keyServices: ['Beeminder', 'Twilio'],
  modelProviderName: 'OpenAI',
};

const EVERYTHING: AccountFacts = {
  ...EXAMPLE,
  appleIds: [],
  appleRevocable: false,
  openclaw: true,
  keyServices: ['Beeminder', 'Twilio', 'Home Assistant', 'OpenClaw'],
  modelProviderName: 'llm.example.com',
};

const WORDS = {
  title: 'Delete your dsul account?',
  account: 'This deletes the account for {email}.',
  lead: 'Deleting it removes everything in it from every device, right away: your items, habits, projects, routines, seasons, goals, recipes, settings and saved conversations. None of it goes to the Trash, and this cannot be undone.',
  beeminder:
    'Beeminder stops getting your ticks from dsul. A goal that needs them can derail and charge you, so change or archive those goals in Beeminder first.',
  ledger:
    "Your stakes ledger is deleted too, so note anything you owe first. It's at do.dsul.app/ledger.",
  openclaw: 'OpenClaw loses access to dsul, but keeps anything it already remembers.',
  keys: 'Keys you gave dsul for {services} stay active there until you revoke them.',
  modelKey: 'dsul deletes the key you connected, but it stays active with {name} until you revoke it there.',
  appleStep: 'Apple will ask you to continue, so that dsul is also removed from Sign in with Apple.',
  appleManual:
    "dsul can't remove itself from Sign in with Apple here. Afterwards, open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete.",
  appleManualWeb:
    "dsul can't remove itself from Sign in with Apple here. Afterwards, on an iPhone, open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete. Or sign in at account.apple.com and find Sign in with Apple under Sign-In & Security.",
  unreachable: "Couldn't reach dsul. Check your connection and try again.",
  failed: "Couldn't delete your account. Nothing was deleted. Try again.",
  changed: "You're signed in to a different account now, so nothing was deleted. Close this and open it again.",
  deleted: 'Your dsul account is deleted.',
  appleLeft:
    'Your dsul account is deleted. Apple may still list dsul under Sign in with Apple: open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete.',
  appleLeftWeb:
    'Your dsul account is deleted. Apple may still list dsul under Sign in with Apple. To remove it, on an iPhone, open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete. Or sign in at account.apple.com and find Sign in with Apple under Sign-In & Security.',
  confirmLabel: 'Type DELETE to confirm',
  deleteLabel: 'Delete account',
  deletingLabel: 'Deleting…',
  doneLabel: 'Done',
  confirmWord: 'DELETE',
};

/** Each word as the fixture carries it: a template filled with its own placeholder. */
function words(): Record<keyof typeof WORDS, string> {
  return {
    title: ACCOUNT_COPY.title,
    account: ACCOUNT_COPY.account('{email}'),
    lead: ACCOUNT_COPY.lead,
    beeminder: ACCOUNT_COPY.beeminder,
    ledger: ACCOUNT_COPY.ledger,
    openclaw: ACCOUNT_COPY.openclaw,
    keys: ACCOUNT_COPY.keys(['{services}']),
    modelKey: ACCOUNT_COPY.modelKey('{name}'),
    appleStep: ACCOUNT_COPY.appleStep,
    appleManual: ACCOUNT_COPY.appleManual,
    appleManualWeb: ACCOUNT_COPY.appleManualWeb,
    unreachable: ACCOUNT_COPY.unreachable,
    failed: ACCOUNT_COPY.failed,
    changed: ACCOUNT_COPY.changed,
    deleted: ACCOUNT_COPY.deleted,
    appleLeft: ACCOUNT_COPY.appleLeft,
    appleLeftWeb: ACCOUNT_COPY.appleLeftWeb,
    confirmLabel: ACCOUNT_COPY.confirmLabel,
    deleteLabel: ACCOUNT_COPY.deleteLabel,
    deletingLabel: ACCOUNT_COPY.deletingLabel,
    doneLabel: ACCOUNT_COPY.doneLabel,
    confirmWord: ACCOUNT_CONFIRM_WORD,
  };
}

/** Typed text, and whether it lights Delete. The space cases are JavaScript's trim set, as jsTrim's. */
const CONFIRMS: { typed: string; ok: boolean }[] = [
  { typed: 'DELETE', ok: true },
  { typed: 'delete', ok: true },
  { typed: 'Delete', ok: true },
  { typed: 'dElEtE', ok: true },
  { typed: ' Delete\n', ok: true },
  { typed: '\tDELETE  ', ok: true },
  { typed: '\u00a0delete\u3000', ok: true },
  { typed: '\ufeffDELETE\u2028', ok: true },
  { typed: '', ok: false },
  { typed: '   ', ok: false },
  { typed: 'DELET', ok: false },
  { typed: 'DELETED', ok: false },
  { typed: 'DELETE.', ok: false },
  { typed: 'DEL ETE', ok: false },
  { typed: 'delete account', ok: false },
  { typed: 'DELETE DELETE', ok: false },
  { typed: '\u200bDELETE', ok: false },
];

/** One to four names, as the keys line can have. */
const JOIN_NAMES: { names: string[]; joined: string }[] = [
  { names: ['Beeminder'], joined: 'Beeminder' },
  { names: ['Beeminder', 'Twilio'], joined: 'Beeminder and Twilio' },
  { names: ['Beeminder', 'Twilio', 'Home Assistant'], joined: 'Beeminder, Twilio and Home Assistant' },
  {
    names: ['Beeminder', 'Twilio', 'Home Assistant', 'OpenClaw'],
    joined: 'Beeminder, Twilio, Home Assistant and OpenClaw',
  },
];

/** The phone's table: what each set of facts shows, with and without the Apple step. */
const CONSEQUENCES: { facts: AccountFacts; appleStep: boolean; lines: string[] }[] = [
  { facts: NONE, appleStep: false, lines: [] },
  { facts: { ...NONE, email: 'kirby@example.com' }, appleStep: false, lines: [] },
  {
    facts: EXAMPLE,
    appleStep: true,
    lines: [
      WORDS.beeminder,
      WORDS.ledger,
      'Keys you gave dsul for Beeminder and Twilio stay active there until you revoke them.',
      'dsul deletes the key you connected, but it stays active with OpenAI until you revoke it there.',
      WORDS.appleStep,
    ],
  },
  {
    facts: EXAMPLE,
    appleStep: false,
    lines: [
      WORDS.beeminder,
      WORDS.ledger,
      'Keys you gave dsul for Beeminder and Twilio stay active there until you revoke them.',
      'dsul deletes the key you connected, but it stays active with OpenAI until you revoke it there.',
      WORDS.appleManual,
    ],
  },
  {
    facts: EVERYTHING,
    appleStep: false,
    lines: [
      WORDS.beeminder,
      WORDS.ledger,
      WORDS.openclaw,
      'Keys you gave dsul for Beeminder, Twilio, Home Assistant and OpenClaw stay active there until you revoke them.',
      'dsul deletes the key you connected, but it stays active with llm.example.com until you revoke it there.',
    ],
  },
  { facts: { ...NONE, beeminder: true }, appleStep: false, lines: [WORDS.beeminder] },
  { facts: { ...NONE, ledger: true }, appleStep: false, lines: [WORDS.ledger] },
  { facts: { ...NONE, openclaw: true }, appleStep: false, lines: [WORDS.openclaw] },
  {
    facts: { ...NONE, keyServices: ['Home Assistant'] },
    appleStep: false,
    lines: ['Keys you gave dsul for Home Assistant stay active there until you revoke them.'],
  },
  {
    facts: { ...NONE, modelProviderName: 'Anthropic' },
    appleStep: false,
    lines: ['dsul deletes the key you connected, but it stays active with Anthropic until you revoke it there.'],
  },
  {
    facts: { ...NONE, appleIds: ['001234.dsul.0001'], appleRevocable: true },
    appleStep: true,
    lines: [WORDS.appleStep],
  },
  { facts: { ...NONE, appleIds: ['001234.dsul.0001'] }, appleStep: false, lines: [WORDS.appleManual] },
  {
    facts: { ...NONE, appleIds: ['001234.dsul.0001'], appleRevocable: true },
    appleStep: false,
    lines: [WORDS.appleManual],
  },
];

/** The phone's done table: every answer, with and without an Apple id. */
const DONE: { apple: AppleRevocation; hadApple: boolean; message: string }[] = [
  { apple: 'revoked', hadApple: true, message: WORDS.deleted },
  { apple: 'revoked', hadApple: false, message: WORDS.deleted },
  { apple: 'not_revoked', hadApple: true, message: WORDS.appleLeft },
  { apple: 'not_revoked', hadApple: false, message: WORDS.appleLeft },
  { apple: 'none', hadApple: true, message: WORDS.deleted },
  { apple: 'none', hadApple: false, message: WORDS.deleted },
  { apple: 'unknown', hadApple: true, message: WORDS.appleLeft },
  { apple: 'unknown', hadApple: false, message: WORDS.deleted },
];

describe('the words', () => {
  it('are exactly these, template by template', () => {
    expect(words()).toEqual(WORDS);
  });

  it('fill their templates', () => {
    expect(ACCOUNT_COPY.account('a@b.c')).toBe('This deletes the account for a@b.c.');
    expect(ACCOUNT_COPY.keys(['Twilio'])).toBe('Keys you gave dsul for Twilio stay active there until you revoke them.');
    expect(ACCOUNT_COPY.modelKey('Google Gemini')).toBe(
      'dsul deletes the key you connected, but it stays active with Google Gemini until you revoke it there.',
    );
  });

  it('carry no em dash, en dash, or the retired name of the AI', () => {
    for (const [key, text] of Object.entries(words())) {
      expect(text, key).not.toMatch(/[\u2014\u2013]/);
      expect(text, key).not.toMatch(/beacon/i);
    }
  });

  it('say it cannot be undone and that nothing goes to the Trash', () => {
    expect(ACCOUNT_COPY.lead).toContain('cannot be undone');
    expect(ACCOUNT_COPY.lead).toContain('Trash');
  });

  it("give Apple's current steps: Delete, never Stop Using", () => {
    for (const text of Object.values(words())) expect(text).not.toMatch(/stop using/i);
    for (const text of [
      ACCOUNT_COPY.appleManual,
      ACCOUNT_COPY.appleManualWeb,
      ACCOUNT_COPY.appleLeft,
      ACCOUNT_COPY.appleLeftWeb,
    ]) {
      expect(text).toContain('tap Delete');
    }
    expect(ACCOUNT_COPY.appleManualWeb).toContain('account.apple.com');
    expect(ACCOUNT_COPY.appleLeftWeb).toContain('account.apple.com');
  });

  it('use straight apostrophes only, so one fixture compares TS and Swift', () => {
    for (const text of Object.values(words())) expect(text).not.toMatch(/[\u2018\u2019]/);
  });
});

describe('confirms', () => {
  it.each(CONFIRMS)('%j', ({ typed, ok }) => {
    expect(confirms(typed)).toBe(ok);
  });
});

describe('joinNames', () => {
  it.each(JOIN_NAMES)('$joined', ({ names, joined }) => {
    expect(joinNames(names)).toBe(joined);
  });

  it('is empty for none (TS only: no line asks it)', () => {
    expect(joinNames([])).toBe('');
  });
});

describe('accountLine', () => {
  it('names the account by its email, as it is', () => {
    expect(accountLine(EXAMPLE)).toBe('This deletes the account for kirby@example.com.');
    expect(accountLine({ ...NONE, email: 'x7k2@privaterelay.appleid.com' })).toBe(
      'This deletes the account for x7k2@privaterelay.appleid.com.',
    );
  });

  it('is null with no email, or a blank one', () => {
    expect(accountLine(NONE)).toBeNull();
    expect(accountLine({ ...NONE, email: '  ' })).toBeNull();
  });
});

describe('consequenceLines', () => {
  it.each(CONSEQUENCES.map((row, i) => ({ ...row, i })))('phone row $i', ({ facts, appleStep, lines }) => {
    expect(consequenceLines(facts, { appleStep, web: false })).toEqual(lines);
  });

  it('on the web, gives the web manual Apple line in the same place', () => {
    for (const { facts, appleStep, lines } of CONSEQUENCES) {
      if (appleStep) continue;
      const web = lines.map((line) => (line === WORDS.appleManual ? WORDS.appleManualWeb : line));
      expect(consequenceLines(facts, { appleStep: false, web: true })).toEqual(web);
    }
  });

  it('a blank provider name adds no model line', () => {
    expect(consequenceLines({ ...NONE, modelProviderName: ' ' }, { appleStep: false, web: false })).toEqual([]);
  });
});

describe('doneMessage', () => {
  it.each(DONE)('$apple, hadApple $hadApple', ({ apple, hadApple, message }) => {
    expect(doneMessage(apple, hadApple)).toBe(message);
    expect(doneMessage(apple, hadApple, { web: false })).toBe(message);
  });

  it.each(DONE)('on the web: $apple, hadApple $hadApple', ({ apple, hadApple, message }) => {
    const web = message === WORDS.appleLeft ? WORDS.appleLeftWeb : message;
    expect(doneMessage(apple, hadApple, { web: true })).toBe(web);
  });
});

describe('the copy fixture shared with DsulCore', () => {
  let generated: Record<string, unknown>;

  beforeAll(() => {
    // Built from the module, never from the tables' expectations: the tables
    // above check the module, and the fixture carries what it answers.
    generated = {
      words: words(),
      confirms: CONFIRMS.map(({ typed }) => ({ typed, ok: confirms(typed) })),
      joinNames: JOIN_NAMES.map(({ names }) => ({ names, joined: joinNames(names) })),
      consequences: CONSEQUENCES.map(({ facts, appleStep }) => ({
        facts,
        appleStep,
        lines: consequenceLines(facts, { appleStep, web: false }),
      })),
      done: DONE.map(({ apple, hadApple }) => ({ apple, hadApple, message: doneMessage(apple, hadApple) })),
    };
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, serialize(generated));
    }
  });

  it('the committed file exists', () => {
    expect(existsSync(FIXTURE), `missing ${FIXTURE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('the committed copy is what lib/account-copy.ts answers today', () => {
    // On drift: if the change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore (Account.swift).
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(generated);
  });
});
