'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpRight, Moon } from 'lucide-react';

import { ConnectAI, GoodToKnowConnected, SwitchService } from '@/components/ai/connect/connect-ai';
import { ConnectFix } from '@/components/ai/connect/connect-fix';
import {
  ANCHOR_CLASS,
  DANGER_TEXT_ACTION,
  TEXT_ACTION,
  ago,
  connectErrorCopy,
  hostOf,
  keyPageLabel,
  labelName,
  limitCopy,
  openRouterStartHref,
  settingAnchor as anchor,
  useInDesktopApp,
  useRefreshOnWindowFocus,
  useResetsAt,
} from '@/components/ai/connect/connect-shared';
import { HoneyNote, KeyPageLink } from '@/components/ai/connect/key-check';
import { KeyField, type KeyFieldHandle } from '@/components/ai/connect/key-field';
import { Button } from '@/components/ui/button';
import { useDisconnect } from './disconnect';
import { ModelPicker } from './model-picker';
import { StatusPill } from './status-pill';
import { useAIConnectionStore, useAICapabilities, type ApiFailure } from '@/lib/ai-connection-store';
import { isPlausibleKey, mismatchedKey, type DetectedProvider } from '@/lib/ai-key-prefix';
import {
  connectionBody,
  connectionPill,
  connectionPillLabel,
  connectionPillTone,
  isAIOff,
  limitInForce,
} from '@/lib/ai-pane-state';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { FLOW_COPY, UNAVAILABLE_COPY, flowSaved, readFlow, type ConnectFlow } from '@/lib/connect-flow';
import { revealChat } from '@/lib/open-chat';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { useMinuteClock } from '@/lib/use-now-minutes';
import {
  AI_SETTINGS_PATH,
  PROVIDER_META,
  type ConnectRequest,
  type ModelConnectionView,
  type ModelProviderId,
} from '@/lib/ai-types';
import { cn } from '@/lib/utils';

// The pane's error words live with the connect card's (components/ai/connect/
// connect-shared.ts); the model picker and its tests still read them here.
export { connectErrorCopy, type ErrorCopyContext } from '@/components/ai/connect/connect-shared';

/**
 * Connection: Settings → AI's model section (pane id 'beacon', at
 * /settings/ai), drawn by the pane body (components/settings/ai-pane.tsx)
 * under "Use AI in dsul".
 *
 * dsul ships no AI of its own. A user brings a provider they already pay for,
 * or a free key from Google. The heading carries one pill for the state
 * ("Not set up", "Checking…", "Working", "Needs attention", "Daily limit ·
 * back at 3 pm"), and under it one body, each decided by a pure function of
 * the connection (lib/ai-pane-state.ts):
 *
 *  - nothing connected: the connect card the setup column shows too
 *    (components/ai/connect/connect-ai.tsx), with its own Good to know;
 *  - working: the provider, when it last answered a test question, the model,
 *    and the band of actions (Replace key, another service, Disconnect);
 *  - a daily limit: when AI comes back, and the same actions but a recheck;
 *  - turned down, or unreadable: the fix card (components/ai/connect/
 *    connect-fix.tsx, host 'pane'), a new key fixed in place.
 *
 * The pill and the body are separate questions: a connect or a recheck in
 * flight turns only the pill to "Checking…", so the card under it (and a key
 * typed into its box) stays mounted while the answer is out. Once something
 * is connected, a folded Good to know follows the card. While AI is off for
 * the account the section draws nothing at all (the pane's AI-off card says
 * what is still connected), though it still asks the server on mount.
 *
 * The key goes to the server once, is sealed there, and never comes back: not
 * into a store, not into the URL, not masked, not as a last four. Between
 * paste and send it lives only in the key box's value
 * (components/ai/connect/key-field.tsx, uncontrolled, so never in an
 * attribute). A key that fails stays there to be fixed; one that works is
 * emptied out at once, and so is the box on a provider change and on unmount.
 *
 * Bespoke rather than manifest rows (the ShortcutsPanel / ExtensionHero
 * precedent): connecting is a form with states, not a value. The two records
 * it stands in for, `beacon.apiKey` and `beacon.model`, stay in the manifest
 * so search still finds them, and `?focus=` (a search hit's "Set up" opens
 * it) lands here, on the `data-setting-alias` anchors below. Every state the
 * section draws carries both anchors exactly once.
 *
 * Mounting re-asks the server (`refresh()`, past the dedupe window). This pane
 * is where an OpenClaw user lands after pairing, and where a model connected on
 * another device first shows up, so it must never show a five-minute-old answer.
 */

