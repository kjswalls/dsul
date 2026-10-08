/**
 * The shared AI gate fixture.
 *
 * Every test that renders an AI surface needs the gate in a known state, and
 * the gate reads TWO real stores: the server's answer (lib/ai-connection-store.ts)
 * and the device's choice (lib/ai-settings-store.ts). `seedAI` sets both in one
 * call and hands back the cleanup; `capsFor` computes what the gate would say
 * for the same seed, for a `vi.mock` factory that stands the store in.
 *
 * With no arguments the gate is `unknown` — the fail-closed state every
 * session starts in — so a test that forgets to seed sees no AI at all rather
 * than accidentally exercising a connected one.
 */

import type { ChatTarget, ModelConnectionView, OpenClawView } from '@/lib/ai-types';
import { resolveAICapabilities, type AICapabilities } from '@/lib/ai-registry';
import {
  __armUserForTests,
  useAIConnectionStore,
  type ConnectionPhase,
} from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';

export interface SeedAI {
  phase?: ConnectionPhase;
  available?: boolean;
  model?: Partial<ModelConnectionView> | null;
  openclaw?: Partial<OpenClawView>;
  choice?: ChatTarget;
  /** "No AI, thanks" on the account. Defaults to false: the answer said nothing was hidden. */
  aiHidden?: boolean | null;
  legacyNotice?: boolean;
}

/** The account a seed signs in as (every phase but 'unknown'). */
export const SEED_USER_ID = 'seed-user';

const MODEL_DEFAULTS: ModelConnectionView = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: null,
  authMethod: 'key',
  status: 'ok',
  problem: null,
  checkedAt: '2026-10-01T00:00:00.000Z',
  limitedUntil: null,
  modelLabel: null,
};

const OPENCLAW_DEFAULTS: OpenClawView = {
  gateway: false,
  pluginChat: false,
  agent: false,
  agentId: null,
};

interface ResolvedSeed {
  phase: ConnectionPhase;
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
  choice: ChatTarget;
  aiHidden: boolean | null;
  legacyNotice: boolean;
}

function resolveSeed(o: SeedAI = {}): ResolvedSeed {
  return {
    phase: o.phase ?? 'unknown',
    available: o.available ?? true,
    model: o.model ? { ...MODEL_DEFAULTS, ...o.model } : null,
    openclaw: { ...OPENCLAW_DEFAULTS, ...o.openclaw },
    choice: o.choice ?? 'model',
    aiHidden: o.aiHidden === undefined ? false : o.aiHidden,
    legacyNotice: o.legacyNotice ?? false,
  };
}

/** Phase ready, available, OpenAI with 'gpt-4o-mini', status ok. */
export const CONNECTED_MODEL: SeedAI = Object.freeze<SeedAI>({
  phase: 'ready',
  available: true,
  model: { provider: 'openai', model: 'gpt-4o-mini', status: 'ok' },
  openclaw: {},
  choice: 'model',
});

/** Phase ready, OpenClaw plugin chat + agent key, chosen; agentId 'kirby-1'; no model. */
export const OPENCLAW_PLUGIN: SeedAI = Object.freeze<SeedAI>({
  phase: 'ready',
  available: true,
  model: null,
  openclaw: { pluginChat: true, agent: true, agentId: 'kirby-1' },
  choice: 'openclaw',
});

/** Phase ready, available, no model, OpenClaw all false: the gate invites (`askInvite`). */
export const NOTHING_CONNECTED: SeedAI = Object.freeze<SeedAI>({
  phase: 'ready',
  available: true,
  model: null,
  openclaw: {},
  choice: 'model',
});

/** NOTHING_CONNECTED on an account that said "No AI, thanks": nothing offered at all. */
export const AI_HIDDEN: SeedAI = Object.freeze<SeedAI>({ ...NOTHING_CONNECTED, aiHidden: true });

/** Google Gemini saved, its key turned down, nothing else answering: the gate offers the fix (`askFix`). */
export const KEY_TURNED_DOWN: SeedAI = Object.freeze<SeedAI>({
  phase: 'ready',
  available: true,
  model: { provider: 'gemini', model: 'gemini-flash-latest', status: 'failing', problem: 'key_rejected' },
  openclaw: {},
  choice: 'model',
});

/**
 * What the gate resolves to for this seed. Pure: it never touches a store
 * binding, so it is safe inside (or beside) a `vi.mock('@/lib/ai-connection-store', …)`
 * factory even though this file imports that module. Keep it that way: under
 * such a mock, reading `useAIConnectionStore` here would throw.
 */
export function capsFor(o?: SeedAI): AICapabilities {
  const s = resolveSeed(o);
  return resolveAICapabilities({
    phase: s.phase,
    available: s.available,
    model: s.model,
    openclaw: s.openclaw,
    choice: s.choice,
    aiHidden: s.aiHidden,
  });
}

/**
 * Seeds BOTH real stores and returns the cleanup, which resets both.
 *
 * A seed is a whole new answer, not a patch: the model list, `busy` and
 * anything in flight from before are dropped with it, in ONE store update (a
 * re-seed mid-render never passes through an intermediate state). Set
 * `models` AFTER seeding if a test needs a list.
 *
 * Any phase but 'unknown' is a signed-in session, so the seed also makes
 * SEED_USER_ID the store's account, exactly as a sign-in would: `connect`,
 * `setModel`, `recheck`, `disconnect`, `loadModels` and `refresh()` then reach
 * fetch. ('error' is a sign-in whose read failed; the store still knows whom
 * to ask, as it does in the app.) 'unknown' is the moment before sign-in:
 * nobody is armed, and those calls do nothing, as they would then.
 */
export function seedAI(o?: SeedAI): () => void {
  const s = resolveSeed(o);
  const ready = s.phase === 'ready';
  __armUserForTests(s.phase === 'unknown' ? null : SEED_USER_ID);
  useAIConnectionStore.setState({
    phase: s.phase,
    hydratedUserId: ready ? SEED_USER_ID : null,
    fetchedAt: ready ? Date.now() : null,
    available: s.available,
    model: s.model,
    openclaw: s.openclaw,
    aiHidden: s.aiHidden,
    models: null,
    modelsListed: false,
    modelsStatus: 'idle',
    busy: null,
  });
  useAISettingsStore.setState({ chatTarget: s.choice, legacyNotice: s.legacyNotice });
  return () => {
    useAIConnectionStore.getState().reset();
    useAISettingsStore.getState().clearUserScopedState();
  };
}
