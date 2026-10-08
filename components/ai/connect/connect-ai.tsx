'use client';

import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Coins,
  Info,
  KeyRound,
  Send,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { Button, buttonVariants } from '@/components/ui/button';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { detectKeyProvider, isSureKey, type DetectedProvider } from '@/lib/ai-key-prefix';
import { AI_SETTINGS_PATH, PROVIDER_META, isModelId, type ModelConnectionView, type ModelProviderId } from '@/lib/ai-types';
import { markConsent, useKeptQuestion } from '@/lib/ask-pending';
import { FLOW_COPY, type FlowResult } from '@/lib/connect-flow';
import { getDesktopBridge } from '@/lib/desktop';
import { useRailStore } from '@/lib/rail-store';
import { cn } from '@/lib/utils';
import { KeyField, type KeyFieldHandle } from './key-field';
import {
  CheckNoteView,
  KeyPageLink,
  KeyStarts,
  noteHasActions,
  useKeyCheck,
  type CheckNote,
  type CheckTarget,
} from './key-check';
import {
  ANCHOR_CLASS,
  checkingCopy,
  companyName,
  consentCopy,
  desktopSignInLink,
  goodToKnowCopy,
  openRouterStartHref,
  settingAnchor,
  shortName,
  spendFlowResult,
  undetectedCopy,
  useFlowResultSpentOnLeave,
  useInDesktopApp,
} from './connect-shared';

/**
 * Connect AI: the way in, wherever nothing answers yet. The setup column's
 * setup home (host 'column', components/ai/rail/ask-setup.tsx) and Settings →
 * AI's not-connected state (host 'pane', model-connection-panel.tsx).
 *
 *  - The key card leads: a free key from Google, three steps, and the box.
 *    Pasting a key Google's prefix makes sure of checks it at once, with one
 *    tiny test question; anything else waits in the box for Connect (a paste is
 *    deliberate, but whatever was on the clipboard is not always a key).
 *  - Two folds under it, one open at a time: Sign in with OpenRouter, and "I
 *    already use…" (a key from anyone, by its prefix; another service by its
 *    address; OpenClaw by its guide). A closed fold keeps what was typed in it.
 *  - Good to know: cost, what is sent, the key, taking it back, at body size.
 *
 * A key that fails stays in its box, and the note under it says why in our
 * words, with what to do next. A key that works leaves the box at once. In the
 * column that is the moment it becomes Ask, home first, with "It works." (the
 * store's `justConnected`); in the pane, the connected card takes over.
 *
 * A QUESTION KEPT from `?` (lib/ask-pending.ts) changes the column's card, and
 * only the column's: it goes out once a connection lands, so nothing is sent
 * without saying where. A paste only fills the box, however sure its prefix.
 * Then a consent line ("Connecting sends your question … to Google.") sits
 * right above whatever would send it, [Connect and ask], or a refusal's
 * [Check again], and describes that control and the box; pressing it stamps
 * the consent the question is sent on. [Use it with OpenAI] only points the
 * card at OpenAI (`armed`): the line names OpenAI, and Connect and ask sends.
 * The OpenRouter sign-in, or the desktop app's link for it, has the line too.
 * The pane ignores a kept question: a connection made there leaves it waiting
 * in Ask's box, unsent.
 *
 * Nothing in it is lime in the column (ask-setup.tsx's rule): every button
 * there is outline or a quiet text action. It has one live region, there from
 * the start, so a check that begins is announced, and so is a paste that is
 * not checked, which otherwise changes the page silently.
 */
