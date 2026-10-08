/**
 * ai-pane-state.ts: what Settings → AI draws, as data.
 *
 * The pane (components/settings/ai-pane.tsx) and its Connection section
 * (components/settings/model-connection-panel.tsx) ask these pure functions
 * which sections show, which form "Use AI in dsul" takes, which word the
 * Connection pill says and which body sits under it, so a state is decided in
 * one place and a table test can walk every one of them. Pure: no React, no
 * store reads. The store's types come in with `import type` only, and the one
 * runtime import is the gate's own `nothingConnected` (lib/ai-registry.ts), so
 * the pane and the invitation never disagree about what "nothing" means.
 *
 * The pill and the body are separate questions on purpose. A connect or a
 * recheck in flight turns only the pill to "Checking…": `connectionBody` never
 * reads `busy`, so the card under it (and a key typed into its field) stays
 * mounted while the answer is out.
 */

import type { ChatTarget, ModelConnectionView, OpenClawView } from './ai-types';
import type { AIConnectionState, ConnectionPhase } from './ai-connection-store';
import { nothingConnected } from './ai-registry';

/** Every record the AI pane draws or anchors. The ids are permanent (settings deep links). */
export const AI_PANE_IDS = [
  'beacon.useAi',
  'beacon.apiKey',
  'beacon.model',
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
] as const;
export type AIPaneRecordId = (typeof AI_PANE_IDS)[number];

// Aliases of the store's own types, never restated unions that can drift.
export type AIPhase = ConnectionPhase;
export type AIBusy = AIConnectionState['busy'];

export type ConnectionPill = 'checking' | 'not_set_up' | 'working' | 'needs_attention' | 'daily_limit';
export type PillTone = 'grey' | 'lime' | 'honey';

/**
 * A parseable limitedUntil after nowMs; with no clock yet (null), any
 * parseable one counts. The server sends `limitedUntil` only while it is in
 * the future, so the clock only matters for a pane left open across the reset.
 */
export function limitInForce(model: ModelConnectionView | null, nowMs: number | null): boolean {
  if (!model?.limitedUntil) return false;
  const until = Date.parse(model.limitedUntil);
  if (Number.isNaN(until)) return false;
  return nowMs === null || until > nowMs;
}

/**
 * unknown → checking; error → null; !available → null; busy connect|recheck → checking;
 * !model → not_set_up; failing → needs_attention (beats a limit); !model.model → needs_attention;
 * limitInForce → daily_limit; else working.
 *
 * Failing beats a limit: a chat sets the limit, and a later refusal of the key
 * sets failing, which is the newer and the one that needs the person.
 */
export function connectionPill(
  s: { phase: AIPhase; available: boolean; model: ModelConnectionView | null; busy: AIBusy },
  nowMs: number | null
): ConnectionPill | null {
  if (s.phase === 'unknown') return 'checking';
  if (s.phase === 'error') return null;
  if (!s.available) return null;
  if (s.busy === 'connect' || s.busy === 'recheck') return 'checking';
  if (!s.model) return 'not_set_up';
  if (s.model.status === 'failing') return 'needs_attention';
  if (!s.model.model) return 'needs_attention';
  if (limitInForce(s.model, nowMs)) return 'daily_limit';
  return 'working';
}

/** 'Checking…' | 'Not set up' | 'Working' | 'Needs attention' | `Daily limit · back at ${resetsAt}` | 'Daily limit'. */
export function connectionPillLabel(pill: ConnectionPill, resetsAt: string | null): string {
  switch (pill) {
    case 'checking':
      return 'Checking…';
    case 'not_set_up':
      return 'Not set up';
    case 'working':
      return 'Working';
    case 'needs_attention':
      return 'Needs attention';
    case 'daily_limit':
      return resetsAt ? `Daily limit · back at ${resetsAt}` : 'Daily limit';
  }
}

/**
 * working → lime only with canChat, else grey; needs_attention and
 * daily_limit → honey; the rest grey. Lime means something answers here: a
 * working key on a device whose chat is Off is still grey.
 */
export function connectionPillTone(pill: ConnectionPill, canChat: boolean): PillTone {
  if (pill === 'working') return canChat ? 'lime' : 'grey';
  if (pill === 'needs_attention' || pill === 'daily_limit') return 'honey';
  return 'grey';
}

/**
 * Which body the Connection section draws. Never reads `busy`, so a check in flight keeps its body mounted.
 * unknown → checking; error → failed; !available → unavailable; !model → connect; failing → fix;
 * model.model && limitInForce → limit; else working (no model picked is `working`, with the picker open).
 */
export type ConnectionBody = 'checking' | 'failed' | 'unavailable' | 'connect' | 'fix' | 'limit' | 'working';
export function connectionBody(
  s: { phase: AIPhase; available: boolean; model: ModelConnectionView | null },
  nowMs: number | null
): ConnectionBody {
  if (s.phase === 'unknown') return 'checking';
  if (s.phase === 'error') return 'failed';
  if (!s.available) return 'unavailable';
  if (!s.model) return 'connect';
  if (s.model.status === 'failing') return 'fix';
  if (s.model.model && limitInForce(s.model, nowMs)) return 'limit';
  return 'working';
}

/** phase === 'ready' && aiHidden === true. No `available` condition: "No AI" hides OpenClaw chat too. */
export function isAIOff(s: { phase: AIPhase; aiHidden: boolean | null }): boolean {
  return s.phase === 'ready' && s.aiHidden === true;
}

export type UseAIForm = 'pending' | 'unavailable' | 'button' | 'on' | 'off';