/** A quiet link in a band of text actions: one size with TextAction. */
const QUIET_LINK = TEXT_ACTION;

function UseOpenClawLink() {
  return (
    <Link href="/docs/openclaw" data-testid="mcp-use-openclaw" className={cn(QUIET_LINK, 'self-start')}>
      Use OpenClaw instead
    </Link>
  );
}

/** A text-sized action in a band of them ("Check again", "Replace key", "Disconnect"). */
function TextAction({
  onClick,
  disabled,
  children,
  testId,
  danger = false,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId?: string;
  /** Disconnect: red text, no border, no wash. */
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        danger ? DANGER_TEXT_ACTION : TEXT_ACTION,
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {children}
    </button>
  );
}

/* ── The panel ──────────────────────────────────────────────────────────── */

export function ModelConnectionPanel({
  isMobile = false,
  highlightId = null,
}: {
  isMobile?: boolean;
  /** The shell's deep-link ring, so `?focus=` lands visibly on an anchor here. */
  highlightId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const phase = useAIConnectionStore((s) => s.phase);
  const available = useAIConnectionStore((s) => s.available);
  const model = useAIConnectionStore((s) => s.model);
  const aiHidden = useAIConnectionStore((s) => s.aiHidden);
  const busy = useAIConnectionStore((s) => s.busy);
  const chatTarget = useAISettingsStore((s) => s.chatTarget);
  const { canChat } = useAICapabilities();
  // The display reads the store's own model (the gate zeroes `limitedUntil`),
  // and this clock re-renders it each minute, so a daily limit lifts on time.
  const nowMs = useMinuteClock();
  const resetsAtOf = useResetsAt();

  // Read ONCE: the URL is cleaned right after, and the notice has to outlive that.
  const [flow, setFlow] = useState<ConnectFlow | null>(() => readFlow(searchParams?.get('connect')));
  // `?start=openrouter` (the desktop app's copied link, connect-shared.ts
  // `desktopSignInLink`): the connect card opens on OpenRouter's sign-in, its
  // button focused. Only ever an unfold, never a sign-in by itself, and only
  // for the first connect card: once something is connected it is spent.
  const [start, setStart] = useState<'openrouter' | undefined>(() =>
    searchParams?.get('start') === 'openrouter' ? 'openrouter' : undefined
  );
  if (start && model) setStart(undefined);
  const [justConnected, setJustConnected] = useState(false);
  const flowHandled = useRef(false);
  // What the band's last action was refused with: Check again's answer, or
  // Disconnect's (useDisconnect keeps that one). Only the latest is said.
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<'recheck' | 'disconnect' | null>(null);
  const disconnect = useDisconnect(model);

  useEffect(() => {
    void useAIConnectionStore.getState().refresh();
  }, []);

  // In the desktop app an OpenRouter sign-in happens in the browser
  // (useInDesktopApp), so the connection it makes lands while this pane sits
  // open behind it.
  useRefreshOnWindowFocus();

  // …but no longer than the state it reports. The notice says how ONE
  // OpenRouter round trip ended; the next connect, check or disconnect gives a
  // newer answer, which the card below shows, so the notice goes the moment
  // one starts. A model pick keeps it: it changes nothing the notice says.
  // Subscribed rather than read through a selector, so a write that starts
  // and settles between two renders is still seen.
  useEffect(() => {
    if (!flow) return;
    return useAIConnectionStore.subscribe((s) => {
      if (s.busy === 'connect' || s.busy === 'recheck' || s.busy === 'disconnect') setFlow(null);
    });
  }, [flow]);

  useEffect(() => {
    if (!flow || flowHandled.current) return;
    flowHandled.current = true;
    // The callback saved the connection server-side; ask for it. (The mount
    // refresh is usually still in flight, and this joins it.)
    if (flowSaved(flow)) void useAIConnectionStore.getState().refresh();
    // The address the pane was reached by, /settings/ai or the permanent
    // /settings/beacon, minus the query.
    router.replace(pathname || AI_SETTINGS_PATH);
  }, [flow, router, pathname]);

  // A daily limit lifts on the clock, and the server is asked once, on that
  // edge: the ref holds the `limitedUntil` in force, and only when the clock
  // passes that same value is there a refresh. A disconnect or another model
  // changes the value under it (re-pointed or dropped, no refresh), and a
  // mount with no limit never asks for this.
  const limited = limitInForce(model, nowMs);
  const limitedUntil = model?.limitedUntil ?? null;
  const limitSeen = useRef<string | null>(null);
  useEffect(() => {
    if (limited) {
      limitSeen.current = limitedUntil;
      return;
    }
    const seen = limitSeen.current;
    limitSeen.current = null;
    if (seen !== null && seen === limitedUntil) void useAIConnectionStore.getState().refresh();
  }, [limited, limitedUntil]);

  // AI is off for the account: the pane's own card says so, and what is
  // still connected. Every hook above has run, so the mount still asked.
  if (isAIOff({ phase, aiHidden })) return null;

  const unavailableHere = phase === 'ready' && !available;
  // The `!available` body already says this, in the same words.
  const showFlow = flow !== null && !(flow === 'unavailable' && unavailableHere);

  const pill = connectionPill({ phase, available, model, busy }, nowMs);
  const kind = connectionBody({ phase, available, model }, nowMs);

  const recheck = async () => {
    if (!model) return;
    const name = labelName(model.provider, model.baseUrl);
    setLastAction('recheck');
    setRecheckError(null);
    const result = await useAIConnectionStore.getState().recheck();
    if (!result.ok) {
      setRecheckError(connectErrorCopy(result.code, name, { during: 'recheck', field: result.field }));
    }
  };
  const askDisconnect = () => {
    setLastAction('disconnect');
    disconnect.ask();
  };
  const actionError =
    lastAction === 'disconnect' ? disconnect.error : lastAction === 'recheck' ? recheckError : null;
  const onConnected = () => setJustConnected(true);

  let body: React.ReactNode;
  if (kind === 'checking') {
    body = <CheckingCard highlightId={highlightId} />;
  } else if (kind === 'failed') {
    body = <CheckFailedCard highlightId={highlightId} />;
  } else if (kind === 'unavailable') {
    body = <UnavailableCard highlightId={highlightId} />;
  } else if (kind === 'connect' || !model) {
    // The connect card's key box carries `beacon.apiKey` itself.
    body = (
      <div {...anchor('beacon.model', highlightId)} className={ANCHOR_CLASS} data-testid="mcp-connect-fresh">
        <ConnectAI host="pane" highlightId={highlightId} onConnected={onConnected} unfold={start} />
      </div>
    );
  } else if (kind === 'fix') {
    body = (
      <FixCard model={model} highlightId={highlightId} onConnected={onConnected} onDisconnect={askDisconnect} />
    );
  } else if (kind === 'limit') {
    body = (
      <LimitCard model={model} highlightId={highlightId} onConnected={onConnected} onDisconnect={askDisconnect} />
    );
  } else {
    body = (
      <WorkingCard
        model={model}
        isMobile={isMobile}
        highlightId={highlightId}
        justConnected={justConnected}
        onConnected={onConnected}
        onRecheck={() => void recheck()}
        onDisconnect={askDisconnect}
      />
    );
  }
  // The cards for a saved connection, under which its status lines sit.
  const connected = model !== null && (kind === 'working' || kind === 'limit' || kind === 'fix');

  return (
    <section
      data-testid="model-connection-panel"
      aria-labelledby="mcp-title"
      className="mt-2 mb-4 flex flex-col gap-3 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="mcp-title" className="text-foreground text-sm font-medium">
          Connection
        </h3>
        {pill && (
          <StatusPill testId="mcp-status" tone={connectionPillTone(pill, canChat)}>
            {connectionPillLabel(pill, pill === 'daily_limit' ? resetsAtOf(limitedUntil) : null)}
          </StatusPill>
        )}
      </div>
      {showFlow && (
        <p
          role={flow === 'ok' ? 'status' : 'alert'}
          data-testid="mcp-flow-notice"
          data-flow={flow}
          className={cn(
            'rounded-[6px] px-3 py-2 text-xs',
            flow === 'ok' ? 'bg-secondary text-foreground' : 'bg-destructive/10 text-foreground'
          )}
        >
          {FLOW_COPY[flow]}
        </p>
      )}
      {body}
      {connected && actionError && (
        <p role="alert" className="text-destructive text-xs" data-testid="mcp-error">
          {actionError}
        </p>
      )}
      {connected && chatTarget === 'none' && (
        <p className="text-muted-foreground text-xs" data-testid="mcp-chat-off">
          Chat is off on this device. Change it under Who answers in chat below.
        </p>
      )}
      {model && <GoodToKnowConnected model={model} />}
    </section>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('border-border flex flex-col gap-4 rounded-[8px] border p-4', className)}>
      {children}
    </div>
  );
}