export function ConnectAI({
  host,
  layout = 'desktop',
  highlightId = null,
  onConnected,
  unfold,
  afterFolds,
}: {
  host: 'column' | 'pane';
  /**
   * The phone's setup page (components/mobile/setup-tab.tsx): a key that
   * works pops the phone's Ask stack home, and the OpenRouter sign-in comes
   * back "here", to the tab, rather than to a column.
   */
  layout?: 'desktop' | 'phone';
  /** The pane's deep-link ring (`?focus=beacon.apiKey` lands on the key box). */
  highlightId?: string | null;
  /** The pane's hand-off to its connected card. */
  onConnected?: () => void;
  /** `?start=openrouter`: the sign-in fold open and its button focused. Never a sign-in by itself. */
  unfold?: 'openrouter';
  /** Between the folds and Good to know: the phone's page puts its previews there, the key card leading. */
  afterFolds?: ReactNode;
}) {
  const flowResult = useAIConnectionStore((s) => s.flowResult);
  // Read where it is mounted only, never on the server (a host shows it once
  // the gate has answered), so a state initializer may ask the window.
  const [startHere] = useState(() => unfold === 'openrouter' && getDesktopBridge() === null);
  const [openFold, setOpenFold] = useState<FoldId | null>(() =>
    flowResult !== null || startHere ? 'openrouter' : null
  );
  // A sign-in's result that arrives while this is up opens the fold it is about.
  const [seenFlow, setSeenFlow] = useState(flowResult);
  if (flowResult !== seenFlow) {
    setSeenFlow(flowResult);
    if (flowResult !== null) setOpenFold('openrouter');
  }
  const [checking, setChecking] = useState<CheckTarget | null>(null);
  const [said, setSaid] = useState('');
  const signInRef = useRef<HTMLAnchorElement>(null);
  // Read in either host, so the hooks hold still; only the column acts on it.
  const asks = useKeptQuestion() !== null && host === 'column';
  useFlowResultSpentOnLeave();

  useEffect(() => {
    if (startHere) signInRef.current?.focus();
  }, [startHere]);

  const toggle = (id: FoldId) => {
    spendFlowResult();
    setOpenFold((open) => (open === id ? null : id));
  };

  const succeed = ({ freeTier }: { freeTier: boolean }) => {
    if (host === 'pane') {
      onConnected?.();
      return;
    }
    // Only a connection that can answer becomes Ask; one saved without a
    // model turns the column into the fix home instead, with nothing to cheer.
    const model = useAIConnectionStore.getState().model;
    if (!model || model.status !== 'ok' || !model.model) return;
    useRailStore.getState().popToHome(layout === 'phone' ? 'phone' : 'desktop');
    useAIConnectionStore
      .getState()
      .setJustConnected({ provider: model.provider, model: model.model, freeTier, at: Date.now() });
  };

  // A check that starts clears whatever was said before it ("Copied", a
  // paste's note), so its end never reads that out again.
  const onChecking = (target: CheckTarget | null) => {
    if (target) setSaid('');
    setChecking(target);
  };

  const forms = { host, busy: checking !== null, onChecking, onOk: succeed, asks };

  return (
    <div data-testid="connect-ai" data-connect-host={host} data-layout={layout} className="flex flex-col gap-5">
      <KeyCard {...forms} highlightId={highlightId} onSay={setSaid} />
      <div
        data-testid="connect-folds"
        className={cn('flex flex-col divide-y divide-border border border-border', host === 'column' ? 'rounded-xl' : 'rounded-[8px]')}
      >
        <Fold
          id="openrouter"
          title="Sign in with OpenRouter"
          sub="Free models on a new, free account. Nothing to copy."
          open={openFold === 'openrouter'}
          onToggle={() => toggle('openrouter')}
        >
          <OpenRouterBody host={host} layout={layout} asks={asks} signInRef={signInRef} onSay={setSaid} />
        </Fold>
        <Fold
          id="any"
          title="I already use OpenAI, Anthropic, Gemini or another service"
          sub="Paste a key you have, use your own server, or pair OpenClaw."
          open={openFold === 'any'}
          onToggle={() => toggle('any')}
        >
          <AnyKeyBody {...forms} onSay={setSaid} />
        </Fold>
      </div>
      {afterFolds}
      <GoodToKnow host={host} />
      {/* The one live region: there before anything is said into it. */}
      <p role="status" data-testid="connect-status" className="sr-only">
        {checking ? checkingCopy(checking.provider, checking.baseUrl) : said}
      </p>
    </div>
  );
}

type FoldId = 'openrouter' | 'any';

interface FormProps {
  host: 'column' | 'pane';
  /** A key is out being checked somewhere in the card: one at a time. */
  busy: boolean;
  onChecking: (target: CheckTarget | null) => void;
  onOk: (o: { freeTier: boolean }) => void;
  /** A question kept from `?` goes out with this connect (the column only): see ConnectAI. */
  asks: boolean;
}

/** Says a line through ConnectAI's live region ('' clears it). */
type Say = (text: string) => void;

/** The column's buttons are outline (nothing lime there); the pane's main action keeps its fill. */
const mainVariant = (host: FormProps['host']) => (host === 'pane' ? 'default' : 'outline');

const LABEL = 'text-xs font-medium text-foreground';
const HELP = 'text-xs leading-snug text-muted-foreground';
const QUIET_LINK =
  'rounded-[3px] underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** "Checking your key with Google…", beside the box. The live region says it; this only shows it. */
function CheckingPill({ target }: { target: CheckTarget }) {
  return (
    <p
      aria-hidden
      data-testid="connect-checking"
      className="inline-flex self-start rounded-full bg-secondary px-2 py-0.5 text-xs text-foreground"
    >
      {checkingCopy(target.provider, target.baseUrl)}
    </p>
  );
}

/**
 * [Connect] for a key that was typed, or pasted without a prefix to be sure
 * of; [Connect and ask] for any key while a question is kept.
 */
function ConnectButton({
  host,
  busy,
  disabled,
  asks,
  consentId,
  onClick,
  testId,
}: {
  host: FormProps['host'];
  busy: boolean;
  disabled?: boolean;
  asks: boolean;
  /** The consent line right above it, while it is there. */
  consentId?: string;
  onClick: () => void;
  testId: string;
}) {
  // Focusable while it can't act yet (a focused button that goes `disabled`
  // drops focus to <body>): `aria-disabled`, and the handler checks.
  return (
    <Button
      type="button"
      variant={mainVariant(host)}
      size="sm"
      data-testid={testId}
      aria-disabled={busy || disabled || undefined}
      aria-describedby={consentId}
      onClick={() => {
        if (!busy && !disabled) onClick();
      }}
      className="self-start aria-disabled:opacity-50"
    >
      {asks ? 'Connect and ask' : 'Connect'}
    </Button>
  );
}

