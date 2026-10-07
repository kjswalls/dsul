/**
 * The words of Delete account, and the rules that pick which of them show
 * (memory/plans/account-deletion.md).
 *
 * One copy for both clients. The web's dialog
 * (components/settings/delete-account-dialog.tsx) and /login read this file;
 * the iPhone's sheet reads ios/DsulCore/Sources/DsulCore/Account.swift, which
 * mirrors it, and tests/unit/account-copy.test.ts writes every phone word and
 * every rule's table to tests/fixtures/app/account-copy.json, which DsulCore's
 * AccountTests compares byte for byte. A word changed here and not there turns
 * one side red.
 *
 * Straight apostrophes, so one fixture compares both. No em dash anywhere. The
 * web has two words of its own, `appleManualWeb` and `appleLeftWeb`: the web
 * never revokes Sign in with Apple, and a person at a browser may not have an
 * iPhone at hand, so its Apple lines also name account.apple.com. The phone
 * never shows them, so they stay out of the fixture's phone tables.
 *
 * Client-safe: imports nothing from the server and no Node builtin
 * (tests/unit/account-server-boundary.test.ts).
 */

import { ACCOUNT_CONFIRM_WORD, type AccountFacts, type AppleRevocation } from './account-types';

const APPLE_STEPS = 'open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete.';
const APPLE_STEPS_WEB =
  'on an iPhone, open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete. ' +
  'Or sign in at account.apple.com and find Sign in with Apple under Sign-In & Security.';
const DELETED = 'Your dsul account is deleted.';

export const ACCOUNT_COPY = {
  title: 'Delete your dsul account?',
  account: (email: string) => `This deletes the account for ${email}.`,
  lead:
    'Deleting it removes everything in it from every device, right away: your items, habits, projects, ' +
    'routines, seasons, goals, recipes, settings and saved conversations. None of it goes to the Trash, ' +
    'and this cannot be undone.',
  beeminder:
    'Beeminder stops getting your ticks from dsul. A goal that needs them can derail and charge you, ' +
    'so change or archive those goals in Beeminder first.',
  // The address, not a Settings path: Settings → Rituals → Ledger is hidden
  // while Settle the day is off (it depends on that switch), and the ledger's
  // rows outlive the switch. /ledger is always there.
  ledger: "Your stakes ledger is deleted too, so note anything you owe first. It's at do.dsul.app/ledger.",
  openclaw: 'OpenClaw loses access to dsul, but keeps anything it already remembers.',
  keys: (services: string[]) =>
    `Keys you gave dsul for ${joinNames(services)} stay active there until you revoke them.`,
  // Disconnect's words (components/settings/model-connection-panel.tsx), so
  // the two surfaces say the same thing about a key dsul no longer holds.
  modelKey: (name: string) =>
    `dsul deletes the key you connected, but it stays active with ${name} until you revoke it there.`,
  appleStep: 'Apple will ask you to continue, so that dsul is also removed from Sign in with Apple.',
  // The steps are Apple's own (support.apple.com/en-us/102571, 2026-09-14):
  // the button is Delete now, and "Stop Using" is gone.
  appleManual: `dsul can't remove itself from Sign in with Apple here. Afterwards, ${APPLE_STEPS}`,
  appleManualWeb: `dsul can't remove itself from Sign in with Apple here. Afterwards, ${APPLE_STEPS_WEB}`,
  unreachable: "Couldn't reach dsul. Check your connection and try again.",
  failed: "Couldn't delete your account. Nothing was deleted. Try again.",
  changed: "You're signed in to a different account now, so nothing was deleted. Close this and open it again.",
  deleted: DELETED,
  appleLeft: `${DELETED} Apple may still list dsul under Sign in with Apple: ${APPLE_STEPS}`,
  appleLeftWeb: `${DELETED} Apple may still list dsul under Sign in with Apple. To remove it, ${APPLE_STEPS_WEB}`,
  confirmLabel: `Type ${ACCOUNT_CONFIRM_WORD} to confirm`,
  deleteLabel: 'Delete account',
  deletingLabel: 'Deleting…',
  doneLabel: 'Done',
} as const;

/**
 * The typed word, any case, with the space JavaScript trims trimmed. DsulCore's
 * `confirms` is the same rule over `jsTrim`, so a word that lights Delete on
 * one client lights it on the other. What is typed is never sent: the client
 * sends the constant.
 */
export function confirms(typed: string): boolean {
  return typed.trim().toUpperCase() === ACCOUNT_CONFIRM_WORD;
}

/** "A"; "A and B"; "A, B and C" (no Oxford comma). Empty for none. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Present and not blank. A blank email or provider reads as none, as the phone decodes it. */
function named(value: string | null): value is string {
  return value !== null && value.trim() !== '';
}

/**
 * The account line, naming the account by its email, or null with no email.
 * A Hide My Email address shows as it is.
 */
export function accountLine(facts: AccountFacts): string | null {
  return named(facts.email) ? ACCOUNT_COPY.account(facts.email) : null;
}

/**
 * What dsul can't delete for the person, one line for each that applies, in
 * this order: Beeminder, the ledger, OpenClaw, the keys, the model key, Sign
 * in with Apple. `appleStep`: this device will run Apple's sheet, which only
 * the phone can (the web passes false). Otherwise an account with an Apple id
 * gets the manual line, the web's own when `web`.
 */
export function consequenceLines(facts: AccountFacts, opts: { appleStep: boolean; web: boolean }): string[] {
  const lines: string[] = [];
  if (facts.beeminder) lines.push(ACCOUNT_COPY.beeminder);
  if (facts.ledger) lines.push(ACCOUNT_COPY.ledger);
  if (facts.openclaw) lines.push(ACCOUNT_COPY.openclaw);
  if (facts.keyServices.length > 0) lines.push(ACCOUNT_COPY.keys(facts.keyServices));
  if (named(facts.modelProviderName)) lines.push(ACCOUNT_COPY.modelKey(facts.modelProviderName));
  if (opts.appleStep) lines.push(ACCOUNT_COPY.appleStep);
  else if (facts.appleIds.length > 0) {
    lines.push(opts.web ? ACCOUNT_COPY.appleManualWeb : ACCOUNT_COPY.appleManual);
  }
  return lines;
}

/**
 * The line once the account is gone. `not_revoked` says Apple may still list
 * dsul; `unknown` (a retried call whose first answer was lost) says so only
 * for an account that had an Apple id, since nobody can tell whether the
 * first call revoked it; `revoked` and `none` are the plain line. `web` picks
 * the web's Apple wording.
 */
export function doneMessage(apple: AppleRevocation, hadApple: boolean, opts?: { web?: boolean }): string {
  const left = opts?.web ? ACCOUNT_COPY.appleLeftWeb : ACCOUNT_COPY.appleLeft;
  switch (apple) {
    case 'not_revoked':
      return left;
    case 'unknown':
      return hadApple ? left : ACCOUNT_COPY.deleted;
    case 'revoked':
    case 'none':
      return ACCOUNT_COPY.deleted;
  }
}
