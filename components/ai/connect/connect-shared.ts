'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import type { DetectedProvider } from '@/lib/ai-key-prefix';
import {
  AI_SETTINGS_PATH,
  PROVIDER_META,
  type ApiErrorCode,
  type ModelProviderId,
  type OpenRouterReturn,
} from '@/lib/ai-types';
import { UNAVAILABLE_COPY } from '@/lib/connect-flow';
import { getDesktopBridge } from '@/lib/desktop';
import { resetClock } from '@/lib/format-chat-timestamp';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * What the ways in to AI share: the setup column's connect card and fix home
 * (connect-ai.tsx, connect-fix.tsx) and Settings → AI
 * (components/settings/model-connection-panel.tsx). Names, links, anchors,
 * the words for each answer the connect route gives, and two hooks.
 *
 * Nothing here holds a key. The copy takes a provider and a code, never what
 * was typed.
 */

/* ── The desktop app ────────────────────────────────────────────────────── */

const noopSubscribe = () => () => {};
const isDesktopApp = () => getDesktopBridge() !== null;

/**
 * Whether this page is inside the desktop app (electron/). OpenRouter's sign-in
 * can't finish there: the shell sends openrouter.ai to the system browser, and
 * the callback then lands in a browser that has neither the PKCE cookie (it is
 * in the app's cookie jar) nor, often, a dsul session. So the app offers the
 * key path, and a link to sign in from the browser. A connection belongs to
 * the account, so one made by signing in from a browser works in the app too.
 * Read as app/login/login-page.tsx reads it, so the server render and
 * hydration agree.
 */
export function useInDesktopApp(): boolean {
  return useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
}

/**
 * In the desktop app, ask the server again whenever the window comes back to
 * the front: a sign-in finished in the browser lands while this window sits
 * behind it. `active` is whether the surface is on screen (the setup column
 * stays mounted, hidden, under an item, and a hidden column asks for nothing).
 * The web needs none of it: there the sign-in returns to the page itself.
 */
export function useRefreshOnWindowFocus(active = true): void {
  useEffect(() => {
    if (!active || !getDesktopBridge()) return;
    const ask = () => void useAIConnectionStore.getState().refresh();
    window.addEventListener('focus', ask);
    return () => window.removeEventListener('focus', ask);
  }, [active]);
}

/** How many surfaces that show a sign-in's result are mounted (see below). */
let flowViewers = 0;

/**
 * How an OpenRouter sign-in that returned home ended (`flowResult`, set by
 * lib/connect-return.ts) is said once, where it lands: the next action there
 * spends it, and so does leaving. Leaving is read a tick late, so a surface
 * that unmounts and mounts again in one commit (React's dev double mount, or
 * the setup home giving way to the fix home) keeps it.
 */
export function useFlowResultSpentOnLeave(): void {
  useEffect(() => {
    flowViewers += 1;
    return () => {
      flowViewers -= 1;
      setTimeout(() => {
        const s = useAIConnectionStore.getState();
        if (flowViewers === 0 && s.flowResult !== null) s.setFlowResult(null);
      }, 0);
    };
  }, []);
}

/** The next action on a surface that shows a sign-in's result: what it said is spent. */
export function spendFlowResult(): void {
  const s = useAIConnectionStore.getState();
  if (s.flowResult !== null) s.setFlowResult(null);
}

/**
 * When a daily limit lifts, on the planner's own clock ("7 am", "07:00"): a
 * reader for an answer's `limitedUntil`, null when it gave no time. A reader
 * rather than a value, so an answer that arrives in a handler can use it.
 */
export function useResetsAt(): (limitedUntil: string | null | undefined) => string | null {
  const zone = usePlannerStore((s) => s.userTimezone);
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  return (limitedUntil) => {
    const at = limitedUntil ? Date.parse(limitedUntil) : NaN;
    return Number.isFinite(at) ? resetClock(at, zone, timeFormat) || null : null;
  };
}

/* ── Names ──────────────────────────────────────────────────────────────── */

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** A custom host says nothing as "Other": it is its hostname, or "Your service". */
const customName = (baseUrl?: string | null) => hostOf(baseUrl) ?? 'Your service';

/** The company, as a sentence names it: "Google didn’t accept that key". */
export function companyName(provider: ModelProviderId, baseUrl?: string | null): string {
  return PROVIDER_META[provider].company ?? customName(baseUrl);
}

/** The short form: "New Gemini key", "✓ OpenAI key". */
export function shortName(provider: ModelProviderId, baseUrl?: string | null): string {
  return PROVIDER_META[provider].short ?? customName(baseUrl);
}

/** The connection's title: "Google Gemini". */
export function labelName(provider: ModelProviderId, baseUrl?: string | null): string {
  return provider === 'custom' ? customName(baseUrl) : PROVIDER_META[provider].label;
}