/* ── Not-yet-known states ───────────────────────────────────────────────── */

/** Both anchors around a card that has nothing more specific to point at. */
function AnchoredCard({
  highlightId,
  className,
  children,
}: {
  highlightId: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div {...anchor('beacon.model', highlightId)} className={ANCHOR_CLASS}>
      <div {...anchor('beacon.apiKey', highlightId)} className={ANCHOR_CLASS}>
        <Card className={className}>{children}</Card>
      </div>
    </div>
  );
}

function CheckingCard({ highlightId }: { highlightId: string | null }) {
  return (
    <AnchoredCard highlightId={highlightId} className="min-h-[176px] items-center justify-center">
      <p aria-live="polite" className="text-muted-foreground text-xs" data-testid="mcp-checking">
        Checking your AI connection…
      </p>
    </AnchoredCard>
  );
}

function CheckFailedCard({ highlightId }: { highlightId: string | null }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <AnchoredCard highlightId={highlightId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="alert" className="text-foreground text-sm">
          Couldn’t check your AI connection.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void useAIConnectionStore
              .getState()
              .refresh()
              .finally(() => setRetrying(false));
          }}
        >
          {retrying ? 'Checking…' : 'Try again'}
        </Button>
      </div>
    </AnchoredCard>
  );
}

function UnavailableCard({ highlightId }: { highlightId: string | null }) {
  return (
    <AnchoredCard highlightId={highlightId}>
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-sm" data-testid="mcp-unavailable">
          {UNAVAILABLE_COPY}
        </p>
        {process.env.NODE_ENV === 'development' && (
          <p className="text-muted-foreground font-num text-xs">
            Set MODEL_KEYS_ENCRYPTION_KEY and restart.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">OpenClaw still works without it.</p>
        <UseOpenClawLink />
      </div>
    </AnchoredCard>
  );
}

/* ── Key form pieces ──────────────────────────────────────────────────── */

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-foreground text-xs font-medium">
      {children}
    </label>
  );
}

