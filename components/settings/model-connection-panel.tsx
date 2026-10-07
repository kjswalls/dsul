'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { ArrowUpRight } from 'lucide-react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ModelPicker } from './model-picker';
import { useAIConnectionStore, useAICapabilities } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { revealChat } from '@/lib/open-chat';
import { serverSaysHidden } from '@/lib/no-ai';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { getDesktopBridge } from '@/lib/desktop';
import { useUIStore } from '@/lib/ui-store';
import {
  MODEL_PROVIDERS,
  PROVIDER_META,
  isModelId,
  type ApiErrorCode,
  type ConnectRequest,
  type ModelConnectionView,
  type ModelProviderId,
} from '@/lib/ai-types';
import { cn } from '@/lib/utils';

/**
 * Connect a model: the top of the AI settings pane (pane id 'beacon').
 *
 * dsul ships no AI of its own. A user brings a provider they already pay for,
 * and this is the one place that happens: paste a key (OpenAI, Anthropic,
 * Google Gemini, OpenRouter, or any OpenAI-compatible service) or sign in with
 * OpenRouter. The key goes to the server once, is sealed there, and never
 * comes back: not into a store, not into the URL, not masked, not as a last
 * four. It lives in this component's state only between keystroke and submit,
 * and is cleared on every submit, on a provider change and on unmount.
 *
 * Bespoke rather than manifest rows (the ShortcutsPanel / ExtensionHero
 * precedent): connecting is a form with states, not a value. The two records
 * it stands in for, `beacon.apiKey` and `beacon.model`, stay in the manifest
 * so search still finds them, and `?focus=` (a search hit's "Set up" opens
 * it) lands here, on the `data-setting-alias` anchors below. Every state
 * carries both anchors.
 *
 * Mounting re-asks the server (`refresh()`, past the dedupe window). This pane
 * is where an OpenClaw user lands after pairing, and where a model connected on
 * another device first shows up, so it must never show a five-minute-old answer.
 */

const OPENROUTER_START = '/api/ai/openrouter/start';
const UNAVAILABLE_COPY = 'Connecting a model isn’t available on this server yet.';

const noopSubscribe = () => () => {};
const isDesktopApp = () => getDesktopBridge() !== null;

/**
 * Whether this page is inside the desktop app (electron/). OpenRouter's sign-in
 * can't finish there: the shell sends openrouter.ai to the system browser, and
 * the callback then lands in a browser that has neither the PKCE cookie (it is
 * in the app's cookie jar) nor, often, a dsul session. So the app offers the
 * key path only. A connection belongs to the account, so one made by signing
 * in from a browser works in the app too. Read as app/login/login-page.tsx reads it,
 * so the server render and hydration agree.
 */
function useInDesktopApp(): boolean {
  return useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
}

/** What `/api/ai/openrouter/callback` reports back through `?connect=`. */
type FlowResult = 'ok' | 'denied' | 'expired' | 'failed' | 'busy' | 'unavailable';

const FLOW_COPY: Record<FlowResult, string> = {
  ok: 'Signed in with OpenRouter. You’re connected.',
  denied: 'OpenRouter sign-in was cancelled.',
  expired: 'That sign-in took too long or was already used. Try again.',
  failed: 'Couldn’t finish signing in to OpenRouter. Try again.',
  busy: 'Too many tries. Wait a few minutes and try again.',
  unavailable: UNAVAILABLE_COPY,
};

function readFlow(raw: string | null | undefined): FlowResult | null {
  // Own keys only: `in` would also accept 'constructor' and 'toString'.
  return raw && Object.hasOwn(FLOW_COPY, raw) ? (raw as FlowResult) : null;
}