/**
 * Where the press right under it sends the kept question, said before it is
 * pressed. Its id describes the box and the control that sends, and only a
 * press made while it is on screen stamps the consent the question goes out on.
 */
function ConsentLine({ id, to }: { id: string; to: CheckTarget }) {
  return (
    <p id={id} data-testid="connect-consent" className={HELP}>
      {consentCopy(to.provider, to.baseUrl)}
    </p>
  );
}

/**
 * What the control under the consent line sends to: a refusal's [Check
 * again], standing in for the button, resends where the key last went;
 * otherwise wherever the form points now.
 */
function sendingTarget(note: CheckNote | null, now: CheckTarget): CheckTarget {
  return note?.kind === 'failure' && noteHasActions(note) ? { provider: note.provider, baseUrl: note.baseUrl } : now;
}

const OPENROUTER: CheckTarget = { provider: 'openrouter', baseUrl: null };

/* ── The key card: a free key from Google ───────────────────────────────── */

function KeyCard({
  host,
  busy,
  onChecking,
  onOk,
  asks,
  onSay,
  highlightId,
}: FormProps & { onSay: Say; highlightId: string | null }) {
  const uid = useId();
  const keyId = `${uid}-key`;
  const helpId = `${uid}-help`;
  const consentId = `${uid}-consent`;
  const stepsId = `${uid}-steps`;
  const field = useRef<KeyFieldHandle>(null);
  const [hasKey, setHasKey] = useState(false);
  // The steps fold once a key is in the box; this opens them anyway.
  const [stepsShown, setStepsShown] = useState(false);
  // [Use it with OpenAI] while a question is kept: where Connect and ask sends instead of Google.
  const [armed, setArmed] = useState<DetectedProvider | null>(null);
  const check = useKeyCheck({
    field,
    onChecking,
    onOk,
    // A refusal brings the steps back: the key may be cut short, or deleted.
    onNote: (note) => {
      if (note.kind === 'failure' && note.code === 'key_rejected') setStepsShown(true);
    },
  });
  const stepsOpen = !hasKey || stepsShown;
  const target = check.target;
  const sendTo: ModelProviderId = armed ?? 'gemini';
  // The line is up while something under it would send the key; never over
  // another company's note, whose actions send nothing while a question is kept.
  const consent = asks && hasKey && target === null && check.note?.kind !== 'wrong';

  /** Sends the box's key. A press under the consent line says first that the question may go there too. */
  const connect = (provider: ModelProviderId = sendTo) => {
    if (consent) markConsent({ provider });
    void check.send(provider);
  };

  const onPaste = (key: string) => {
    spendFlowResult();
    setHasKey(true);
    setStepsShown(false);
    setArmed(null);
    onSay('');
    const detected = detectKeyProvider(key);
    if (detected === 'gemini' && isSureKey(key)) {
      if (!asks) {
        void check.send('gemini');
        return;
      }
      // A question kept: the paste only fills the box, and Connect and ask
      // sends both. The page changes silently otherwise, so the region says
      // where it would go.
      check.forget();
      onSay(consentCopy('gemini'));
      return;
    }
    // Not sure it is Google's: it waits for Connect. A detection is only a
    // guess (Google changed its keys' prefix once), so Connect still sends it.
    check.say(
      detected ? { kind: 'wrong', detected, provider: 'gemini', baseUrl: null } : { kind: 'undetected', provider: 'gemini' }
    );
    // The quiet note has no live role (one inserted already holding its words
    // is not reliably read out), so the region says it.
    if (!detected) onSay(undetectedCopy('gemini'));
  };

  const clear = () => {
    field.current?.clear();
    field.current?.focus();
  };

  /** Use it with X: at once, or, with a question kept, points Connect and ask at X and sends nothing. */
  const useIt = (provider: DetectedProvider) => {
    if (!asks) {
      void check.send(provider);
      return;
    }
    check.forget();
    setArmed(provider);
    field.current?.focus();
    // The box's description changes after focus lands: the region says it.
    onSay(consentCopy(provider));
  };

  const showConnect = hasKey && target === null && !noteHasActions(check.note);
  // Right above whatever sends: the refusal's Check again, or the button.
  const consentAboveNote = consent && noteHasActions(check.note);
  const consentLine = consent && (
    <ConsentLine id={consentId} to={sendingTarget(check.note, { provider: sendTo, baseUrl: null })} />
  );

  return (
    <section
      data-testid="connect-key-card"
      aria-labelledby={`${uid}-title`}
      className={cn(
        'flex flex-col gap-3 border border-border p-4',
        host === 'column' ? 'rounded-xl bg-surface-2' : 'rounded-[8px]'
      )}
    >
      <span className="self-start rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground">
        Free, no card
      </span>
      <div className="flex flex-col gap-1">
        {/* Focusable for YOUR QUESTION's Clear on the phone: a title, so no keyboard comes up. */}
        <h3
          id={`${uid}-title`}
          tabIndex={-1}
          data-setup-card-heading=""
          className="text-sm font-medium text-foreground outline-none"
        >
          Get a free key from Google
        </h3>
        <p className="text-sm leading-snug text-muted-foreground">
          Anyone with a Google account can make one. It works in dsul on the web and in the desktop app.
        </p>
      </div>
      <p className="flex gap-2 text-xs leading-snug text-muted-foreground">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>A ChatGPT or Claude subscription isn’t an API key. This free key works instead.</span>
      </p>

      <div className="flex flex-col gap-2">
        {hasKey ? (
          <button
            type="button"
            aria-expanded={stepsOpen}
            aria-controls={stepsId}
            data-testid="connect-steps-toggle"
            onClick={() => setStepsShown(!stepsOpen)}
            className="inline-flex items-center gap-1 self-start rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className={ASK_SECTION_HEADING}>What you’ll see</span>
            <span aria-hidden> · </span>
            <span>{stepsOpen ? 'Hide the steps' : 'Show the steps'}</span>
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', stepsOpen && 'rotate-180')} />
          </button>
        ) : (
          <h4 className={ASK_SECTION_HEADING}>What you’ll see</h4>
        )}
        <ol id={stepsId} hidden={!stepsOpen} data-testid="connect-steps" className="flex flex-col gap-2.5">
          <Step n={1}>
            <span>Google AI Studio opens. Sign in with your Google account.</span>
            <KeyPageLink href={PROVIDER_META.gemini.keyHelpUrl!} label="Open Google AI Studio" />
          </Step>
          <Step n={2}>
            <span>
              Press <strong className="font-medium">Get API key</strong>, then{' '}
              <strong className="font-medium">Create API key</strong>. If it asks about a project, keep the one it
              offers.
            </span>
          </Step>
          <Step n={3}>
            <span>
              Copy the key and paste it below. It starts with <KeyStarts provider="gemini" />.
            </span>
          </Step>
        </ol>
      </div>

      <div
        {...(host === 'pane' ? settingAnchor('beacon.apiKey', highlightId) : {})}
        className={cn('flex flex-col gap-1.5', host === 'pane' && ANCHOR_CLASS)}
      >
        <label htmlFor={keyId} className={LABEL}>
          Your Gemini key
        </label>
        <KeyField
          ref={field}
          id={keyId}
          checking={target !== null}
          describedBy={target !== null ? undefined : asks && hasKey ? (consent ? consentId : undefined) : helpId}
          testId="connect-key"
          onChange={(key) => {
            setHasKey(key !== '');
            setArmed(null);
            check.forget();
            onSay('');
          }}
          onPaste={onPaste}
          onEnter={() => hasKey && connect()}
        />
        {target ? (
          <CheckingPill target={target} />
        ) : (
          // With a question kept, the helper is for the empty box: the
          // consent line takes its place once a key is in.
          !(asks && hasKey) && (
            <p id={helpId} className={HELP}>
              {asks
                ? 'dsul checks it with one tiny test question, then asks yours.'
                : 'dsul checks it the moment you paste, with one tiny test question.'}
            </p>
          )
        )}
        {consentAboveNote && consentLine}
        {check.note && (
          <CheckNoteView
            note={check.note}
            noteRef={check.noteRef}
            elsewhere="below"
            consentId={consentAboveNote ? consentId : undefined}
            onCheckAgain={() => check.note?.kind === 'failure' && connect(check.note.provider)}
            onUseIt={useIt}
            onClear={clear}
          />
        )}
        {showConnect && consentLine}
        {showConnect && (
          <ConnectButton
            host={host}
            busy={busy}
            asks={asks}
            consentId={consent ? consentId : undefined}
            onClick={() => connect()}
            testId="connect-submit"
          />
        )}
      </div>
    </section>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-num text-2xs text-muted-foreground"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-col gap-2 text-sm leading-snug text-foreground">{children}</div>
    </li>
  );
}