/** What a form's last send was refused with: the route's answer, or the same words for one refused here. */
type FormFailure = Pick<ApiFailure, 'code' | 'field' | 'detected' | 'limitedUntil'> & {
  /** The provider as the pane names it, for the copy. */
  name: string;
  /** The form was for Other. */
  custom: boolean;
};

/**
 * Refused before it leaves the page: something that can't be a key, or a key
 * that reads as another company's (lib/ai-key-prefix.ts). The route refuses
 * both again; this only spares a round trip, and keeps a key from ever going
 * to a company it was not made for.
 */
function refuseHere(provider: ModelProviderId, key: string): Pick<ApiFailure, 'code' | 'field' | 'detected'> | null {
  if (!isPlausibleKey(key)) return { code: 'invalid', field: 'apiKey' };
  const detected: DetectedProvider | null = mismatchedKey(provider, key);
  return detected ? { code: 'wrong_provider', detected } : null;
}

function FormError({ error }: { error: FormFailure }) {
  const resetsAtOf = useResetsAt();
  return (
    <p role="alert" className="text-destructive text-xs" data-testid="mcp-error">
      {connectErrorCopy(error.code, error.name, {
        custom: error.custom,
        field: error.field ?? null,
        detected: error.detected ?? null,
        resetsAt: resetsAtOf(error.limitedUntil),
      })}
    </p>
  );
}

/* ── Connected ──────────────────────────────────────────────────────────── */

