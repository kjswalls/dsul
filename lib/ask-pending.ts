import { useSyncExternalStore } from 'react';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import { useAISettingsStore } from './ai-settings-store';
import { isModelProviderId, type ModelConnectionView, type ModelProviderId } from './ai-types';
import { CHAT_LIMITS, cleanText } from './conversation-types';
import { useConversationsStore } from './conversations-store';
import { askKeptQuestion } from './open-chat';
import { selectPlannerSettled } from './planner-ready';
import { usePlannerStore } from './planner-store';
import { useRailStore } from './rail-store';

/**
 * The kept question: `?` and a question, typed into the dock or Ctrl+K while
 * nothing answers yet. The door opens setup ("Set up AI to ask this") and the
 * question waits here, shown on the setup page as YOUR QUESTION with [Clear],
 * until something can answer it.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts).
 *
 * WHERE IT LIVES. sessionStorage, per tab, so it survives the same-tab
 * OpenRouter round trip (a full page load) and nothing else: never a URL, a
 * cookie, a persisted store or a log. A memory mirror holds what this page
 * read or wrote, so a browser that refuses the write still keeps the question
 * for the page it was asked on. It is text the user wrote, so the account's
 * clear (lib/local-state.ts RAW_CLEARERS) drops it, mirror included, and each
 * record names the account it was kept for (the AI gate's `hydratedUserId`,
 * the id the gate's answer belongs to): another account never sees it, and
 * never sends it.
 *
 * SENT ONCE, AND ONLY WHERE IT WAS SAID IT WOULD GO. Connecting with a
 * question kept shows a consent line naming the company the question goes to,
 * above the control that sends ("Connect and ask", Check again, the
 * OpenRouter sign-in); pressing it stamps `consent` here. The watcher below
 * asks the question only when the connection that lands is the one the line
 * named, within CONSENT_TTL_MS of the press. Any other road to a working AI
 * (Settings → AI, another device, an OpenClaw pairing, a different provider,
 * a consent gone stale) moves the question into Ask home's box unsent: never
 * lost, never sent somewhere the person did not see named.
 *
 * CLAIM, THEN ACT. The watcher takes the record before it asks: the id goes
 * onto a short list in localStorage (ASK_CLAIMED_KEY, random ids only, nothing
 * about anyone) and the record goes. A status flap, React's dev double effect
 * or a second watcher then finds nothing. sessionStorage is per tab, but
 * Duplicate tab copies it, and the copy reads that shared list and stands
 * down. [Clear] leaves its id on the list too, so a copy never asks a
 * question the person took back. A send the store refuses after the claim
 * puts the identical record back (`restoreKept`).
 */

export const ASK_PENDING_KEY = 'dsul-ask-pending';
export const ASK_CLAIMED_KEY = 'dsul-ask-claimed';
/** What a send takes (conversations-store's `send` cuts there too). */
export const KEPT_MAX_CHARS = CHAT_LIMITS.userChars;
/** How long a consent press speaks for: past it, the question waits in Ask's box rather than going out. */
export const CONSENT_TTL_MS = 60 * 60_000;
/** How many claimed ids the shared list keeps: enough for every tab one person has open. */
const MAX_CLAIMED = 8;

/** The company a consent line named, and when it was pressed. `baseUrl` names Another service's host. */
export interface KeptConsent {
  provider: ModelProviderId;
  baseUrl: string | null;
  at: number;
}

export interface KeptQuestion {
  /** Random, per keep: what the claimed list names. */
  id: string;
  text: string;
  /** When it was kept (ms). Display never ages it; only `consent` expires. */
  at: number;
  /** The account it was kept for (the AI gate's `hydratedUserId`). */
  uid: string;
  consent: KeptConsent | null;
}

// ── The record ───────────────────────────────────────────────────────────────

/** This page's copy: undefined until first read, then what storage held or the last write. */
let mirror: KeptQuestion | null | undefined;
/** Ids claimed in this tab: the claim still holds here when localStorage refuses the list. */
const tabClaimed = new Set<string>();
const listeners = new Set<() => void>();

function wellFormed(v: unknown): v is KeptQuestion {
  if (!v || typeof v !== 'object') return false;
  const q = v as Record<string, unknown>;
  if (typeof q.id !== 'string' || !q.id || typeof q.uid !== 'string' || !q.uid) return false;
  if (typeof q.text !== 'string' || !q.text.trim() || q.text.length > KEPT_MAX_CHARS) return false;
  if (typeof q.at !== 'number' || !Number.isFinite(q.at)) return false;
  if (q.consent === null) return true;
  const c = q.consent as Record<string, unknown> | undefined;
  return (
    !!c &&
    typeof c === 'object' &&
    isModelProviderId(c.provider) &&
    (c.baseUrl === null || typeof c.baseUrl === 'string') &&
    typeof c.at === 'number' &&
    Number.isFinite(c.at)
  );
}