/** The provider as the copy names it. "Other" says nothing, so a custom host is its hostname. */
function providerName(provider: ModelProviderId, baseUrl?: string | null): string {
  if (provider === 'custom') return hostOf(baseUrl) ?? 'That service';
  return PROVIDER_META[provider].label;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Where an error is shown, which changes what it can honestly say. */
export interface ErrorCopyContext {
  /**
   * 'connect': a form the user typed into (the default). 'recheck': Check
   * again on the connected card. 'model': a pick in the model picker. The last
   * two send no field the user typed, so they never say "the fields": an
   * `invalid` the route pins on `model` is a model the key can't use, and an
   * unnamed one is a request we sent wrong.
   */
  during?: 'connect' | 'recheck' | 'model';
  /** The form was for Other: a base URL the user typed. */
  custom?: boolean;
  /** The field the route said an `invalid` is about, when the answer names one. */
  field?: string | null;
}

/**
 * A custom host answers 404 at a wrong path, which reads as "doesn't list its
 * models" and then as an unknown model. The usual cause is a base URL missing
 * its /v1, so every Other failure that could be that says so.
 */
const BASE_URL_HINT = 'Check the base URL (it usually ends in /v1)';

/** ApiErrorCode → our words. Never a provider's own error text: the routes don't send one. */
export function connectErrorCopy(
  code: ApiErrorCode,
  name: string,
  { during = 'connect', custom = false, field = null }: ErrorCopyContext = {}
): string {
  switch (code) {
    case 'key_rejected':
      return during === 'connect'
        ? `${name} didn’t accept that key. Check that you copied all of it.`
        : `${name} turned down your saved key.`;
    case 'unreachable':
      return `Couldn’t reach ${name}. Try again in a moment.`;
    case 'blocked_url':
      return 'That address isn’t allowed. Use a public https address.';
    case 'model_required':
      return `Nothing at that address listed its models. ${BASE_URL_HINT}, or add a model name above and connect again.`;
    case 'busy':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'invalid':
      if (during !== 'connect') {
        if (field === 'model') return 'That model isn’t available to your key. Pick another.';
        return during === 'model' ? 'Couldn’t save. Try again.' : 'Something went wrong. Try again.';
      }
      if (field === 'apiKey') {
        return 'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.';
      }
      if (field === 'baseUrl') return `${BASE_URL_HINT}.`;
      if (field === 'model') {
        return custom
          ? `Nothing answered for that model at that address. ${BASE_URL_HINT} and the model name.`
          : 'Check the model name and try again.';
      }
      if (!custom) return 'Check the fields and try again.';
      // Unnamed: every field it could be, the likeliest first.
      return `${BASE_URL_HINT}, the model name and the key.`;
    case 'conflict':
      return 'Your connection changed in another tab. Reload this page.';
    case 'unavailable':
      return UNAVAILABLE_COPY;
    default:
      return during === 'model' ? 'Couldn’t save. Try again.' : 'Something went wrong. Try again.';
  }
}

/* ── Deep-link anchors ──────────────────────────────────────────────────── */

type AnchorId = 'beacon.apiKey' | 'beacon.model';

/**
 * Where `?focus=beacon.apiKey` / `beacon.model` land (settings-shell resolves
 * `[data-setting-alias]`, scrolls, focuses and rings it). Focusable but out of
 * the tab order, like a SettingRow.
 */
function anchor(id: AnchorId, highlightId: string | null | undefined) {
  return {
    'data-setting-alias': id,
    'data-highlight': highlightId === id || undefined,
    tabIndex: -1,
  } as const;
}

const ANCHOR_CLASS =
  'rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-ring data-[highlight]:ring-2 data-[highlight]:ring-ring';

const QUIET_LINK =
  'text-muted-foreground hover:text-foreground text-xs underline-offset-4 transition-colors hover:underline ' +
  'focus-visible:ring-ring rounded-[3px] focus-visible:ring-2 focus-visible:outline-none';

function UseOpenClawLink() {
  return (
    <Link href="/docs/openclaw" data-testid="mcp-use-openclaw" className={cn(QUIET_LINK, 'self-start')}>
      Use OpenClaw instead
    </Link>
  );
}

/** A text-sized action in a row of them ("Check again", "Replace key"). */
function TextAction({
  onClick,
  disabled,
  children,
  testId,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(QUIET_LINK, 'disabled:pointer-events-none disabled:opacity-50')}
    >
      {children}
    </button>
  );
}

