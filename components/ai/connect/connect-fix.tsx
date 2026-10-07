'use client';

import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Button, buttonVariants } from '@/components/ui/button';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { detectKeyProvider, isSureKey } from '@/lib/ai-key-prefix';
import { AI_SETTINGS_PATH, PROVIDER_META, type ApiErrorCode, type ModelConnectionView } from '@/lib/ai-types';
import { cn } from '@/lib/utils';
import { DesktopSignIn, FlowNote } from './connect-ai';
import { KeyField, type KeyFieldHandle } from './key-field';
import { CheckNoteView, KeyPageLink, noteHasActions, useKeyCheck } from './key-check';
import {
  SETUP_MODEL_HREF,
  checkFailureCopy,
  checkingCopy,
  companyName,
  keyPageLabel,
  labelName,
  openRouterStartHref,
  shortName,
  spendFlowResult,
  useFlowResultSpentOnLeave,
  useInDesktopApp,
  useResetsAt,
} from './connect-shared';

/**
 * What is wrong with the saved connection, in plain words. `askFix` covers a
 * key the provider stopped accepting, a key dsul can no longer read, and a
 * connection saved with no model picked; the first two are fixed right here
 * (ConnectFix), the last in Settings → AI. An OpenRouter sign-in never had a
 * key to paste, so its copy says sign-in and "sign in again".
 *
 * `check` labels the fresh check of the saved key and `still` is what it says
 * when the provider still turns it down.
 */
export function fixCopy(model: ModelConnectionView): {
  status: string;
  note: string;
  href: string;
  action: string;
  check: string;
  still: string;
} {
  const signIn = model.authMethod === 'oauth';
  const company = companyName(model.provider, model.baseUrl);
  const check = signIn ? 'Check again' : 'Check the old key again';
  const still = signIn
    ? `${company} still turns it down. Signing in again fixes it.`
    : `${company} still turns it down. A new key above fixes it.`;
  if (model.status !== 'failing') {
    return {
      status: 'No model picked',
      note: 'No model is picked yet, so AI can’t answer. Pick one in Settings → AI.',
      href: SETUP_MODEL_HREF,
      action: 'Pick a model in Settings → AI',
      check,
      still,
    };
  }
  if (model.problem === 'key_unreadable') {
    return {
      status: 'Needs attention',
      note: signIn
        ? 'dsul can’t read your saved sign-in anymore, so AI can’t answer right now. Sign in again and Ask picks up where it left off.'
        : 'dsul can’t read your saved key anymore, so AI can’t answer right now. Paste it again and Ask picks up where it left off.',
      href: AI_SETTINGS_PATH,
      action: 'Settings → AI',
      check,
      still,
    };
  }
  return {
    status: 'Needs attention',
    note: signIn
      ? `${company} stopped accepting your sign-in, so AI can’t answer right now. Sign in again and Ask picks up where it left off.`
      : `${company} stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.`,
    href: AI_SETTINGS_PATH,
    action: 'Settings → AI',
    check,
    still,
  };
}

/** "an hour ago", "3 minutes ago", "just now". */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (Date.now() - at.getTime() < 60_000) return 'just now';
  return formatDistanceToNowStrict(at, { addSuffix: true })
    .replace(/^1 hour\b/, 'an hour')
    .replace(/^1 (minute|day|month|year)\b/, 'a $1');
}

/** Recheck answers that say something about the key (or its account) worth its own line. */
const SAYS_SOMETHING: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'no_credit',
  'daily_limit',
  'region',
  'network',
  'unreachable',
  'busy',
]);

const QUIET_ACTION =
  'rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-default aria-disabled:hover:text-muted-foreground';

/**
 * The fix home's card (the setup column, "Fix AI"): a saved connection the
 * provider stopped accepting, or one dsul can no longer read, fixed in place.
 *
 *  - Its name, "Key saved · Google turned it down an hour ago", and what that
 *    means, in a honey note.
 *  - A box for a new key, with the same mechanics as the connect card's: a
 *    paste the saved provider's prefix makes sure of is checked at once, and
 *    the old key is replaced only once the new one works (the route checks
 *    before it saves). A sign-in signs in again instead, from the browser in
 *    the desktop app, where a pasted OpenRouter key also works.
 *  - A fresh check of the old key, with a line for each answer.
 *  - Outside the card: where everything else is, Settings → AI.
 *
 * A key that works turns the column into Ask on its own, home as it was: a
 * fix picks up where it left off, so it never says "It works." (no
 * `justConnected`). Nothing in it is lime.
 */