function ReplaceKeyForm({
  model,
  onDone,
}: {
  model: ModelConnectionView;
  onDone: () => void;
}) {
  const uid = useId();
  const busy = useAIConnectionStore((s) => s.busy === 'connect');
  const field = useRef<KeyFieldHandle>(null);
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState<FormFailure | null>(null);
  const name = labelName(model.provider, model.baseUrl);
  const keyHelpUrl = PROVIDER_META[model.provider].keyHelpUrl;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!hasKey || busy) return;
    field.current?.focus();
    const key = field.current?.read() ?? '';
    setError(null);
    const refused = refuseHere(model.provider, key);
    if (refused) {
      setError({ ...refused, name, custom: false });
      return;
    }
    // Same provider and host; the model rides along so a new key does not
    // quietly swap the user's pick for the provider's default.
    const req: ConnectRequest = { provider: model.provider, apiKey: key };
    if (model.baseUrl) req.baseUrl = model.baseUrl;
    if (model.model) req.model = model.model;
    const result = await useAIConnectionStore.getState().connect(req);
    if (result.ok) {
      field.current?.clear();
      onDone();
    } else {
      const { code, field: named, detected, limitedUntil } = result;
      setError({ code, field: named, detected, limitedUntil, name, custom: false });
    }
  };

  const keyId = `${uid}-key`;
  return (
    <form
      onSubmit={submit}
      aria-busy={busy || undefined}
      aria-label="Replace key"
      className="flex flex-col gap-1.5"
      data-testid="mcp-replace-form"
    >
      <FieldLabel htmlFor={keyId}>New API key</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <KeyField
          ref={field}
          id={keyId}
          placeholder={PROVIDER_META[model.provider].keyPlaceholder}
          checking={busy}
          describedBy={`${keyId}-help`}
          testId="mcp-replace-key"
          className="w-full max-w-[300px]"
          onChange={(key) => setHasKey(key !== '')}
          onPaste={() => setHasKey(true)}
          onEnter={() => void submit()}
        />
        <Button type="submit" size="sm" disabled={busy || !hasKey}>
          {busy ? 'Checking key…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p id={`${keyId}-help`} className="text-muted-foreground text-[11px]" data-testid="mcp-replace-help">
        {/* Only a working key "keeps working": in the failing states the card
            above has just said the saved one stopped. */}
        {model.status === 'ok'
          ? 'The new key replaces the old one. Your current one keeps working until this one passes.'
          : `Paste a new key from ${name}. It’s checked before it’s saved.`}
      </p>
      {keyHelpUrl && (
        <a
          href={keyHelpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(QUIET_LINK, 'inline-flex items-center gap-1 self-start')}
        >
          Get a key from {PROVIDER_META[model.provider].label}
          <ArrowUpRight className="size-3" aria-hidden />
        </a>
      )}
      {error && <FormError error={error} />}
    </form>
  );
}

/* ── Connected ──────────────────────────────────────────────────────────── */

/**
 * The desktop's way in, once a model is connected: Ask starts closed
 * (sidebar-store ASK_OPEN_DEFAULT), so the line names each way to open it,
 * the Ask button on the canvas's header row, the chord as the user has it
 * bound (chordLabel reads "Ctrl+J" on a PC and the Mac's own symbols there,
 * and follows a rebinding; never typed by hand) and `?` in the dock. The
 * phone has no chord and its own Ask tab, and keeps the dock sentence.
 */
function JustConnectedDesktop() {
  const keys = useShortcutKeys('toggle_right_sidebar');
  const chord = chordLabel(keys, isApplePlatform());
  return <>Connected. Open Ask with the Ask button or {chord}, or type ? in the dock, to ask anything.</>;
}

/** "Key saved", or "Signed in" for an OpenRouter sign-in. */
const authWord = (model: ModelConnectionView) => (model.authMethod === 'oauth' ? 'Signed in' : 'Key saved');

/** The provider, as the card names it: "Google Gemini", or "Other · api.groq.com". Never the raw model id. */
function ProviderLine({ model }: { model: ModelConnectionView }) {
  const host = model.provider === 'custom' ? hostOf(model.baseUrl) : null;
  return (
    <p className="text-foreground truncate text-sm font-medium" data-testid="mcp-provider">
      {PROVIDER_META[model.provider].label}
      {host && <span className="text-muted-foreground font-normal"> · {host}</span>}
    </p>
  );
}

/** Who is connected and how it stands: where `beacon.apiKey` lands while the key works. */
function HeaderBand({
  model,
  highlightId,
  children,
}: {
  model: ModelConnectionView;
  highlightId: string | null;
  /** The sub-line under the name. */
  children: React.ReactNode;
}) {
  return (
    <div
      {...anchor('beacon.apiKey', highlightId)}
      className={cn('-mx-2 -my-1 flex min-w-0 flex-col px-2 py-1', ANCHOR_CLASS)}
    >
      <ProviderLine model={model} />
      <p className="text-muted-foreground text-xs" data-testid="mcp-subline">
        {children}
      </p>
    </div>
  );
}