/** "an OpenAI", "a Google". */
export function withArticle(name: string): string {
  return `${/^[AEIOU]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** What each company's keys start with, for a note about a key that doesn't look like one. */
export const KEY_STARTS: Readonly<Record<DetectedProvider, readonly string[]>> = Object.freeze({
  gemini: ['AQ.', 'AIza'],
  openai: ['sk-'],
  anthropic: ['sk-ant-'],
  openrouter: ['sk-or-'],
});

/* ── Links ──────────────────────────────────────────────────────────────── */

const OPENROUTER_START = '/api/ai/openrouter/start';

/** "Sign in with OpenRouter", returning to the pane or to home (the PKCE cookie seals which). */
export function openRouterStartHref(r: OpenRouterReturn): string {
  return `${OPENROUTER_START}?r=${r}`;
}

/** Settings → AI, its key field ringed (`?focus=`, the settings page routes the id to its pane). */
export const SETUP_SETTINGS_HREF = `${AI_SETTINGS_PATH}?focus=beacon.apiKey`;
/** A saved connection with no model picked: the model row. */
export const SETUP_MODEL_HREF = `${AI_SETTINGS_PATH}?focus=beacon.model`;

/**
 * Where the desktop app sends someone to sign in with OpenRouter: this same
 * site, in their browser. Built from the window's own origin, so a dev or
 * staging shell never sends the sign-in to production. `?start=openrouter`
 * only unfolds the sign-in there; it never starts one by itself.
 */
export function desktopSignInLink(): string {
  return `${window.location.origin}${AI_SETTINGS_PATH}?start=openrouter`;
}

/* ── Settings anchors ───────────────────────────────────────────────────── */

export type AnchorId = 'beacon.apiKey' | 'beacon.model';

/**
 * Where `?focus=beacon.apiKey` / `beacon.model` land (settings-shell resolves
 * `[data-setting-alias]`, scrolls, focuses and rings it). Focusable but out of
 * the tab order, like a SettingRow.
 */
export function settingAnchor(id: AnchorId, highlightId: string | null | undefined) {
  return {
    'data-setting-alias': id,
    'data-highlight': highlightId === id || undefined,
    tabIndex: -1,
  } as const;
}

export const ANCHOR_CLASS =
  'rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-ring data-[highlight]:ring-2 data-[highlight]:ring-ring';

/* ── The words for each answer ──────────────────────────────────────────── */

export const NOT_A_WHOLE_KEY = 'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.';
export const TOO_MANY_TRIES = 'Too many tries. Wait a few minutes and try again.';

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
  /** `wrong_provider`: whose key the route read it as. */
  detected?: DetectedProvider | null;
  /** `daily_limit`: when it lifts, as a clock ("7 am"), when the answer said. */
  resetsAt?: string | null;
}

/**
 * A custom host answers 404 at a wrong path, which reads as "doesn't list its
 * models" and then as an unknown model. The usual cause is a base URL missing
 * its /v1, so every Other failure that could be that says so.
 */
const BASE_URL_HINT = 'Check the base URL (it usually ends in /v1)';

/**
 * ApiErrorCode → our words, for Settings → AI's own forms (the switch, the
 * replace, Check again, the model picker). Never a provider's own error text:
 * the routes don't send one. `name` is the provider as the pane names it.
 */
export function connectErrorCopy(
  code: ApiErrorCode,
  name: string,
  { during = 'connect', custom = false, field = null, detected = null, resetsAt = null }: ErrorCopyContext = {}
): string {
  switch (code) {
    case 'key_rejected':
      return during === 'connect'
        ? `${name} didn’t accept that key. Check that you copied all of it.`
        : `${name} turned down your saved key.`;
    case 'wrong_provider':
      return detected
        ? `That looks like ${withArticle(PROVIDER_META[detected].label)} key, not ${withArticle(name)} one.`
        : 'That key looks like it’s for another service. Check that you copied the right one.';
    case 'no_credit':
      return `${name} accepted the key, but the account behind it has no credit. Add credit there, then try again.`;
    case 'daily_limit':
      return resetsAt
        ? `${name} accepted the key, but today’s limit on it is used up. It resets at ${resetsAt}. Try again then, or use another key.`
        : `${name} accepted the key, but today’s limit on it is used up. Try again once it resets, or use another key.`;
    case 'region':
      return `${name} won’t answer from where dsul’s server is right now. A different provider works instead.`;
    case 'network':
      return `Couldn’t reach ${name} just now. Try again in a moment.`;
    case 'unreachable':
      return `Couldn’t reach ${name}. Try again in a moment.`;
    case 'blocked_url':
      return 'That address isn’t allowed. Use a public https address.';
    case 'model_required':
      return `Nothing at that address listed its models. ${BASE_URL_HINT}, or add a model name above and connect again.`;
    case 'busy':
      return TOO_MANY_TRIES;
    case 'invalid':
      if (during !== 'connect') {
        if (field === 'model') return 'That model isn’t available to your key. Pick another.';
        return during === 'model' ? 'Couldn’t save. Try again.' : 'Something went wrong. Try again.';
      }
      if (field === 'apiKey') return NOT_A_WHOLE_KEY;
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

/** Where a key from another service can be connected, from where a check failed. */
export type Elsewhere = 'below' | 'here' | 'settings';

export interface CheckCopyContext {
  /** A custom connection's address: its hostname names it. */
  baseUrl?: string | null;
  /** `daily_limit`: when it lifts, as a clock ("7 am"), when the answer said. */
  resetsAt?: string | null;
  /** `region`: the "I already use…" fold below, this fold itself, or Settings → AI. */
  elsewhere?: Elsewhere;
  /** `invalid`: the field the route named. */
  field?: string | null;
}

/**
 * What a key's check said, in the connect card's words: the setup column's
 * card and folds, the fix home's field and its fresh check, and the pane's
 * not-connected state. Each names the company the key went to, and each but
 * the refusal says the key is fine to keep: it stays in the box.
 *
 * `wrong_provider` is not here: it is a note with its own two actions
 * (`wrongKindCopy`).
 */
export function checkFailureCopy(
  code: ApiErrorCode,
  provider: ModelProviderId,
  { baseUrl = null, resetsAt = null, elsewhere = 'below', field = null }: CheckCopyContext = {}
): string {
  const company = companyName(provider, baseUrl);
  switch (code) {
    case 'key_rejected':
      return provider === 'gemini'
        ? 'Google didn’t accept that key. It may be cut short, or it was deleted in AI Studio. It’s still in the box, so you can check it or paste a new one.'
        : `${company} didn’t accept that key. Check that you copied all of it.`;
    case 'no_credit':
      // Anthropic answers a key with no credit and one over its spend limit alike.
      return provider === 'anthropic'
        ? 'Anthropic accepted the key, but the account behind it may need credit, or has hit a spend limit. Add credit with Anthropic, then check again.'
        : `${company} accepted the key, but the account behind it has no credit. Add credit with ${company}, then check again.`;
    case 'daily_limit':
      return resetsAt
        ? `${company} accepted the key, but today’s limit on it is used up. It resets at ${resetsAt}. Check again then, or use another key.`
        : `${company} accepted the key, but today’s limit on it is used up. Check again once it resets, or use another key.`;
    case 'region': {
      const where =
        elsewhere === 'below'
          ? ', under “I already use…” below'
          : elsewhere === 'settings'
            ? ', in Settings → AI'
            : '';
      return `${company} won’t answer from where dsul’s server is right now. A key from another service works instead${where}.`;
    }
    case 'network':
      return `Couldn’t reach ${company} just now. Check again in a moment.`;
    case 'unreachable':
      return `${company} couldn’t answer the test question just now. Check again in a moment.`;
    case 'busy':
      return TOO_MANY_TRIES;
    case 'invalid':
      if (field === 'apiKey') return NOT_A_WHOLE_KEY;
      return connectErrorCopy(code, company, { custom: provider === 'custom', field });
    default:
      return connectErrorCopy(code, company, { custom: provider === 'custom', field });
  }
}

/**
 * A key that reads as another company's, pasted where one company's goes.
 * Neutral: it is a fine key, for somewhere else, and nothing was sent.
 * `intended` is where the box sends keys.
 */
export function wrongKindCopy(detected: DetectedProvider, intended: ModelProviderId, baseUrl?: string | null): string {
  const theirs = companyName(detected);
  const tail =
    detected === 'openrouter' || detected === 'gemini'
      ? `${theirs} keys work too.`
      : `${theirs} keys work too, but they need credit on your ${theirs} account.`;
  return `That looks like ${withArticle(theirs)} key, not ${withArticle(companyName(intended, baseUrl))} one. ${tail}`;
}

/**
 * A paste no prefix places, in the box for `provider`'s keys: the quiet
 * note's words as text, for the live region (key-check.tsx draws the note).
 */
export function undetectedCopy(provider: DetectedProvider): string {
  const company = companyName(provider);
  return `That doesn’t look like ${withArticle(company)} key. ${company}’s keys start with ${KEY_STARTS[provider].join(' or ')}.`;
}

/** The action that sends a wrong-kind key where it belongs. */
export function sendToLabel(detected: DetectedProvider): string {
  return `Use it with ${companyName(detected)}`;
}

/** The link to where a company's keys are made, labelled for a sentence-sized button. */
export function keyPageLabel(provider: ModelProviderId, baseUrl?: string | null): string {
  return provider === 'gemini' ? 'Open Google AI Studio' : `Open ${companyName(provider, baseUrl)}’s key page`;
}

/** "Checking your key with Google…" */
export function checkingCopy(provider: ModelProviderId, baseUrl?: string | null): string {
  return `Checking your key with ${companyName(provider, baseUrl)}…`;
}

/**
 * The consent line, while a question kept from `?` waits on this connect
 * (lib/ask-pending.ts): where the press under it sends that question. Another
 * service is its host, or "your service" mid-sentence when the address has none.
 */
export function consentCopy(provider: ModelProviderId, baseUrl?: string | null): string {
  const to = provider === 'custom' && !hostOf(baseUrl) ? 'your service' : companyName(provider, baseUrl);
  return `Connecting sends your question, and the parts of your plan it needs, from dsul’s server to ${to}.`;
}