function StatusPill({ failing }: { failing: boolean }) {
  return (
    <span
      data-testid="mcp-status"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium',
        failing ? 'text-muted-foreground' : 'bg-secondary text-foreground'
      )}
    >
      {/* A dot marks a VALUE (the extension index's rule). Its own element, so
          the lime is never faded through a parent. */}
      <span
        className={cn('size-[6px] rounded-full', failing ? 'bg-destructive' : 'bg-primary')}
        aria-hidden
      />
      {failing ? 'Stopped working' : 'Working'}
    </span>
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
  const searchParams = useSearchParams();
  const phase = useAIConnectionStore((s) => s.phase);
  const available = useAIConnectionStore((s) => s.available);
  const model = useAIConnectionStore((s) => s.model);
  const aiHidden = useAIConnectionStore((s) => s.aiHidden);

  // Read ONCE: the URL is cleaned right after, and the notice has to outlive that.
  const [flow, setFlow] = useState<FlowResult | null>(() => readFlow(searchParams?.get('connect')));
  const [justConnected, setJustConnected] = useState(false);
  const flowHandled = useRef(false);

  useEffect(() => {
    void useAIConnectionStore.getState().refresh();
  }, []);

  // In the desktop app an OpenRouter sign-in happens in the browser
  // (useInDesktopApp), so the connection it makes lands while this pane sits
  // open behind it. Ask again when the window comes back to the front.
  useEffect(() => {
    if (!getDesktopBridge()) return;
    const ask = () => void useAIConnectionStore.getState().refresh();
    window.addEventListener('focus', ask);
    return () => window.removeEventListener('focus', ask);
  }, []);

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
    if (flow === 'ok') void useAIConnectionStore.getState().refresh();
    router.replace('/settings/beacon');
  }, [flow, router]);

  const unavailableHere = phase === 'ready' && !available;
  const aiOff = phase === 'ready' && available && aiHidden === true;
  // The `!available` body already says this, in the same words.
  const showFlow = flow !== null && !(flow === 'unavailable' && unavailableHere);

  let body: React.ReactNode;
  if (phase === 'unknown') {
    body = <CheckingCard highlightId={highlightId} />;
  } else if (phase === 'error') {
    body = <CheckFailedCard highlightId={highlightId} />;
  } else if (!available) {
    body = <UnavailableCard highlightId={highlightId} />;
  } else if (!model) {
    body = (
      <div {...anchor('beacon.model', highlightId)} className={ANCHOR_CLASS}>
        <Card>
          <ConnectForm
            variant="fresh"
            highlightId={highlightId}
            onConnected={() => setJustConnected(true)}
          />
        </Card>
      </div>
    );
  } else {
    body = (
      <ConnectedCard
        model={model}
        isMobile={isMobile}
        highlightId={highlightId}
        justConnected={justConnected}
        onConnected={() => setJustConnected(true)}
      />
    );
  }

  return (
    <section
      data-testid="model-connection-panel"
      aria-labelledby="mcp-title"
      className="mt-2 mb-4 flex flex-col gap-3 focus:outline-none"
    >
      <h3 id="mcp-title" className="text-foreground text-sm font-medium">
        Connect a model
      </h3>
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
      {aiOff && <AIOffCard />}
      {body}
    </section>
  );
}

/**
 * "No AI, thanks" said for the account (`user_settings.ai_hidden`, lib/no-ai.ts).
 * The way back until this pane's own "Use AI in dsul" switch arrives (AI
 * setup PR 7): the undo strip's Undo lasts five seconds, and nothing else
 * turns AI back on. What sits below stays as it is, since a key connected
 * while AI is off is kept and answers once it is back on, so the card is
 * also what says why nothing lights up meanwhile.
 */
function AIOffCard() {
  const ref = useRef<HTMLDivElement>(null);
  const turnOn = async () => {
    // Applied at once, so the card goes with focus on its button: hand focus
    // to the panel first, rather than to <body>.
    const panel = ref.current?.closest<HTMLElement>('[data-testid="model-connection-panel"]');
    if (panel) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
    const result = await useAIConnectionStore.getState().setAIHidden(false);
    // Settled by what the server says, not the failure: a dropped connection
    // can lose the answer to a write that landed (lib/no-ai.ts).
    if (!result.ok && (await serverSaysHidden())) toast.error(AI_BACK_ON_FAILED);
  };
  return (
    <div ref={ref} data-testid="mcp-ai-off" className="border-border flex flex-col gap-3 rounded-[8px] border p-4">
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-sm font-medium">AI is off</p>
        <p className="text-muted-foreground text-xs">
          dsul won’t show AI or bring it up again until you turn it back on here. Your planner works exactly the same.
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void turnOn()}>
        Turn AI back on
      </Button>
    </div>
  );
}

