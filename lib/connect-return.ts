import {
  getAICapabilities,
  useAIConnectionStore,
  type AIConnectionState,
  type JustConnected,
} from './ai-connection-store';
import { flowSaved, readFlow, type ConnectFlow, type FlowResult } from './connect-flow';
import { useMobileNavStore } from './mobile-nav-store';
import { leaveZen } from './open-chat';
import { useRailStore } from './rail-store';
import type { ModelConnectionView } from './ai-types';

/**
 * An OpenRouter sign-in begun in the setup column comes back HOME, to
 * `/?connect=<result>` (the PKCE cookie's `r`, lib/ai-types.ts), and this is
 * the one step that turns that address into what the column says about it.
 * AppShell calls it once, on `/` only, as it does the `?eod=` link
 * (lib/eod-link.ts).
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts).
 *
 * The order is the point, because the callback's return is a FULL page load:
 *
 *  1. The value is read against lib/connect-flow.ts's own keys (`readFlow`;
 *     `in` would take 'constructor'), and the link comes off the address bar
 *     at once, whatever it said, so a reload never replays it.
 *  2. Nothing is written yet. AppShell's effect runs before the provider has
 *     adopted the account, and the gate's first answer for an account wipes
 *     the store back to its INITIAL state (ai-connection-store.ts `load`):
 *     anything written now would be gone before the column could show it. So
 *     the result waits here until the gate is `ready` for a signed-in
 *     account. A gate that fails (`phase: 'error'`) drops it: the gate fails
 *     closed, and so does this.
 *  3. Then ONE store write. A sign-in that did not end in a working
 *     connection leaves its result in `flowResult`, which the setup column's
 *     OpenRouter fold and the fix home say in FLOW_COPY's words. With a
 *     connection that can chat the column is Ask, and Ask home says only a
 *     sign-in that saved it (saved, no_credit, daily_limit: the key works,
 *     its test question went unanswered), quietly, where "It works." would
 *     sit, until Ask spends it or stops answering; any other result is
 *     dropped there, since one left unsaid would surface later as if it had
 *     just been said. `ok` sets
 *     `justConnected` (Ask home's "It works.", components/ai/ask/
 *     it-works-card.tsx), but only when the answered connection backs it up:
 *     an OpenRouter sign-in (`oauth`), working, with a model, checked a
 *     moment ago. Anyone can link to `/?connect=ok`, and the card states a
 *     fact ("answered a test question"), so the link alone never says it.
 *     `freeTier` is false here: the return carries no plan signal, and the
 *     card never guesses one.
 *  4. Then the surface opens where the sign-in began, only when the gate
 *     offers something to show, so a crafted link on an account with AI
 *     hidden leaves nothing waiting for later. On the desktop: out of Zen,
 *     Ask's stack home, and a summon that writes no `askOpen` (as the unlit
 *     key's does, lib/open-chat.ts). On the phone: its Ask tab (the setup
 *     page, the fix home or Ask, whichever the gate now offers) on its
 *     home. Never a summon there, which would arm the desktop column to
 *     spring open on a wider window, and never Zen, which the phone has none
 *     of.
 */

/** How recent the sign-in's check must be for "It works." to claim it. */
export const JUST_CONNECTED_WINDOW_MS = 5 * 60_000;

/** The result a `?connect=` link carries, if it is one this build knows. */
export function readConnectReturn(search: string): ConnectFlow | null {
  return readFlow(new URLSearchParams(search).get('connect'));
}

/**
 * What an `ok` return may say: the answered connection as "It works." names
 * it, or null when the connection does not back the claim up.
 */
export function justConnectedFrom(model: ModelConnectionView | null, now: number): JustConnected | null {
  if (!model || model.provider !== 'openrouter' || model.authMethod !== 'oauth') return null;
  if (model.status !== 'ok' || !model.model) return null;
  const checked = model.checkedAt === null ? NaN : Date.parse(model.checkedAt);
  if (!Number.isFinite(checked) || Math.abs(now - checked) > JUST_CONNECTED_WINDOW_MS) return null;
  return { provider: model.provider, model: model.model, freeTier: false, at: now };
}

/** Ends the watch below, while one is on. */
let unwatch: (() => void) | null = null;