export function ConnectFix({ model }: { model: ModelConnectionView }) {
  const uid = useId();
  const keyId = `${uid}-key`;
  const inDesktopApp = useInDesktopApp();
  const busy = useAIConnectionStore((s) => s.busy);
  const flowResult = useAIConnectionStore((s) => s.flowResult);
  const resetsAtOf = useResetsAt();
  const field = useRef<KeyFieldHandle>(null);
  const [hasKey, setHasKey] = useState(false);
  // What the fresh check of the old key said, or "Copied" for the sign-in link.
  const [line, setLine] = useState<string | null>(null);
  const check = useKeyCheck({ field, onOk: () => {} });
  useFlowResultSpentOnLeave();

  const copy = fixCopy(model);
  const { provider, baseUrl } = model;
  const oauth = model.authMethod === 'oauth';
  const unreadable = model.problem === 'key_unreadable';
  // A key connection takes a new key; a sign-in signs in again, except in the
  // desktop app, where that can't finish and a pasted OpenRouter key can.
  const takesKey = !oauth || inDesktopApp;
  const signInAgain = oauth && !inDesktopApp;
  const keyPage = PROVIDER_META[provider].keyHelpUrl;
  const target = check.target;
  const when = ago(model.checkedAt);
  const status = unreadable
    ? 'Needs attention'
    : `${companyName(provider, baseUrl)} turned it down${when ? ` ${when}` : ''}`;

  const send = () => {
    setLine(null);
    // Same provider and host; a custom service's model rides along, since
    // its list may not name one.
    if (provider === 'custom') {
      void check.send(provider, { baseUrl: baseUrl ?? undefined, model: model.model ?? undefined });
    } else void check.send(provider);
  };

  const onPaste = (key: string) => {
    spendFlowResult();
    setLine(null);
    setHasKey(true);
    // Another service's keys have no prefix to go by: they wait for Connect.
    if (provider === 'custom') return;
    const detected = detectKeyProvider(key);
    if (detected === provider && isSureKey(key)) return send();
    if (detected && detected !== provider) check.say({ kind: 'wrong', detected, provider, baseUrl });
    else if (!detected) check.say({ kind: 'undetected', provider });
  };

  const recheck = async () => {
    // Pressed again while a check is out: the button stays focusable while
    // busy (a focused button that goes `disabled` drops focus to <body>).
    if (useAIConnectionStore.getState().busy !== null) return;
    spendFlowResult();
    setLine(null);
    const result = await useAIConnectionStore.getState().recheck();
    if (result.ok) {
      // The route answers a check it could make with the connection as it now
      // stands, so a key still turned down is an ok answer whose status still
      // reads failing. Working again (or only at today's limit), the gate
      // lights and the column becomes Ask on its own.
      const now = useAIConnectionStore.getState().model;
      if (now?.status === 'failing' && now.problem === 'key_rejected') setLine(copy.still);
      return;
    }
    if (result.code === 'key_rejected') return setLine(copy.still);
    if (SAYS_SOMETHING.has(result.code)) {
      const resetsAt = resetsAtOf(result.limitedUntil);
      return setLine(checkFailureCopy(result.code, provider, { baseUrl, resetsAt, elsewhere: 'settings' }));
    }
    setLine('Couldn’t check it just now. Try again in a moment.');
  };

  const showConnect = hasKey && target === null && !noteHasActions(check.note);

  return (
    <>
      <section
        data-testid="setup-fix"
        aria-labelledby={`${uid}-title`}
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4"
      >
        <div className="flex flex-col gap-0.5">
          <h3 id={`${uid}-title`} className="text-sm font-medium text-foreground">
            {labelName(provider, baseUrl)}
          </h3>
          <p data-testid="fix-line" className="text-xs text-muted-foreground">
            {oauth ? 'Signed in' : 'Key saved'} · {status}
          </p>
        </div>
        <div className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2.5">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <p className="text-sm leading-snug text-foreground">{copy.note}</p>
        </div>

        {signInAgain && (
          <a
            href={openRouterStartHref('home')}
            data-testid="fix-signin-again"
            onClick={spendFlowResult}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start')}
          >
            Sign in again
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        )}
        {oauth && inDesktopApp && <DesktopSignIn onSay={setLine} inline={false} />}
        {oauth && flowResult && <FlowNote flow={flowResult} testId="fix-flow-note" />}

        {takesKey && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={keyId} className="text-xs font-medium text-foreground">
              New {shortName(provider, baseUrl)} key
            </label>
            <KeyField
              ref={field}
              id={keyId}
              placeholder={provider === 'custom' ? PROVIDER_META.custom.keyPlaceholder : undefined}
              checking={target !== null}
              describedBy={`${uid}-help`}
              testId="fix-key"
              onChange={(key) => {
                setHasKey(key !== '');
                check.forget();
              }}
              onPaste={onPaste}
              onEnter={() => hasKey && send()}
            />
            <p id={`${uid}-help`} className="text-xs leading-snug text-muted-foreground">
              Your old key is replaced only once this one works.
            </p>
            {check.note && (
              <CheckNoteView
                note={check.note}
                noteRef={check.noteRef}
                elsewhere="settings"
                testId="fix-note"
                onCheckAgain={() => {
                  // The note's provider: the saved one, or the one "Use it with" sent it to.
                  if (check.note?.kind !== 'failure') return;
                  setLine(null);
                  if (check.note.provider === provider) send();
                  else void check.send(check.note.provider);
                }}
                onUseIt={(p) => {
                  setLine(null);
                  void check.send(p);
                }}
                onClear={() => {
                  field.current?.clear();
                  field.current?.focus();
                }}
              />
            )}
            {showConnect && (
              <Button type="button" variant="outline" size="sm" data-testid="fix-submit" onClick={send} className="self-start">
                Connect
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {takesKey && keyPage && <KeyPageLink href={keyPage} label={keyPageLabel(provider, baseUrl)} />}
          {/* A fresh check only helps a key the provider turned down: an
              unreadable key reads no better a second time. */}
          {!unreadable && (
            <button
              type="button"
              data-testid="setup-recheck"
              aria-disabled={busy !== null || undefined}
              onClick={() => void recheck()}
              className={QUIET_ACTION}
            >
              {busy === 'recheck' ? 'Checking…' : copy.check}
            </button>
          )}
        </div>
        {/* There from the start, so what it says next is announced. Empty, it
            gives back the gap above it. */}
        <p role="status" data-testid="fix-status" className="text-xs leading-snug text-muted-foreground empty:-mt-3">
          {target ? checkingCopy(target.provider, target.baseUrl) : line}
        </p>
      </section>
      <p data-testid="fix-caption" className="text-xs leading-snug text-muted-foreground">
        Other services, the model and Disconnect are in{' '}
        <Link
          href={AI_SETTINGS_PATH}
          className="rounded-[3px] text-foreground underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Settings → AI
        </Link>
        .
      </p>
    </>
  );
}