export const AI_BACK_ON_FAILED = 'Couldn’t turn AI back on just now. Try again in a moment.';

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

/* ── Connect form ───────────────────────────────────────────────────────── */

function ProviderChips({
  value,
  onChange,
  disabled,
}: {
  value: ModelProviderId;
  onChange: (next: ModelProviderId) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // A radiogroup moves with the arrow keys, and only the checked radio is in
  // the tab order (WAI-ARIA radio group pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = MODEL_PROVIDERS.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(MODEL_PROVIDERS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Provider" className="flex flex-wrap gap-1.5" data-testid="mcp-providers">
      {MODEL_PROVIDERS.map((p, i) => {
        const checked = p === value;
        return (
          <Button
            key={p}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            variant="outline"
            size="sm"
            disabled={disabled}
            data-provider={p}
            onClick={() => onChange(p)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'h-7 px-2.5 text-xs font-normal',
              checked
                ? 'border-foreground/25 bg-secondary text-foreground dark:bg-secondary font-medium'
                : 'text-muted-foreground'
            )}
          >
            {PROVIDER_META[p].label}
          </Button>
        );
      })}
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-foreground text-xs font-medium">
      {children}
    </label>
  );
}

/** Attributes every key field carries: never autofilled, never remembered, never spellchecked. */
const KEY_FIELD_PROPS = {
  type: 'password',
  name: 'model-api-key',
  autoComplete: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
} as const;