/**
 * A result Ask home says sits in the store under a connection that answers.
 * Should that connection stop answering before Ask spends it (a call or a
 * recheck turns the key down, the connection goes), the column becomes the
 * setup or fix home, which says any result it finds: this one would read
 * there as if it had just been said, so it goes with Ask.
 */
function spendWhenAskGoes(flow: FlowResult): void {
  unwatch?.();
  const stop = useAIConnectionStore.subscribe(() => {
    const now = useAIConnectionStore.getState();
    if (now.flowResult === flow && getAICapabilities().canChat) return;
    unwatch?.();
    if (now.flowResult === flow) now.setFlowResult(null);
  });
  unwatch = () => {
    stop();
    unwatch = null;
  };
}

function apply(flow: ConnectFlow, s: AIConnectionState, o: ConnectReturnOptions): void {
  const ai = useAIConnectionStore.getState();
  const caps = getAICapabilities();
  if (flow === 'ok') {
    const said = justConnectedFrom(s.model, o.now?.() ?? Date.now());
    if (said) ai.setJustConnected(said);
  } else if (!caps.canChat || flowSaved(flow)) {
    // The setup column and the fix home say any result. Ask says only a
    // sign-in that saved the connection it opens on (saved, no_credit,
    // daily_limit), and spends it as it does "It works." (lib/rail-store.ts
    // spendJustConnected). Any other result left in the store under a working
    // connection would surface later, after a disconnect or a key that stops
    // working, as if it had just been said.
    ai.setFlowResult(flow);
    if (caps.canChat) spendWhenAskGoes(flow);
  }
  if (!caps.canChat && !caps.askInvite && !caps.askFix) return;
  const rail = useRailStore.getState();
  if (o.isPhone()) {
    rail.popToHome('phone');
    useMobileNavStore.getState().setActiveTab('chat');
    return;
  }
  leaveZen();
  rail.popToHome('desktop');
  rail.summon({ persist: false });
}

export interface ConnectReturnOptions {
  /** Takes `?connect=` off the address bar (and nothing else in it). */
  clearLink: () => void;
  /** Whether the phone's shell is the one showing, asked when the gate answers. */
  isPhone: () => boolean;
  /** For tests. */
  now?: () => number;
}

/**
 * The result read off the link and not yet said. Held across React's dev
 * double mount (mount, unmount, mount, in one commit), which would otherwise
 * strip the link on the first mount and find nothing on the second; a real
 * unmount drops it a tick later, as useFlowResultSpentOnLeave does
 * (components/ai/connect/connect-shared.ts).
 */
let held: ConnectFlow | null = null;
/** How many takes are waiting on the gate. */
let waiting = 0;

/** The gate has answered for a signed-in account, or failed. */
function decided(s: AIConnectionState): boolean {
  return s.phase === 'error' || (s.phase === 'ready' && s.hydratedUserId !== null);
}

/** TEST ONLY: forget a result held from an earlier test. */
export function __resetConnectReturnForTests(): void {
  held = null;
  waiting = 0;
  unwatch?.();
}

/**
 * Take a home return's `?connect=` result and say it once the gate has
 * answered (see the top of this file).
 *
 * @param search `window.location.search`.
 * @returns the cleanup for the effect that calls it.
 */
export function takeConnectReturn(search: string, o: ConnectReturnOptions): () => void {
  if (new URLSearchParams(search).has('connect')) {
    held = readConnectReturn(search);
    o.clearLink();
  }
  const flow = held;
  if (flow === null) return () => {};

  /** Said, or dropped by a gate that failed. The caller marks itself done first: the write re-enters the subscription. */
  const settle = (s: AIConnectionState) => {
    held = null;
    if (s.phase === 'ready') apply(flow, s, o);
  };

  if (decided(useAIConnectionStore.getState())) {
    settle(useAIConnectionStore.getState());
    return () => {};
  }
  waiting += 1;
  let done = false;
  const unsub = useAIConnectionStore.subscribe((s) => {
    if (done || !decided(s)) return;
    done = true;
    waiting -= 1;
    unsub();
    settle(s);
  });
  return () => {
    if (done) return;
    done = true;
    waiting -= 1;
    unsub();
    setTimeout(() => {
      if (waiting === 0) held = null;
    }, 0);
  };
}
