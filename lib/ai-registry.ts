/**
 * ai-registry.ts — the AI gate: what can answer right now, and what it can do.
 *
 * The sibling of [item-registry.ts](item-registry.ts), and it exists for the
 * same reason: every place that wants to ask "is there a model? is OpenClaw
 * paired? who answers?" asks this one pure function instead of re-deriving it.
 *
 * It FAILS CLOSED. Until the connection store has an answer from the server
 * (`phase === 'ready'`), every capability is off and every surface that would
 * talk to an AI hides. A surface offering chat that nothing will answer is the
 * thing this replaces; a brief absence while the status loads is the price.
 *
 * Pure: no store reads, no imports beyond types. lib/ai-connection-store.ts
 * feeds it both stores' state (`useAICapabilities` / `getAICapabilities`).
 */

import type { ChatTarget, ModelConnectionView, OpenClawView } from './ai-types';
import type { ConnectionPhase } from './ai-connection-store';

export interface AIInputs {
  phase: ConnectionPhase;
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
  /** Who the user chose on this device (lib/ai-settings-store.ts). */
  choice: ChatTarget;
}

export interface AICapabilities {
  /** The server has answered for this account. False → everything below is off. */
  known: boolean;
  /** Who EFFECTIVELY answers: the choice if usable, else the other, else none. */
  target: ChatTarget;
  canChat: boolean;
  canPropose: boolean;
  /** "Give to OpenClaw": an agent key exists, independent of who answers chat. */
  canDelegate: boolean;
  proposeTarget: 'model' | 'openclaw' | null;
  openclawTransport: 'gateway' | 'plugin' | null;
  answererName: 'AI' | 'OpenClaw' | null;
  agentId: string | null;
  modelUsable: boolean;
  openclawUsable: boolean;
  /** known && model?.status === 'failing' */
  modelFailing: boolean;
  /** known && !!model && (failing || !model.model) */
  modelNeedsAttention: boolean;
}

export const NO_AI: AICapabilities = Object.freeze({
  known: false,
  target: 'none',
  canChat: false,
  canPropose: false,
  canDelegate: false,
  proposeTarget: null,
  openclawTransport: null,
  answererName: null,
  agentId: null,
  modelUsable: false,
  openclawUsable: false,
  modelFailing: false,
  modelNeedsAttention: false,
}) as AICapabilities;

/**
 * The gate truth table (design 1.12). `known = phase === 'ready'`; anything
 * else is `NO_AI`, including `error` — a failed status read is not permission.
 */
export function resolveAICapabilities(i: AIInputs): AICapabilities {
  if (i.phase !== 'ready') return NO_AI;

  const model = i.model;
  const modelUsable = i.available && model?.status === 'ok' && !!model.model;
  const openclawTransport: AICapabilities['openclawTransport'] = i.openclaw.gateway
    ? 'gateway'
    : i.openclaw.pluginChat
      ? 'plugin'
      : null;
  const openclawUsable = openclawTransport !== null;

  let target: ChatTarget;
  switch (i.choice) {
    case 'model':
      target = modelUsable ? 'model' : openclawUsable ? 'openclaw' : 'none';
      break;
    case 'openclaw':
      target = openclawUsable ? 'openclaw' : modelUsable ? 'model' : 'none';
      break;
    case 'none':
    default:
      target = 'none';
  }

  // OpenClaw proposes only through its gateway. On the plugin path there is
  // no structured-proposal transport, and the propose route promises never to
  // reroute an OpenClaw user's planner to a model they did not pick (D14).
  const proposeTarget: AICapabilities['proposeTarget'] =
    target === 'model' ? 'model' : target === 'openclaw' && i.openclaw.gateway ? 'openclaw' : null;

  const modelFailing = model?.status === 'failing';

  return {
    known: true,
    target,
    canChat: target !== 'none',
    canPropose: proposeTarget !== null,
    canDelegate: i.openclaw.agent,
    proposeTarget,
    openclawTransport,
    answererName: target === 'model' ? 'AI' : target === 'openclaw' ? 'OpenClaw' : null,
    agentId: i.openclaw.agentId,
    modelUsable,
    openclawUsable,
    modelFailing,
    modelNeedsAttention: !!model && (modelFailing || !model.model),
  };
}