/* ── The folds ──────────────────────────────────────────────────────────── */

/** One of the folds under the card: a disclosure whose body stays mounted, hidden, while closed. */
function Fold({
  id,
  title,
  sub,
  open,
  onToggle,
  children,
}: {
  id: FoldId;
  title: string;
  sub: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div data-fold={id} className="flex flex-col">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`connect-fold-${id}`}
          onClick={onToggle}
          className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{title}</span>
            <span className="text-xs leading-snug text-muted-foreground">{sub}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} data-testid={`connect-fold-${id}-body`} className="flex flex-col gap-3 px-4 pb-4">
        {children}
      </div>
    </div>
  );
}

const OPENROUTER_FIRST =
  'Make a free OpenRouter account, then come back here. On a new account, dsul picks a free model, which has a daily limit.';

function OpenRouterBody({
  host,
  layout,
  asks,
  signInRef,
  onSay,
}: {
  host: FormProps['host'];
  layout: 'desktop' | 'phone';
  asks: boolean;
  signInRef: RefObject<HTMLAnchorElement | null>;
  onSay: (text: string) => void;
}) {
  const consentId = useId();
  const inDesktopApp = useInDesktopApp();
  const flowResult = useAIConnectionStore((s) => s.flowResult);
  return (
    <>
      <p className="text-sm leading-snug text-foreground">{OPENROUTER_FIRST}</p>
      {inDesktopApp ? (
        <>
          <DesktopSignIn onSay={onSay} asks={asks} />
          <p className={HELP}>Or use the free Google key above, which works here as it is.</p>
        </>
      ) : (
        <>
          {/* The sign-in sends the kept question once it lands: said above it, stamped as it is pressed. */}
          {asks && <ConsentLine id={consentId} to={OPENROUTER} />}
          <a
            ref={signInRef}
            href={openRouterStartHref(host === 'pane' ? 'settings' : 'home')}
            data-testid="connect-openrouter-signin"
            aria-describedby={asks ? consentId : undefined}
            onClick={() => {
              if (asks) markConsent(OPENROUTER);
              spendFlowResult();
            }}
            className={cn(buttonVariants({ variant: mainVariant(host), size: 'sm' }), 'self-start')}
          >
            Sign in with OpenRouter
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
          <p className={HELP}>
            {host === 'pane' || layout === 'phone'
              ? 'OpenRouter opens in this tab and sends you back here.'
              : 'OpenRouter opens in this tab and sends you back to this column.'}
          </p>
        </>
      )}
      {flowResult && <FlowNote flow={flowResult} testId="connect-flow-note" />}
    </>
  );
}