function ConnectForm({
  variant,
  highlightId,
  exclude,
  onConnected,
}: {
  /** 'fresh': nothing is connected. 'switch': replacing the connection there is. */
  variant: 'fresh' | 'switch';
  highlightId: string | null;
  /** The provider already connected, so 'switch' does not preselect it. */
  exclude?: ModelProviderId;
  onConnected: () => void;
}) {
  const uid = useId();
  const busy = useAIConnectionStore((s) => s.busy === 'connect');
  const inDesktopApp = useInDesktopApp();
  const [provider, setProvider] = useState<ModelProviderId>(
    () => MODEL_PROVIDERS.find((p) => p !== exclude) ?? 'openai'
  );
  // The key exists only here, between keystroke and submit.
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [error, setError] = useState<{ code: ApiErrorCode; name: string; field: string | null } | null>(
    null
  );

  const custom = provider === 'custom';
  const meta = PROVIDER_META[provider];
  const typedModel = modelName.trim();
  const modelOk = typedModel === '' || isModelId(typedModel);
  const ready =
    apiKey.trim() !== '' && (!custom || baseUrl.trim() !== '') && (!custom || modelOk) && !busy;

  const choose = (next: ModelProviderId) => {
    if (next === provider) return;
    setProvider(next);
    setApiKey('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const req: ConnectRequest = { provider, apiKey: apiKey.trim() };
    if (custom) {
      req.baseUrl = baseUrl.trim();
      if (typedModel) req.model = typedModel;
    }
    const name = providerName(provider, req.baseUrl);
    // Gone from the field before the request is even out, whatever it answers.
    setApiKey('');
    setError(null);
    const result = await useAIConnectionStore.getState().connect(req);
    if (result.ok) onConnected();
    else setError({ code: result.code, name, field: result.field ?? null });
  };

  const keyId = `${uid}-key`;
  const urlId = `${uid}-url`;
  const modelId = `${uid}-model`;

  return (
    <div className="flex flex-col gap-4" data-testid={`mcp-connect-${variant}`}>
      {variant === 'fresh' && (
        <p className="text-muted-foreground max-w-[60ch] text-xs leading-relaxed">
          dsul doesn’t include AI. Use a provider you already have. Your key is stored encrypted on
          our server, used only to answer you, and never shown again.
        </p>
      )}

      {inDesktopApp ? (
        <p
          className="text-muted-foreground max-w-[60ch] text-xs leading-relaxed"
          data-testid="mcp-openrouter-browser"
        >
          To sign in with OpenRouter instead of pasting a key, connect from dsul in your browser.
          The connection works here too.
        </p>
      ) : (
        <>
          <div className="bg-secondary/60 flex flex-col gap-3 rounded-[6px] p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Sign in with OpenRouter</p>
              <p className="text-muted-foreground text-xs">
                One account for hundreds of models, including free ones. Nothing to copy or paste.
              </p>
            </div>
            <a
              href={OPENROUTER_START}
              data-testid="mcp-openrouter-signin"
              className={cn(buttonVariants({ size: 'sm' }), 'shrink-0 self-start sm:self-auto')}
            >
              Sign in with OpenRouter
            </a>
          </div>

          <div className="flex items-center gap-3" aria-hidden>
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              Or paste a key
            </span>
            <span className="bg-border h-px flex-1" />
          </div>
        </>
      )}

      <form
        onSubmit={submit}
        aria-busy={busy || undefined}
        aria-label="Connect with an API key"
        className="flex flex-col gap-4"
        data-testid="mcp-connect-form"
      >
        <ProviderChips value={provider} onChange={choose} disabled={busy} />

        <div
          {...(variant === 'fresh' ? anchor('beacon.apiKey', highlightId) : {})}
          className={cn('flex flex-col gap-1.5', variant === 'fresh' && ANCHOR_CLASS)}
        >
          <FieldLabel htmlFor={keyId}>API key</FieldLabel>
          <Input
            id={keyId}
            {...KEY_FIELD_PROPS}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={meta.keyPlaceholder}
            disabled={busy}
            data-testid="mcp-key"
            className="h-8 max-w-[360px] text-xs"
          />
          {meta.keyHelpUrl && (
            <a
              href={meta.keyHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(QUIET_LINK, 'inline-flex items-center gap-1 self-start')}
            >
              Get a key from {meta.label}
              <ArrowUpRight className="size-3" aria-hidden />
            </a>
          )}
        </div>

        {custom && (
          <>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={urlId}>Base URL</FieldLabel>
              <Input
                id={urlId}
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-describedby={`${urlId}-help`}
                data-testid="mcp-base-url"
                className="h-8 max-w-[360px] text-xs"
              />
              <p id={`${urlId}-help`} className="text-muted-foreground text-[11px]">
                Any OpenAI-compatible service. Public https addresses only.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={modelId}>Model (optional)</FieldLabel>
              <Input
                id={modelId}
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-describedby={`${modelId}-help`}
                aria-invalid={!modelOk || undefined}
                data-testid="mcp-model-name"
                className="h-8 max-w-[360px] text-xs"
              />
              <p id={`${modelId}-help`} className="text-muted-foreground text-[11px]">
                {modelOk
                  ? 'Only needed if the service doesn’t list its models.'
                  : 'Model names can’t contain spaces.'}
              </p>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="text-destructive text-xs" data-testid="mcp-error">
            {/* `custom` from the provider shown: picking another clears the error. */}
            {connectErrorCopy(error.code, error.name, { custom, field: error.field })}
          </p>
        )}

        <div>
          <Button type="submit" size="sm" disabled={!ready} data-testid="mcp-connect">
            {busy ? 'Checking key…' : 'Connect'}
          </Button>
        </div>
      </form>

      {variant === 'fresh' && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground max-w-[60ch] text-[11px] leading-relaxed">
            You pay your provider directly. When you use AI, your request and the parts of your plan
            it needs go from dsul’s server to that provider.
          </p>
          <UseOpenClawLink />
        </div>
      )}
    </div>
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
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<{ code: ApiErrorCode; field: string | null } | null>(null);
  const name = providerName(model.provider, model.baseUrl);
  const keyHelpUrl = PROVIDER_META[model.provider].keyHelpUrl;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key || busy) return;
    // Same provider and host; the model rides along so a new key does not
    // quietly swap the user's pick for the provider's default.
    const req: ConnectRequest = { provider: model.provider, apiKey: key };
    if (model.baseUrl) req.baseUrl = model.baseUrl;
    if (model.model) req.model = model.model;
    setApiKey('');
    setError(null);
    const result = await useAIConnectionStore.getState().connect(req);
    if (result.ok) onDone();
    else setError({ code: result.code, field: result.field ?? null });
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
        <Input
          id={keyId}
          {...KEY_FIELD_PROPS}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={PROVIDER_META[model.provider].keyPlaceholder}
          disabled={busy}
          aria-describedby={`${keyId}-help`}
          data-testid="mcp-replace-key"
          className="h-8 max-w-[300px] text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || apiKey.trim() === ''}>
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
      {error && (
        <p role="alert" className="text-destructive text-xs" data-testid="mcp-error">
          {connectErrorCopy(error.code, name, { field: error.field })}
        </p>
      )}
    </form>
  );
}