/** Which of the provider's models answers: where `beacon.model` lands. */
function ModelBand({ model, highlightId }: { model: ModelConnectionView; highlightId: string | null }) {
  const busy = useAIConnectionStore((s) => s.busy);
  const name = labelName(model.provider, model.baseUrl);
  const needsModel = !model.model;

  // Prefetch the list so the picker opens onto models, not a spinner. Only
  // for a working key: listing with a refused one is a wasted provider call.
  useEffect(() => {
    if (model.status === 'ok') void useAIConnectionStore.getState().loadModels();
  }, [model.provider, model.baseUrl, model.status]);

  return (
    <div className="border-border grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-4">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">Model</p>
        <p className="text-muted-foreground text-xs" data-testid="mcp-model-hint">
          {needsModel ? 'Pick a model to finish connecting.' : 'Answers in Ask and drafts your plans.'}
        </p>
      </div>
      <div
        {...anchor('beacon.model', highlightId)}
        className={cn('flex min-w-0 max-w-[260px] justify-end', ANCHOR_CLASS)}
      >
        <ModelPicker
          defaultOpen={needsModel}
          disabled={busy !== null && busy !== 'model'}
          errorCopy={(code, field) => connectErrorCopy(code, name, { during: 'model', field })}
        />
      </div>
    </div>
  );
}