/** How an OpenRouter sign-in that came home ended, where it can be tried again. */
export function FlowNote({ flow, testId }: { flow: FlowResult; testId: string }) {
  return (
    <div data-testid={testId} data-flow={flow} className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2.5">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
      <p role="alert" className="text-sm leading-snug text-foreground">
        {FLOW_COPY[flow]}
      </p>
    </div>
  );
}

const COPIED = 'Copied. Paste it into your browser.';

/**
 * Signing in with OpenRouter from the desktop app: in the browser instead,
 * from a link this copies (the shell keeps every dsul address in its own
 * window and has no way to open one outside it; a clipboard write it allows).
 * The window asks the server again when it comes back to the front
 * (useRefreshOnWindowFocus, called by the host), and the connection is there.
 *
 * `onSay` speaks "Copied" through the host's live region; `inline` also shows
 * it beside the button, for a host whose region is not on screen. `asks`: a
 * question is kept, and the connection the browser makes will send it, so the
 * consent line sits above the button and the copy stamps it.
 */
export function DesktopSignIn({
  onSay,
  inline = true,
  asks = false,
}: {
  onSay: (text: string) => void;
  inline?: boolean;
  asks?: boolean;
}) {
  const consentId = useId();
  // The link, when it could not be copied: shown, so it can be copied by hand.
  const [copied, setCopied] = useState<{ ok: true } | { ok: false; link: string } | null>(null);

  const copyLink = () => {
    if (asks) markConsent(OPENROUTER);
    spendFlowResult();
    const link = desktopSignInLink();
    const failed = () => setCopied({ ok: false, link });
    if (typeof navigator.clipboard?.writeText !== 'function') return failed();
    navigator.clipboard.writeText(link).then(() => {
      setCopied({ ok: true });
      onSay(COPIED);
    }, failed);
  };

  return (
    <>
      <p className={HELP} data-testid="connect-openrouter-desktop">
        Sign-in can’t finish inside the desktop app yet. Open dsul in your browser and sign in there. This window picks
        up the connection when you come back.
      </p>
      {asks && <ConsentLine id={consentId} to={OPENROUTER} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={asks ? consentId : undefined}
          onClick={copyLink}
          data-testid="connect-copy-link"
        >
          Copy the link
        </Button>
        {inline && copied?.ok && (
          <span aria-hidden className={HELP}>
            {COPIED}
          </span>
        )}
      </div>
      {copied && !copied.ok && (
        <p role="alert" className={HELP}>
          Couldn’t copy it. Open <span className="break-all text-foreground">{copied.link}</span> in your browser.
        </p>
      )}
    </>
  );
}

/** The four the prefix table can name, in the chooser's order. */
const CHOOSABLE: readonly DetectedProvider[] = ['openai', 'anthropic', 'gemini', 'openrouter'];

const CANT_TELL = 'dsul can’t tell which service this key is for.';

/** "I already use…": a key from any of them, placed by its prefix; another service; OpenClaw. */
function AnyKeyBody({ host, busy, onChecking, onOk, asks, onSay }: FormProps & { onSay: Say }) {
  const uid = useId();
  const keyId = `${uid}-key`;
  const consentId = `${uid}-consent`;
  const field = useRef<KeyFieldHandle>(null);
  const chooserRef = useRef<HTMLDivElement>(null);
  const [hasKey, setHasKey] = useState(false);
  // What the prefix says, and whether it is sure. Never the key.
  const [detected, setDetected] = useState<DetectedProvider | null>(null);
  const [sure, setSure] = useState(false);
  const [choice, setChoice] = useState<DetectedProvider | null>(null);
  // [Use it with X] while a question is kept: where Connect and ask sends instead.
  const [armed, setArmed] = useState<DetectedProvider | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const check = useKeyCheck({ field, onChecking, onOk });
  const target = check.target;
  const provider = armed ?? (sure ? detected : choice);
  const consent = asks && hasKey && target === null && provider !== null && check.note?.kind !== 'wrong';

  /** Reads the prefix; an unsure one (a bare `sk-`) preselects its guess in the chooser. */
  const place = (key: string) => {
    const d = detectKeyProvider(key);
    const s = d !== null && isSureKey(key);
    setHasKey(key !== '');
    setArmed(null);
    if (d !== detected || s !== sure) {
      setDetected(d);
      setSure(s);
      setChoice(d);
    }
    check.forget();
    onSay('');
    return s ? d : null;
  };

  /** Sends the box's key. A press under the consent line says first that the question may go there too. */
  const send = (to: ModelProviderId) => {
    if (consent) markConsent({ provider: to });
    void check.send(to);
  };

  const connect = () => {
    if (!provider) {
      chooserRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
      return;
    }
    send(provider);
  };

  const useIt = (p: DetectedProvider) => {
    // The chooser moves with the aim, so it never names another company than the line.
    if (!sure) setChoice(p);
    if (!asks) {
      void check.send(p);
      return;
    }
    check.forget();
    setArmed(p);
    field.current?.focus();
    onSay(consentCopy(p));
  };

  const showConnect = hasKey && target === null && !noteHasActions(check.note);
  const consentAboveNote = consent && noteHasActions(check.note);
  const consentLine = consent && provider && (
    <ConsentLine id={consentId} to={sendingTarget(check.note, { provider, baseUrl: null })} />
  );

  return (
    <>
      <p className="text-sm leading-snug text-foreground">
        Paste a key from any of them. dsul reads which service it’s for and checks it the same way.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className={LABEL}>
          Your key
        </label>
        <KeyField
          ref={field}
          id={keyId}
          checking={target !== null}
          describedBy={consent ? consentId : undefined}
          testId="connect-any-key"
          onChange={place}
          onPaste={(key) => {
            spendFlowResult();
            const sureOf = place(key);
            // A question kept: placed, not sent, until Connect and ask.
            if (sureOf && asks) onSay(consentCopy(sureOf));
            else if (sureOf) void check.send(sureOf);
            // Nothing is sent, and the chooser it brings is otherwise named only
            // once focus reaches a radio.
            else onSay(CANT_TELL);
          }}
          onEnter={connect}
        />
        {target && <CheckingPill target={target} />}
        {hasKey && sure && detected && target === null && (
          <p
            data-testid="connect-detected"
            className="inline-flex items-center gap-1 self-start rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
          >
            <Check aria-hidden className="size-3" />
            {shortName(detected)} key
          </p>
        )}
        {hasKey && !sure && (
          <div className="flex flex-col gap-1.5" data-testid="connect-chooser">
            <p id={`${uid}-which`} className={HELP}>
              {CANT_TELL}
            </p>
            <ServiceChooser
              chooserRef={chooserRef}
              labelledBy={`${uid}-which`}
              value={choice}
              busy={target !== null}
              onChange={(p) => {
                setChoice(p);
                setArmed(null);
                check.forget();
              }}
            />
          </div>
        )}
        {consentAboveNote && consentLine}
        {check.note && (
          <CheckNoteView
            note={check.note}
            noteRef={check.noteRef}
            elsewhere="here"
            consentId={consentAboveNote ? consentId : undefined}
            onCheckAgain={() => check.note?.kind === 'failure' && send(check.note.provider)}
            onUseIt={useIt}
            onClear={() => {
              field.current?.clear();
              field.current?.focus();
            }}
          />
        )}
        {showConnect && consentLine}
        {showConnect && (
          <ConnectButton
            host={host}
            busy={busy}
            disabled={!provider}
            asks={asks}
            consentId={consent ? consentId : undefined}
            onClick={connect}
            testId="connect-any-submit"
          />
        )}
      </div>
      <p className={HELP}>
        Need one?{' '}
        {(['openai', 'anthropic', 'openrouter'] as const).map((p, i) => (
          <Fragment key={p}>
            {i > 0 && ' · '}
            <a href={PROVIDER_META[p].keyHelpUrl ?? undefined} target="_blank" rel="noopener noreferrer" className={QUIET_LINK}>
              {companyName(p)}
            </a>
          </Fragment>
        ))}
      </p>
      <p className={HELP}>
        A ChatGPT Plus or Claude Pro plan isn’t an API key. Each company bills its API on its own, with credit you add
        first.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        <div className="flex flex-col">
          <button
            type="button"
            aria-expanded={customOpen}
            aria-controls={`${uid}-custom`}
            data-testid="connect-custom-toggle"
            onClick={() => {
              spendFlowResult();
              setCustomOpen((v) => !v);
            }}
            className="flex w-full items-start gap-3 rounded-t-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">Another service</span>
              <span className={HELP}>Your own address, if it speaks the OpenAI API and is on the internet.</span>
            </span>
            <ChevronDown
              aria-hidden
              className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', customOpen && 'rotate-180')}
            />
          </button>
          <div id={`${uid}-custom`} hidden={!customOpen} className="flex flex-col gap-3 px-3 pb-3">
            <CustomService host={host} busy={busy} onChecking={onChecking} onOk={onOk} asks={asks} onSay={onSay} />
          </div>
        </div>
        <Link
          href="/docs/openclaw"
          data-testid="connect-openclaw"
          className="flex items-start gap-3 rounded-b-lg px-3 py-2.5 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">OpenClaw</span>
            <span className={HELP}>Your own agent answers in Ask. The OpenClaw guide shows how to pair it.</span>
          </span>
          <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        </Link>
      </div>
    </>
  );
}

/**
 * Which service a key is for, when its prefix can't say: a radio row the arrow
 * keys move through. While the key is out being checked it holds still, as the
 * box does (focusable, never `disabled`): the answer is about the choice it was
 * sent with.
 */
function ServiceChooser({
  chooserRef,
  labelledBy,
  value,
  busy,
  onChange,
}: {
  chooserRef: RefObject<HTMLDivElement | null>;
  labelledBy: string;
  value: DetectedProvider | null;
  busy: boolean;
  onChange: (p: DetectedProvider) => void;
}) {
  const at = value === null ? 0 : CHOOSABLE.indexOf(value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = CHOOSABLE.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    if (busy) return;
    onChange(CHOOSABLE[next]);
    chooserRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div
      ref={chooserRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={busy || undefined}
      className="flex flex-wrap gap-1.5"
    >
      {CHOOSABLE.map((p, i) => {
        const checked = p === value;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === at ? 0 : -1}
            data-provider={p}
            onClick={() => {
              if (!busy) onChange(p);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'h-7 rounded-md border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              checked
                ? 'border-foreground/25 bg-secondary font-medium text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            )}
          >
            {shortName(p)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Another service: any OpenAI-compatible address. Typed, and sent only by
 * Connect: its keys have no prefix to go by. Its two plain fields are drawn as
 * `Input` draws one, without its lime selection.
 */
function CustomService({ host, busy, onChecking, onOk, asks, onSay }: FormProps & { onSay: Say }) {
  const uid = useId();
  const consentId = `${uid}-consent`;
  const field = useRef<KeyFieldHandle>(null);
  const [hasKey, setHasKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  // [Use it with X] while a question is kept: the key goes to X, and the address is not asked for.
  const [armed, setArmed] = useState<DetectedProvider | null>(null);
  const check = useKeyCheck({ field, onChecking, onOk });
  const target = check.target;
  const typedModel = modelName.trim();
  const modelOk = typedModel === '' || isModelId(typedModel);
  const ready = hasKey && baseUrl.trim() !== '' && modelOk;
  const consent = asks && target === null && (armed !== null || ready) && check.note?.kind !== 'wrong';
  const sendTo: CheckTarget = armed ? { provider: armed, baseUrl: null } : { provider: 'custom', baseUrl: baseUrl.trim() };

  /** Any edit: what the form points at is what it now holds. */
  const edited = () => {
    setArmed(null);
    check.forget();
  };

  const connect = () => {
    if (!armed && !ready) return;
    // A press under the consent line says first that the question may go there too.
    if (consent) markConsent(sendTo);
    if (armed) void check.send(armed);
    else void check.send('custom', { baseUrl: baseUrl.trim(), model: typedModel || undefined });
  };

  const useIt = (p: DetectedProvider) => {
    if (!asks) {
      void check.send(p);
      return;
    }
    check.forget();
    setArmed(p);
    field.current?.focus();
    onSay(consentCopy(p));
  };

  const showConnect = target === null && !noteHasActions(check.note);
  const consentAboveNote = consent && noteHasActions(check.note);
  const consentLine = consent && <ConsentLine id={consentId} to={sendingTarget(check.note, sendTo)} />;
  // The address and model hold still while the key is out, as the box does
  // (read-only, never `disabled`): the answer is about what was sent.
  const out = target !== null;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-url`} className={LABEL}>
          Base URL
        </label>
        <input
          id={`${uid}-url`}
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            edited();
          }}
          placeholder="https://api.example.com/v1"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={out}
          aria-busy={out || undefined}
          aria-describedby={`${uid}-url-help`}
          data-testid="connect-base-url"
          className="field h-9 w-full min-w-0 border bg-transparent px-3 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground dark:bg-input/30"
        />
        <p id={`${uid}-url-help`} className={HELP}>
          Any OpenAI-compatible service. Public https addresses only.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-model`} className={LABEL}>
          Model (optional)
        </label>
        <input
          id={`${uid}-model`}
          value={modelName}
          onChange={(e) => {
            setModelName(e.target.value);
            edited();
          }}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={out}
          aria-busy={out || undefined}
          aria-describedby={`${uid}-model-help`}
          aria-invalid={!modelOk || undefined}
          data-testid="connect-model-name"
          className="field h-9 w-full min-w-0 border bg-transparent px-3 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground dark:bg-input/30"
        />
        <p id={`${uid}-model-help`} className={HELP}>
          {modelOk ? 'Only needed if the service doesn’t list its models.' : 'Model names can’t contain spaces.'}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-key`} className={LABEL}>
          API key
        </label>
        <KeyField
          ref={field}
          id={`${uid}-key`}
          placeholder={PROVIDER_META.custom.keyPlaceholder}
          checking={out}
          describedBy={consent ? consentId : undefined}
          testId="connect-custom-key"
          onChange={(key) => {
            setHasKey(key !== '');
            edited();
          }}
          onPaste={() => {
            spendFlowResult();
            setHasKey(true);
            edited();
          }}
          onEnter={connect}
        />
        {target && <CheckingPill target={target} />}
        {consentAboveNote && consentLine}
        {check.note && (
          <CheckNoteView
            note={check.note}
            noteRef={check.noteRef}
            elsewhere="here"
            consentId={consentAboveNote ? consentId : undefined}
            onCheckAgain={connect}
            onUseIt={useIt}
            onClear={() => {
              field.current?.clear();
              field.current?.focus();
            }}
          />
        )}
        {showConnect && consentLine}
        {showConnect && (
          <ConnectButton
            host={host}
            busy={busy}
            disabled={!ready && !armed}
            asks={asks}
            consentId={consent ? consentId : undefined}
            onClick={connect}
            testId="connect-custom-submit"
          />
        )}
      </div>
    </>
  );
}

/* ── Good to know ───────────────────────────────────────────────────────── */

function Fact({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-[13px] leading-snug text-foreground">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p>
        <span className="font-medium">{title}</span> {children}
      </p>
    </li>
  );
}

/**
 * What it costs, what is sent, the key, and taking it back: at body size, never
 * fine print. The setup wording, before anything is connected: the connect
 * card's own section, in the column and on Settings → AI.
 */
export function GoodToKnow({ host }: { host: 'column' | 'pane' }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid="connect-good-to-know" className="flex flex-col gap-3">
      <h3 id={id} className={host === 'column' ? ASK_SECTION_HEADING : 'text-sm font-medium text-foreground'}>
        Good to know
      </h3>
      <ul className="flex flex-col gap-2.5">
        <Fact icon={Coins} title="Cost.">
          Google’s free key costs nothing. It has a daily limit, and AI pauses until Google resets it. dsul never
          charges for AI.
        </Fact>
        <Fact icon={Send} title="What’s sent.">
          Only when you ask: your question and the parts of your plan it needs, from dsul’s server to Google. On the
          free plan, Google may use it to improve its products.
        </Fact>
        <Fact icon={KeyRound} title="Your key.">
          Stored encrypted on dsul’s server and never shown again, not even to you.
        </Fact>
        <Fact icon={Undo2} title="Taking it back.">
          {host === 'column' ? (
            <>
              Disconnect any time in{' '}
              <Link href={AI_SETTINGS_PATH} className={cn(QUIET_LINK, 'underline')}>
                Settings → AI
              </Link>
              , and dsul deletes the key.
            </>
          ) : (
            'Disconnect here any time, and dsul deletes the key.'
          )}
        </Fact>
      </ul>
    </section>
  );
}

/**
 * Good to know, once something is connected (Settings → AI, under the
 * Connection card): the same four facts in the connection's own words
 * (`goodToKnowCopy`), folded to one row. Folded on every visit, and never
 * remembered: it is reference, not a setting.
 */
export function GoodToKnowConnected({ model }: { model: ModelConnectionView }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const copy = goodToKnowCopy(model);
  return (
    <div data-testid="connect-good-to-know-connected" className="flex flex-col rounded-[8px] border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        data-testid="good-to-know-toggle"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-3 rounded-t-[7px] px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          !open && 'rounded-b-[7px]'
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Good to know</span>
          <span className="text-xs leading-snug text-muted-foreground">
            Cost, what’s sent, your key, and taking it back
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && (
        <ul id={bodyId} data-testid="good-to-know-body" className="flex flex-col gap-2.5 px-4 pt-1 pb-4">
          <Fact icon={Coins} title="Cost.">
            {copy.cost}
          </Fact>
          <Fact icon={Send} title="What’s sent.">
            {copy.sent}
          </Fact>
          <Fact icon={KeyRound} title="Your key.">
            {copy.key}
          </Fact>
          <Fact icon={Undo2} title="Taking it back.">
            {copy.back}
          </Fact>
        </ul>
      )}
    </div>
  );
}