/**
 * The desktop's way in, once a model is connected: Ask starts closed
 * (sidebar-store ASK_OPEN_DEFAULT), so the line names each way to open it,
 * the Ask button on the canvas's header row, the chord as the user has it
 * bound (chordLabel: "Ctrl+J", "⌘J" on a Mac; never typed by hand) and `?` in
 * the dock. The phone has no chord and its own Ask tab, and keeps the dock
 * sentence.
 */
function JustConnectedDesktop() {
  const keys = useShortcutKeys('toggle_right_sidebar');
  const chord = chordLabel(keys, isApplePlatform());
  return <>Connected. Open Ask with the Ask button or {chord}, or type ? in the dock, to ask anything.</>;
}

function ConnectedCard({
  model,
  isMobile,
  highlightId,
  justConnected,
  onConnected,
}: {
  model: ModelConnectionView;
  isMobile: boolean;
  highlightId: string | null;
  justConnected: boolean;
  onConnected: () => void;
}) {
  const router = useRouter();
  const busy = useAIConnectionStore((s) => s.busy);
  const chatTarget = useAISettingsStore((s) => s.chatTarget);
  const caps = useAICapabilities();
  const [mode, setMode] = useState<'idle' | 'replace' | 'switch'>('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  const label = PROVIDER_META[model.provider].label;
  const name = providerName(model.provider, model.baseUrl);
  const host = model.provider === 'custom' ? hostOf(model.baseUrl) : null;
  const oauth = model.authMethod === 'oauth';
  // A sign-in is renewed by signing in again, except in the desktop app, where
  // that flow can't finish (useInDesktopApp): there a pasted key replaces it.
  const inDesktopApp = useInDesktopApp();
  const signInAgain = oauth && !inDesktopApp;
  const failing = model.status === 'failing';
  const unreadable = failing && model.problem === 'key_unreadable';
  const needsModel = !failing && !model.model;

  // Prefetch the list so the picker opens onto models, not a spinner. Only
  // for a working key: listing with a refused one is a wasted provider call.
  useEffect(() => {
    if (model.status === 'ok') void useAIConnectionStore.getState().loadModels();
  }, [model.provider, model.baseUrl, model.status]);

  const checked = (() => {
    if (!model.checkedAt) return null;
    const at = new Date(model.checkedAt);
    return Number.isNaN(at.getTime()) ? null : formatDistanceToNowStrict(at, { addSuffix: true });
  })();

  const recheck = async () => {
    setActionError(null);
    const result = await useAIConnectionStore.getState().recheck();
    if (!result.ok) {
      setActionError(connectErrorCopy(result.code, name, { during: 'recheck', field: result.field }));
    }
  };

  const disconnect = () => {
    setActionError(null);
    useUIStore.getState().confirm({
      title: `Disconnect ${name}?`,
      // The middle sentence: once nothing answers there is no Ask and no
      // History to look in, so nothing else says whether the chats survived.
      description: `dsul will delete the saved key. Chat and plan suggestions hide until you connect again. Your saved conversations stay, and come back when you reconnect. The key stays active with ${name} until you revoke it there.`,
      confirmLabel: 'Disconnect',
      destructive: true,
      testId: 'model-disconnect-confirm',
      onConfirm: () => {
        void useAIConnectionStore
          .getState()
          .disconnect()
          .then((result) => {
            if (!result.ok) setActionError(connectErrorCopy(result.code, name));
          });
      },
    });
  };

  const replaceAction = signInAgain ? (
    <a
      href={OPENROUTER_START}
      data-testid="mcp-signin-again"
      className={failing ? buttonVariants({ size: 'sm' }) : QUIET_LINK}
    >
      Sign in again
    </a>
  ) : failing ? (
    <Button size="sm" onClick={() => setMode('replace')} data-testid="mcp-replace">
      Replace key
    </Button>
  ) : (
    <TextAction onClick={() => setMode(mode === 'replace' ? 'idle' : 'replace')} testId="mcp-replace">
      Replace key
    </TextAction>
  );

  return (
    <Card>
      {/* Who is connected, and whether it works. While it works, this row is
          where `beacon.apiKey` lands; once it stops, the explanation below is. */}
      <div
        {...anchor(failing ? 'beacon.model' : 'beacon.apiKey', highlightId)}
        className={cn('-mx-2 -my-1 flex items-start justify-between gap-4 px-2 py-1', ANCHOR_CLASS)}
      >
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-medium" data-testid="mcp-provider">
            {label}
            {host && <span className="text-muted-foreground font-normal"> · {host}</span>}
            {failing && model.model && (
              <span className="text-muted-foreground font-num font-normal"> · {model.model}</span>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            {oauth ? 'Signed in' : 'Key saved'}
            {!failing && checked && <> · Checked {checked}</>}
            {!failing && (
              <>
                {' · '}
                <TextAction onClick={() => void recheck()} disabled={busy !== null} testId="mcp-recheck">
                  {busy === 'recheck' ? 'Checking…' : 'Check again'}
                </TextAction>
              </>
            )}
          </p>
        </div>
        <StatusPill failing={failing} />
      </div>

      {failing ? (
        <div {...anchor('beacon.apiKey', highlightId)} className={cn('-mx-2 -my-1 flex flex-col gap-3 px-2 py-1', ANCHOR_CLASS)}>
          <p role="status" className="text-foreground text-sm" data-testid="mcp-failing">
            {unreadable
              ? 'dsul can’t read your saved key anymore. Connect it again.'
              : `This key stopped working. ${name} turned it down the last time dsul used it.`}
          </p>
          {oauth && inDesktopApp && (
            <p className="text-muted-foreground text-xs" data-testid="mcp-signin-browser">
              Or sign in to OpenRouter again from dsul in your browser. The connection works here
              too.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {replaceAction}
            {!unreadable && (
              <TextAction onClick={() => void recheck()} disabled={busy !== null} testId="mcp-recheck">
                {busy === 'recheck' ? 'Checking…' : 'Check again'}
              </TextAction>
            )}
            <TextAction onClick={disconnect} disabled={busy !== null} testId="mcp-disconnect">
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </TextAction>
          </div>
        </div>
      ) : (
        <>
          <div className="border-border grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Model</p>
              <p className="text-muted-foreground text-xs" data-testid="mcp-model-hint">
                {needsModel
                  ? 'Pick a model to finish connecting.'
                  : 'Which of your provider’s models answers.'}
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

          <div className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {!oauth && replaceAction}
              <TextAction
                onClick={() => setMode(mode === 'switch' ? 'idle' : 'switch')}
                testId="mcp-switch"
              >
                Use a different provider
              </TextAction>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={disconnect}
              disabled={busy !== null}
              data-testid="mcp-disconnect"
              className="text-muted-foreground -my-1 -mr-2 h-7 px-2 text-xs"
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </>
      )}

      {mode === 'replace' && !signInAgain && (
        <ReplaceKeyForm model={model} onDone={() => setMode('idle')} />
      )}

      {mode === 'switch' && !failing && (
        <div className="border-border flex flex-col gap-3 border-t pt-4" data-testid="mcp-switch-panel">
          <div>
            <p className="text-foreground text-sm font-medium">Switch provider</p>
            <p className="text-muted-foreground text-xs">
              Connecting a different provider replaces this one.
            </p>
          </div>
          <ConnectForm
            variant="switch"
            highlightId={highlightId}
            exclude={model.provider}
            onConnected={() => {
              setMode('idle');
              onConnected();
            }}
          />
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-destructive text-xs" data-testid="mcp-error">
          {actionError}
        </p>
      )}

      {chatTarget === 'none' ? (
        <p className="text-muted-foreground text-xs" data-testid="mcp-chat-off">
          Chat is off on this device. Change it under Who answers in chat below.
        </p>
      ) : (
        caps.openclawUsable && (
          <p className="text-muted-foreground text-xs" data-testid="mcp-openclaw-too">
            OpenClaw is connected too. Choose who answers in chat below.
          </p>
        )
      )}
    </Card>
  );
}