/** Disconnect: red text, no border and no wash; the confirm carries the destructive button. */
function DisconnectAction({ onClick, className }: { onClick: () => void; className?: string }) {
  const busy = useAIConnectionStore((s) => s.busy);
  return (
    <TextAction danger onClick={onClick} disabled={busy !== null} testId="mcp-disconnect" className={className}>
      {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
    </TextAction>
  );
}

/** The band of actions: the card's own on the left, Disconnect on the right. */
function ActionsBand({
  children,
  onDisconnect,
  hairline = true,
}: {
  children: React.ReactNode;
  onDisconnect: () => void;
  hairline?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
        hairline && 'border-border border-t pt-4'
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
      <DisconnectAction onClick={onDisconnect} />
    </div>
  );
}

/**
 * "Use a different service": the connect card's own folds (SwitchService,
 * components/ai/connect/connect-ai.tsx), a key from anyone placed by its
 * prefix, another service, or OpenRouter's sign-in, in place of the connection
 * there is. The saved one stays until the new one works.
 */
function SwitchPanel({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="border-border flex flex-col gap-3 border-t pt-4" data-testid="mcp-switch-panel">
      <div>
        <p className="text-foreground text-sm font-medium">Switch service</p>
        <p className="text-muted-foreground text-xs">Connecting a different service replaces this one.</p>
      </div>
      <SwitchService onConnected={onConnected} />
    </div>
  );
}

/**
 * Working (F19), and saved with no model picked yet: three bands split by
 * hairlines. Who is connected and when it last answered a test question, with
 * Check again; the model; and the actions.
 */
function WorkingCard({
  model,
  isMobile,
  highlightId,
  justConnected,
  onConnected,
  onRecheck,
  onDisconnect,
}: {
  model: ModelConnectionView;
  isMobile: boolean;
  highlightId: string | null;
  justConnected: boolean;
  onConnected: () => void;
  onRecheck: () => void;
  onDisconnect: () => void;
}) {
  const router = useRouter();
  const busy = useAIConnectionStore((s) => s.busy);
  const caps = useAICapabilities();
  const [mode, setMode] = useState<'idle' | 'replace' | 'switch'>('idle');
  const oauth = model.authMethod === 'oauth';
  // A sign-in is renewed by signing in again, except in the desktop app, where
  // that flow can't finish (useInDesktopApp).
  const inDesktopApp = useInDesktopApp();
  const signInAgain = oauth && !inDesktopApp;
  const answered = ago(model.checkedAt);

  return (
    <Card>
      <HeaderBand model={model} highlightId={highlightId}>
        {authWord(model)}
        {answered && <> · answered a test question {answered}</>}
        {' · '}
        {/* Underlined at rest: a link inside a sentence needs more than colour. */}
        <TextAction onClick={onRecheck} disabled={busy !== null} testId="mcp-recheck" className="underline">
          {busy === 'recheck' ? 'Checking…' : 'Check again'}
        </TextAction>
      </HeaderBand>

      <ModelBand model={model} highlightId={highlightId} />

      <ActionsBand onDisconnect={onDisconnect}>
        {signInAgain ? (
          <a href={openRouterStartHref('settings')} data-testid="mcp-signin-again" className={QUIET_LINK}>
            Sign in again
          </a>
        ) : (
          !oauth && (
            <TextAction onClick={() => setMode(mode === 'replace' ? 'idle' : 'replace')} testId="mcp-replace">
              Replace key
            </TextAction>
          )
        )}
        <TextAction onClick={() => setMode(mode === 'switch' ? 'idle' : 'switch')} testId="mcp-switch">
          Use a different service
        </TextAction>
      </ActionsBand>

      {justConnected && caps.canChat && caps.target === 'model' && (
        <div
          role="status"
          data-testid="mcp-just-connected"
          className="bg-secondary flex flex-wrap items-center justify-between gap-2 rounded-[6px] px-3 py-2"
        >
          <p className="text-foreground text-xs">
            {isMobile ? 'Connected. Type ? in the dock to ask anything.' : <JustConnectedDesktop />}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              revealChat(isMobile);
              router.push('/');
            }}
          >
            Try it
          </Button>
        </div>
      )}

      {mode === 'replace' && !signInAgain && <ReplaceKeyForm model={model} onDone={() => setMode('idle')} />}

      {mode === 'switch' && (
        <SwitchPanel
          onConnected={() => {
            setMode('idle');
            onConnected();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Today's limit is used up (F21): when AI comes back, on the planner's own
 * clock, and what raises the limit. No Check again (it would only meet the
 * limit) and no Replace key; Disconnect stays, so Good to know's "Disconnect
 * above" is true here too.
 */
function LimitCard({
  model,
  highlightId,
  onConnected,
  onDisconnect,
}: {
  model: ModelConnectionView;
  highlightId: string | null;
  onConnected: () => void;
  onDisconnect: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  const resetsAtOf = useResetsAt();
  const copy = limitCopy(model, resetsAtOf(model.limitedUntil));
  const keyPage = model.authMethod === 'key' ? PROVIDER_META[model.provider].keyHelpUrl : null;

  return (
    <Card>
      <div data-testid="mcp-limit" className="flex flex-col gap-4">
        <HeaderBand model={model} highlightId={highlightId}>
          {authWord(model)} · today’s limit is used up
        </HeaderBand>
        {/* A resting note, not an alert: it is the card's state on every load. */}
        <HoneyNote icon={Moon} role={null} testId="mcp-limit-note" text={copy.note} />
        <p className="text-muted-foreground text-xs" data-testid="mcp-limit-paid">
          {copy.paid}
        </p>
        <ActionsBand onDisconnect={onDisconnect} hairline={false}>
          {keyPage && (
            <KeyPageLink href={keyPage} label={keyPageLabel(model.provider, model.baseUrl)} className="self-auto" />
          )}
          <TextAction onClick={() => setSwitching(!switching)} testId="mcp-switch">
            Use a different service
          </TextAction>
        </ActionsBand>
        <ModelBand model={model} highlightId={highlightId} />
      </div>
      {switching && (
        <SwitchPanel
          onConnected={() => {
            setSwitching(false);
            onConnected();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Turned down, or no longer readable (F20): the fix card, fixed in place
 * (components/ai/connect/connect-fix.tsx on its pane host), with this pane's
 * own actions in its band. No model band: a refused key lists no models.
 */
function FixCard({
  model,
  highlightId,
  onConnected,
  onDisconnect,
}: {
  model: ModelConnectionView;
  highlightId: string | null;
  onConnected: () => void;
  onDisconnect: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  return (
    <Card>
      <ConnectFix
        host="pane"
        model={model}
        highlightId={highlightId}
        paneActions={
          <>
            {/* A key turned down may be the provider's doing, not the key's
                (no credit, a region it won't answer): another service is a
                way out that keeps the saved connection until the new one works. */}
            <TextAction onClick={() => setSwitching(!switching)} testId="mcp-switch">
              Use a different service
            </TextAction>
            <DisconnectAction onClick={onDisconnect} className="ml-auto" />
          </>
        }
      />
      {switching && (
        <SwitchPanel
          onConnected={() => {
            setSwitching(false);
            onConnected();
          }}
        />
      )}
    </Card>
  );
}