/** The record's reason while the check failed (search shows it after "Unavailable: "). */
export const USE_AI_CHECK_FAILED = 'Couldn’t check your AI connection.';
/** The pane's whole status line while the check failed: the card below already says why. */
export const USE_AI_CHECK_FAILED_LINE = 'Unavailable until the check below works.';
/** 060 is missing: the account cannot keep the choice (the gateway rows' sentence). */
export const USE_AI_NEEDS_UPDATE = 'Needs a database update that has not landed here yet.';
/** "Use AI in dsul"'s description, by form. `on` is also the record's description. */
export const USE_AI_COPY: Readonly<{ button: string; on: string; off: string }> = Object.freeze({
  button:
    'AI is optional. No AI, thanks hides Ask and every invitation to set it up, on all your devices. You can turn it back on here.',
  on: 'Off hides Ask, plan suggestions, Break it down and every invitation to set AI up, on all your devices. dsul works fully either way.',
  off: 'AI is off. Ask, plan suggestions, Break it down and every invitation to set AI up are hidden on all your devices.',
});

export interface AIPaneInput {
  phase: AIPhase;
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
  aiHidden: boolean | null;
  choice: ChatTarget;
  /** AIPane's latch: On this device was shown earlier in this visit (section 1.0). Default false. */
  keepDevice?: boolean;
}

export type AliasId = Exclude<AIPaneRecordId, 'beacon.useAi'>;

export interface AIPaneLayout {
  /** phase === 'ready' */
  known: boolean;
  /** isAIOff */
  aiOff: boolean;
  /** known && nothingConnected(model, openclaw) */
  nothingConnected: boolean;
  explainer: 'none' | 'tiles' | 'sentence';
  useAi: UseAIForm;
  /** The record's reason: USE_AI_CHECK_FAILED | USE_AI_NEEDS_UPDATE | null. */
  useAiReason: string | null;
  /** The pane's status line: 'Still loading…' | USE_AI_CHECK_FAILED_LINE | `Unavailable: ${USE_AI_NEEDS_UPDATE}` | null. */
  useAiLine: string | null;
  /** known && !aiOff */
  showOpenClaw: boolean;
  /** known && !aiOff && (!nothingConnected || choice === 'none' || keepDevice) */
  showDevice: boolean;
  /** Which of the Connection section's four fixed alias slots wear their id. */
  connectionAliases: readonly AliasId[];
  /** Which ids the AI-off card wears (all six while it is shown). */
  offCardAliases: readonly AliasId[];
}

const NO_ALIASES: readonly AliasId[] = Object.freeze([]);
const CONNECTION_SLOTS: readonly AliasId[] = Object.freeze([
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
] as const);
const DEVICE_IDS: readonly AliasId[] = Object.freeze(['beacon.provider', 'beacon.instructions'] as const);
const OFF_CARD_IDS: readonly AliasId[] = Object.freeze([
  'beacon.apiKey',
  'beacon.model',
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
] as const);

/**
 * The pane's shape for one state. Every id in AI_PANE_IDS has exactly one
 * anchor in every state: a real row, or an alias on the section that stands
 * in for it (the Connection slots while unknown, failed, or while On this
 * device is hidden; the AI-off card while AI is off).
 */
export function aiPaneLayout(i: AIPaneInput): AIPaneLayout {
  const known = i.phase === 'ready';
  const aiOff = isAIOff(i);
  const nothing = known && nothingConnected(i.model, i.openclaw);

  const explainer: AIPaneLayout['explainer'] = !known || aiOff ? 'none' : nothing ? 'tiles' : 'sentence';

  let useAi: UseAIForm;
  let useAiReason: string | null = null;
  let useAiLine: string | null = null;
  if (i.phase === 'unknown') {
    useAi = 'pending';
    useAiLine = 'Still loading…';
  } else if (i.phase === 'error') {
    useAi = 'unavailable';
    useAiReason = USE_AI_CHECK_FAILED;
    useAiLine = USE_AI_CHECK_FAILED_LINE;
  } else if (i.aiHidden === null) {
    useAi = 'unavailable';
    useAiReason = USE_AI_NEEDS_UPDATE;
    useAiLine = `Unavailable: ${USE_AI_NEEDS_UPDATE}`;
  } else if (i.aiHidden === true) {
    useAi = 'off';
  } else if (nothing) {
    useAi = 'button';
  } else {
    useAi = 'on';
  }

  const showOpenClaw = known && !aiOff;
  const showDevice = known && !aiOff && (!nothing || i.choice === 'none' || i.keepDevice === true);

  const connectionAliases = !known ? CONNECTION_SLOTS : aiOff ? NO_ALIASES : showDevice ? NO_ALIASES : DEVICE_IDS;
  const offCardAliases = aiOff ? OFF_CARD_IDS : NO_ALIASES;

  return {
    known,
    aiOff,
    nothingConnected: nothing,
    explainer,
    useAi,
    useAiReason,
    useAiLine,
    showOpenClaw,
    showDevice,
    connectionAliases,
    offCardAliases,
  };
}

export interface OpenClawStatus {
  /** agent || gateway */
  paired: boolean;
  /** gateway || pluginChat */
  answers: boolean;
  agent: boolean;
  /**
   * agentId only while a chat transport is live: (pluginChat || gateway) &&
   * agentId && agentId !== 'main'; else 'OpenClaw'. The column outlives the
   * chat URL (lib/ai-server/connections.ts), and the status route already
   * ignores a stale one (tests/unit/openclaw-status-route.test.ts).
   */
  name: string;
}

export function openClawStatus(o: OpenClawView): OpenClawStatus {
  const answers = o.gateway || o.pluginChat;
  const name = answers && o.agentId && o.agentId !== 'main' ? o.agentId : 'OpenClaw';
  return { paired: o.agent || o.gateway, answers, agent: o.agent, name };
}