/** The record this page holds. A malformed one in storage is removed as it is found. */
function load(): KeptQuestion | null {
  if (mirror !== undefined) return mirror;
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(ASK_PENDING_KEY);
  } catch {
    // Unreadable storage holds nothing this page can show.
  }
  let parsed: unknown = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (raw !== null && !wellFormed(parsed)) {
    write(null, { quiet: true });
    return null;
  }
  mirror = raw === null ? null : (parsed as KeptQuestion);
  return mirror;
}

/** The mirror first, so a write the browser refuses still holds for this page. `quiet`: a read tidying up, nothing changed for a reader. */
function write(next: KeptQuestion | null, o: { quiet?: boolean } = {}): void {
  mirror = next;
  try {
    if (next) window.sessionStorage.setItem(ASK_PENDING_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(ASK_PENDING_KEY);
  } catch {
    // Private mode or blocked site data: the mirror keeps it for this page.
  }
  if (!o.quiet) for (const listener of [...listeners]) listener();
}

// ── The claimed list (localStorage, shared by every tab) ─────────────────────

function readClaimed(): string[] {
  try {
    const raw = window.localStorage.getItem(ASK_CLAIMED_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeClaimed(ids: string[]): void {
  try {
    window.localStorage.setItem(ASK_CLAIMED_KEY, JSON.stringify(ids.slice(-MAX_CLAIMED)));
  } catch {
    // The per-tab claim still holds here; only a duplicated tab goes unwarned.
  }
}

function isClaimed(id: string): boolean {
  return tabClaimed.has(id) || readClaimed().includes(id);
}

function addClaimed(id: string): void {
  tabClaimed.add(id);
  writeClaimed([...readClaimed().filter((x) => x !== id), id]);
}

function unclaim(id: string): void {
  tabClaimed.delete(id);
  const ids = readClaimed();
  if (ids.includes(id)) writeClaimed(ids.filter((x) => x !== id));
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // randomUUID needs a secure context; a plain-http dev address has none.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** What a reader may show for `uid`: well formed, this account's, not claimed. Pure. */
function visibleKept(uid: string | null): KeptQuestion | null {
  const q = load();
  if (!q || uid === null || q.uid !== uid || isClaimed(q.id)) return null;
  return q;
}

const signedInAs = () => useAIConnectionStore.getState().hydratedUserId;

// ── Reading and writing it ───────────────────────────────────────────────────

/**
 * Keep `text` for the signed-in account, in place of any question kept
 * before (a new id, a new `at`, no consent). False with nobody signed in or
 * nothing to keep. The door calls it only while the gate invites.
 */
export function keepQuestion(text: string): boolean {
  const uid = signedInAs();
  const clean = cleanText(typeof text === 'string' ? text.trim() : '', KEPT_MAX_CHARS).trim();
  if (uid === null || !clean) return false;
  write({ id: newId(), text: clean, at: Date.now(), uid, consent: null });
  return true;
}

/**
 * A press made under the consent line, naming `target`: the question may go
 * to that company once its connection lands. On the question this account
 * sees; nothing when none is kept. Every press stamps it again, so a press
 * always renews it.
 */
export function markConsent(target: { provider: ModelProviderId; baseUrl?: string | null }, now = Date.now()): void {
  const q = visibleKept(signedInAs());
  if (!q) return;
  write({ ...q, consent: { provider: target.provider, baseUrl: target.baseUrl ?? null, at: now } });
}

/**
 * The question kept for `uid`, or null. Removes a record that can never be
 * asked: a claimed one, and once the account is known (never while `uid` is
 * null), one kept for another account.
 */
export function readKept(uid: string | null): KeptQuestion | null {
  const q = load();
  if (!q) return null;
  if (isClaimed(q.id) || (uid !== null && q.uid !== uid)) {
    write(null);
    return null;
  }
  return uid === null ? null : q;
}

/** The person's [Clear]: gone here, and its id on the claimed list so a duplicated tab never asks it either. */
export function clearKept(): void {
  const q = load();
  if (!q) return;
  addClaimed(q.id);
  write(null);
}

/** Take the question this account sees, if any (No AI holds it for its Undo). */
export function takeKept(): KeptQuestion | null {
  const q = readKept(signedInAs());
  if (q) write(null);
  return q;
}

/**
 * Put back exactly what was taken: the same id, text, `at` and consent, its
 * id off the claimed list. A different question kept meanwhile is the
 * person's latest word, and stays.
 */
export function restoreKept(q: KeptQuestion): void {
  if (!wellFormed(q)) return;
  const now = load();
  if (now && now.id !== q.id && !isClaimed(now.id)) return;
  unclaim(q.id);
  write(q);
}

/** The account's clear (lib/local-state.ts): the record and the mirror. The claimed list holds only random ids, and stays. */
export function clearKeptQuestionState(): void {
  write(null);
}

function subscribeKept(onChange: () => void): () => void {
  listeners.add(onChange);
  const offAI = useAIConnectionStore.subscribe((s, prev) => {
    if (s.hydratedUserId !== prev.hydratedUserId) onChange();
  });
  // A claim or a Clear in another tab (a duplicated one) reaches this one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === ASK_CLAIMED_KEY || e.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    offAI();
    window.removeEventListener('storage', onStorage);
  };
}

/** The question kept for the signed-in account, as the setup page shows it. Null on the server. */
export function useKeptQuestion(): KeptQuestion | null {
  return useSyncExternalStore(
    subscribeKept,
    () => visibleKept(signedInAs()),
    () => null
  );
}

/** TEST ONLY: a fresh page (mirror unread, nothing claimed in this tab). Storage is the test's own to clear. */
export function __resetKeptForTests(): void {
  mirror = undefined;
  tabClaimed.clear();
}

// ── Asking it ────────────────────────────────────────────────────────────────

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The live connection is the one the consent line named, and the press was recent. */
function consentCovers(q: KeptQuestion, model: ModelConnectionView | null, now: number): boolean {
  const c = q.consent;
  if (!c || !model || model.provider !== c.provider) return false;
  if (Math.abs(now - c.at) >= CONSENT_TTL_MS) return false;
  if (c.provider !== 'custom') return true;
  const host = hostOf(model.baseUrl);
  return host !== null && host === hostOf(c.baseUrl);
}

/**
 * Ask the kept question once something answers. AppShell calls it on `/`
 * only, where Ask lives, beside the OpenRouter return (lib/connect-return.ts);
 * the cleanup it returns stops everything, a timer still waiting included, so
 * nothing is asked once AppShell has gone.
 *
 * Level-triggered: it looks once at the start and again on every change to
 * the gate's two stores and the planner, and acts when all of these hold:
 * something answers; the gate is `ready` for a signed-in account; the
 * planner's load for that same account has landed and did not fail (the
 * question goes out with the plan as context, and an empty plan would answer
 * it wrongly); and a question is kept for that account.
 *
 * It then waits one macrotask: the connect that lit the gate is still
 * finishing (ConnectAI's `succeed` pops the stack home and says "It works.";
 * the OpenRouter return's `apply` does the same), and a conversation pushed
 * before them would be popped from under its own answer. Then it checks it all
 * again, with Ask home's box not mid-send (the 'home' binding would refuse),
 * claims the record, and either asks it (`askKeptQuestion`, on the shell
 * `isPhone` names at that moment: the phone's Ask tab or the desktop column,
 * whose answerer the gate already chose) or, when the consent does not cover
 * this connection, leaves it in Ask home's box to send or not.
 */
export function watchKeptQuestion(o: { isPhone: () => boolean; now?: () => number }): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** An ask of ours still on its way. */
  let asking = false;
  /** Waiting for Ask home's own send to finish. */
  let offHomeBox: (() => void) | null = null;
  const now = () => o.now?.() ?? Date.now();

  /** The question to act on, when everything that lets it be asked holds now. */
  const due = (): KeptQuestion | null => {
    if (!getAICapabilities().canChat) return null;
    const ai = useAIConnectionStore.getState();
    const uid = ai.hydratedUserId;
    if (ai.phase !== 'ready' || uid === null) return null;
    const planner = usePlannerStore.getState();
    if (!selectPlannerSettled(planner) || planner.error || planner.userId !== uid) return null;
    return readKept(uid);
  };

  const evaluate = () => {
    if (stopped || asking || timer !== null || offHomeBox) return;
    if (due()) timer = setTimeout(act, 0);
  };

  const act = () => {
    timer = null;
    if (stopped) return;
    const q = due();
    if (!q) return;
    if (useConversationsStore.getState().sending.home) {
      offHomeBox = useConversationsStore.subscribe((s) => {
        if (s.sending.home) return;
        offHomeBox?.();
        offHomeBox = null;
        evaluate();
      });
      return;
    }
    addClaimed(q.id);
    write(null);
    if (getAICapabilities().target === 'model' && consentCovers(q, useAIConnectionStore.getState().model, now())) {
      asking = true;
      void askKeptQuestion(q.text, o.isPhone())
        .catch(() => false)
        .then((sent) => {
          asking = false;
          // Refused after the claim: the same record back, to be tried on the next change.
          if (!sent) restoreKept(q);
        });
      return;
    }
    useRailStore.getState().appendDraftHome(q.text);
  };

  const offs = [
    useAIConnectionStore.subscribe(() => evaluate()),
    useAISettingsStore.subscribe(() => evaluate()),
    usePlannerStore.subscribe(() => evaluate()),
  ];
  evaluate();
  return () => {
    stopped = true;
    for (const off of offs) off();
    offHomeBox?.();
    offHomeBox = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
