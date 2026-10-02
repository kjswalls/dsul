'use client';

import { useMemo } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { resolveAICapabilities, type AICapabilities } from './ai-registry';
import { useAISettingsStore } from './ai-settings-store';
import {
  isModelId,
  isModelProviderId,
  type AIConnectionResponse,
  type ApiErrorCode,
  type ChatErrorCode,
  type ConnectRequest,
  type ConnectResponse,
  type ModelConnectionView,
  type ModelOption,
  type ModelsResponse,
  type OpenClawView,
} from './ai-types';

/**
 * ai-connection-store.ts — what can answer, as the server last said.
 *
 * The ONE source the AI gate reads (lib/ai-registry.ts): is a model connected
 * and working, is OpenClaw paired, may the browser even ask (`available`).
 * One GET (`/api/ai/connection`) answers all of it, at sign-in, in the burst
 * beside the planner load (components/providers/supabase-provider.tsx).
 *
 * NOT persisted, on purpose. A gate read off disk would be a previous
 * session's answer — or a previous ACCOUNT's — shown as this one's. Until the
 * server answers, `phase` is 'unknown' and every AI surface stays hidden: the
 * gate fails closed. The key the user types into `connect` is sent and
 * forgotten; it never enters this state.
 *
 * Does nothing at import: some tests import app-shell for its hooks alone.
 */

export type ConnectionPhase = 'unknown' | 'ready' | 'error';
/**
 * A write's answer. A failure carries the route's code and, when the route
 * named one (every 400 `invalid` does), the field it is about, so the panel can
 * say which: a key, a base URL, or a model the key cannot use.
 */
export type ApiFailure = { ok: false; code: ApiErrorCode; field?: string };
export type ApiResult = { ok: true } | ApiFailure;

export interface AIConnectionState {
  phase: ConnectionPhase;
  /** The account the current answer belongs to. Null until one has arrived. */
  hydratedUserId: string | null;
  /** When that answer arrived (ms). Drives the dedupe window. */
  fetchedAt: number | null;
  /** The server can hold a model key at all (env key set, table present). */
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
  models: ModelOption[] | null;
  modelsListed: boolean;
  modelsStatus: 'idle' | 'loading' | 'ready' | 'error';
  busy: null | 'connect' | 'model' | 'recheck' | 'disconnect';
}

export interface AIConnectionStore extends AIConnectionState {
  hydrate(userId: string): Promise<void>;
  /** hydrate(currentUserId) with the dedupe window bypassed. No-op when nobody is signed in. */
  refresh(): Promise<void>;
  /**
   * refresh() after a write this store did not make (an OpenClaw gateway save,
   * a plugin authorization): a status read begun before that write is stale,
   * so it is neither joined nor applied, and a fresh one is asked for.
   */
  serverChanged(): Promise<void>;
  /** PUT; on ok applies connection + models and drops the legacy notice (as does any status read naming a model). */
  connect(req: ConnectRequest): Promise<ApiResult>;
  /** PATCH {provider, model} */
  setModel(model: string): Promise<ApiResult>;
  /** PATCH {recheck:true} */
  recheck(): Promise<ApiResult>;
  /** DELETE; clears models */
  disconnect(): Promise<ApiResult>;
  /** GET /models */
  loadModels(opts?: { force?: boolean }): Promise<ApiResult>;
  /** 'auth' → model.status='failing' locally, then refresh(); 'not_connected' → refresh() */
  noteCallFailure(code: ChatErrorCode): void;
  reset(): void;
}

export const EMPTY_OPENCLAW: OpenClawView = Object.freeze({
  gateway: false,
  pluginChat: false,
  agent: false,
  agentId: null,
}) as OpenClawView;

const INITIAL: AIConnectionState = {
  phase: 'unknown',
  hydratedUserId: null,
  fetchedAt: null,
  available: false,
  model: null,
  openclaw: EMPTY_OPENCLAW,
  models: null,
  modelsListed: false,
  modelsStatus: 'idle',
  busy: null,
};

const CONNECTION_URL = '/api/ai/connection';
const MODELS_URL = '/api/ai/connection/models';

/**
 * How long an answer is trusted before a SIGNED_IN asks again.
 *
 * Supabase re-emits SIGNED_IN on every hidden → visible transition, so without
 * a window every tab return is a GET. Two speeds, because the answer that most
 * needs re-checking is "nothing can answer": setup finishes off-device or
 * server-side with no client signal (an OpenClaw plugin registering its chat
 * URL when its gateway restarts; a model connected on another device), and a
 * user mid-setup should see it on their next return, not five minutes later.
 * 30 s still swallows the burst of auth events one visibility change emits.
 */
export const DEDUPE_WINDOW_USABLE_MS = 5 * 60_000;
export const DEDUPE_WINDOW_NOTHING_MS = 30_000;

// ── Module state ────────────────────────────────────────────────────────────
// Held outside the store so a test's setState cannot fake it, and so `reset()`
// can invalidate everything in flight in one increment.

/** Who to ask for. Set by hydrate, cleared only by reset — so refresh works after a failed hydrate. */
let currentUserId: string | null = null;
/** The account epoch. Bumped on every change of user and on reset; a result from an older epoch is dropped. */
let generation = 0;
/** The user whose GET is in flight, and the promise to hand a duplicate caller. */
let inflightFor: string | null = null;
let inflight: Promise<void> | null = null;
let inflightToken: object | null = null;
/**
 * Bumped whenever the client learns the server moved by some road other than
 * a status read: a write applied its answer, or a call failed in a way only a
 * changed connection explains. A status read begun before the bump may
 * describe the world before it, so its answer is never applied (the read is
 * asked again instead), and nobody joins it. `generation` cannot do this job:
 * it only moves when the ACCOUNT does.
 */
let writeSeq = 0;
/** The `writeSeq` the in-flight status GET started at. */
let inflightSeq = -1;
/** Writes run one at a time, in call order. */
let writeQueue: Promise<unknown> = Promise.resolve();
/** The model-list GET in flight, handed to a duplicate caller. */
let modelsInflight: Promise<ApiResult> | null = null;
/**
 * Bumped whenever the model list is replaced by anything but its own GET: a
 * connect (which brings its own list), a disconnect, a status answer naming a
 * different provider or host. A list GET begun before the bump lists the
 * wrong connection's models, so its answer is never applied.
 */
let listSeq = 0;
/** The epoch the state was last wiped for, so a same-account retry does not wipe it again. */
let clearedGen = -1;

/** Forget every status read in flight (a fresh one is started on the next ask). */
function dropInflightStatus() {
  inflightFor = null;
  inflight = null;
  inflightToken = null;
  inflightSeq = -1;
}

/**
 * TEST ONLY — for tests/unit/helpers/ai-fixtures.ts `seedAI`. Makes `userId`
 * the signed-in account (null: nobody) the way `hydrate` would, minus the
 * read, and drops everything in flight, so a store seeded with `setState`
 * behaves like one a real answer filled: its writes, `refresh()` and
 * `loadModels()` reach fetch instead of answering 'unauthorized' unsent.
 * `reset()` undoes it. Touches no store state, so a re-seed is one update.
 */
export function __armUserForTests(userId: string | null): void {
  generation += 1;
  currentUserId = userId;
  clearedGen = generation;
  dropInflightStatus();
  modelsInflight = null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A server view, re-checked field by field. Anything that does not read as `ok` reads as failing. */
function readModelView(v: unknown): ModelConnectionView | null {
  if (!isObj(v) || !isModelProviderId(v.provider)) return null;
  const problem = v.problem === 'key_rejected' || v.problem === 'key_unreadable' ? v.problem : null;
  return {
    provider: v.provider,
    model: isModelId(v.model) ? v.model : null,
    baseUrl: strOrNull(v.baseUrl),
    authMethod: v.authMethod === 'oauth' ? 'oauth' : 'key',
    status: v.status === 'ok' ? 'ok' : 'failing',
    problem,
    checkedAt: strOrNull(v.checkedAt),
  };
}

function readOpenClaw(v: unknown): OpenClawView {
  if (!isObj(v)) return EMPTY_OPENCLAW;
  return {
    gateway: v.gateway === true,
    pluginChat: v.pluginChat === true,
    agent: v.agent === true,
    agentId: strOrNull(v.agentId),
  };
}

function readConnectionResponse(body: unknown): AIConnectionResponse | null {
  if (!isObj(body) || typeof body.available !== 'boolean') return null;
  return {
    available: body.available,
    model: body.available ? readModelView(body.model) : null,
    openclaw: readOpenClaw(body.openclaw),
  };
}

function readModelOptions(v: unknown): ModelOption[] {
  if (!Array.isArray(v)) return [];
  const out: ModelOption[] = [];
  for (const m of v) {
    if (!isObj(m) || !isModelId(m.id)) continue;
    const option: ModelOption = { id: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id };
    if (m.free === true) option.free = true;
    out.push(option);
  }
  return out;
}

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'unauthorized',
  'forbidden',
  'unavailable',
  'invalid',
  'too_large',
  'unsupported_media',
  'key_rejected',
  'unreachable',
  'blocked_url',
  'model_required',
  'not_connected',
  'busy',
  'conflict',
  'server',
];

function errorCodeOf(body: unknown, status: number): ApiErrorCode {
  const code = isObj(body) ? body.error : undefined;
  if (typeof code === 'string' && (API_ERROR_CODES as readonly string[]).includes(code)) {
    return code as ApiErrorCode;
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'busy';
  return 'server';
}

/** A failed write's result: the route's code, and the field it named, if it named one. */
function failureOf(body: unknown, status: number): ApiFailure {
  const code = errorCodeOf(body, status);
  const field = isObj(body) ? strOrNull(body.field) : null;
  return field === null ? { ok: false, code } : { ok: false, code, field };
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The same connection, as far as its model list goes: one provider, one host. */
function sameListSource(a: ModelConnectionView | null, b: ModelConnectionView | null): boolean {
  return a !== null && b !== null && a.provider === b.provider && a.baseUrl === b.baseUrl;
}

/** Something on the last answer could answer chat (the gate's two usable flags). */
function somethingCanAnswer(s: AIConnectionState): boolean {
  const caps = resolveAICapabilities({
    phase: 'ready',
    available: s.available,
    model: s.model,
    openclaw: s.openclaw,
    choice: 'model',
  });
  return caps.modelUsable || caps.openclawUsable;
}

function sendJson(method: 'PUT' | 'PATCH' | 'DELETE' | 'GET', url: string, body?: unknown) {
  return fetch(url, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export const useAIConnectionStore: UseBoundStore<StoreApi<AIConnectionStore>> =
  create<AIConnectionStore>()((set, get) => {
    /** The current account and epoch, captured when a write is ASKED for. */
    const capture = () => ({ uid: currentUserId, gen: generation });
    const stillCurrent = (c: { uid: string | null; gen: number }) =>
      c.uid !== null && c.uid === currentUserId && c.gen === generation;

    /** Serialize a write; it is skipped (and answers 'unauthorized') if the account changed first. */
    function enqueueWrite(
      busy: NonNullable<AIConnectionState['busy']>,
      job: (c: { uid: string; gen: number }) => Promise<ApiResult>
    ): Promise<ApiResult> {
      const c = capture();
      const run = async (): Promise<ApiResult> => {
        if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
        set({ busy });
        try {
          return await job(c as { uid: string; gen: number });
        } catch {
          return { ok: false, code: 'server' };
        } finally {
          if (stillCurrent(c)) set({ busy: null });
        }
      };
      const next = writeQueue.then(run, run);
      writeQueue = next.catch(() => undefined);
      return next;
    }

    /** What a write (or a failed call) taught us about the server: every status read begun before it is stale. */
    function serverMoved() {
      writeSeq += 1;
    }

    /** The model list was just replaced by something other than its own GET: a list GET begun before is stale. */
    function listReplaced() {
      listSeq += 1;
      modelsInflight = null;
    }

    /**
     * The account has a model, by whatever road: a key pasted here (the PUT),
     * an OpenRouter sign-in (its callback saves server-side and the panel only
     * refreshes), or a connection made on another device. Any of them completes
     * the move the legacy notice explains, so the flag goes for good; tied to
     * `model !== null` alone, a later disconnect would bring the notice back.
     * Guarded so a routine read does not rewrite the persisted blob.
     */
    function modelSeen() {
      const settings = useAISettingsStore.getState();
      if (settings.legacyNotice) settings.dismissLegacyNotice();
    }

    async function fetchStatus(userId: string, gen: number, seq: number): Promise<void> {
      let parsed: AIConnectionResponse | null;
      try {
        const res = await fetch(CONNECTION_URL, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        parsed = readConnectionResponse(await res.json());
        if (!parsed) throw new Error('malformed');
      } catch {
        if (gen !== generation || currentUserId !== userId) return;
        // A write landed while this was out: what it knows beats this
        // failure. Ask again rather than fail closed under it.
        if (seq !== writeSeq) return load(userId, true);
        const s = get();
        // A same-user refresh that failed keeps the answer already on screen.
        if (s.phase === 'ready' && s.hydratedUserId === userId) return;
        // Fail closed, and unlatch so the next SIGNED_IN tries again.
        set({ phase: 'error', hydratedUserId: null });
        return;
      }
      if (gen !== generation || currentUserId !== userId) return;
      // The server answered before a write that has since landed (a connect,
      // a disconnect, a model pick): applying it would undo that write on
      // screen. Ask again; the fresh answer includes the write.
      if (seq !== writeSeq) return load(userId, true);

      const prev = get().model;
      const patch: Partial<AIConnectionState> = {
        phase: 'ready',
        hydratedUserId: userId,
        fetchedAt: Date.now(),
        available: parsed.available,
        model: parsed.model,
        openclaw: parsed.openclaw,
      };
      // Connections are server-side, so one replaced on another device shows
      // up here. The cached list belongs to the old one: offering its ids
      // would send a PATCH the server refuses.
      if (!sameListSource(prev, parsed.model)) {
        listReplaced();
        Object.assign(patch, { models: null, modelsListed: false, modelsStatus: 'idle' });
      }
      set(patch);
      if (parsed.model) modelSeen();
    }

    function load(userId: string, bypassWindow: boolean): Promise<void> {
      // Join a read in flight only if it began after the last write; an older
      // one may answer with what that write replaced.
      if (inflightFor === userId && inflight && inflightSeq === writeSeq) return inflight;

      const s = get();
      if (
        !bypassWindow &&
        s.phase === 'ready' &&
        s.hydratedUserId === userId &&
        s.fetchedAt !== null
      ) {
        const windowMs = somethingCanAnswer(s) ? DEDUPE_WINDOW_USABLE_MS : DEDUPE_WINDOW_NOTHING_MS;
        if (Date.now() - s.fetchedAt < windowMs) return Promise.resolve();
      }

      // A different account (or none yet): nothing of the last answer may
      // show for a single frame under the new one. Once per account epoch —
      // a retry for the SAME account after a failed read keeps what its own
      // writes have put here (a connect's model list, a busy flag).
      if (s.hydratedUserId !== userId && clearedGen !== generation) {
        clearedGen = generation;
        set({ ...INITIAL });
      }

      const gen = generation;
      const seq = writeSeq;
      const token = {};
      inflightFor = userId;
      inflightToken = token;
      inflightSeq = seq;
      const p = fetchStatus(userId, gen, seq).finally(() => {
        if (inflightToken === token) dropInflightStatus();
      });
      inflight = p;
      return p;
    }

    return {
      ...INITIAL,

      hydrate: (userId) => {
        if (currentUserId !== userId) {
          generation += 1;
          currentUserId = userId;
          modelsInflight = null;
        }
        return load(userId, false);
      },

      refresh: () => {
        if (currentUserId === null) return Promise.resolve();
        return load(currentUserId, true);
      },

      serverChanged: () => {
        serverMoved();
        return get().refresh();
      },

      connect: (req) =>
        enqueueWrite('connect', async (c) => {
          const res = await sendJson('PUT', CONNECTION_URL, req);
          const body = await readBody(res);
          if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
          if (!res.ok) {
            if (isObj(body) && body.available === false) {
              serverMoved();
              set({ available: false });
            }
            return failureOf(body, res.status);
          }
          serverMoved();
          const data = (isObj(body) ? body : {}) as Partial<ConnectResponse>;
          const connection = readModelView(data.connection);
          if (!connection) {
            // Saved, but we cannot read what was saved: ask.
            void get().refresh();
            return { ok: false, code: 'server' };
          }
          listReplaced();
          set({
            available: true,
            model: connection,
            models: readModelOptions(data.models),
            modelsListed: data.listed === true,
            modelsStatus: 'ready',
          });
          modelSeen();
          // A connect from a gate that never answered (or failed) still owes
          // the OpenClaw half of the picture. A fresh read, never the one in
          // flight: that one began before the PUT.
          if (get().phase !== 'ready') void get().refresh();
          return { ok: true };
        }),

      setModel: (model) =>
        enqueueWrite('model', async (c) => {
          const current = get().model;
          if (!current) return { ok: false, code: 'not_connected' };
          const res = await sendJson('PATCH', CONNECTION_URL, { provider: current.provider, model });
          const body = await readBody(res);
          if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
          if (!res.ok) {
            const failure = failureOf(body, res.status);
            const { code } = failure;
            if (code === 'key_rejected' || code === 'not_connected' || code === 'conflict') {
              serverMoved();
              void get().refresh();
            }
            return failure;
          }
          serverMoved();
          const connection = readModelView(isObj(body) ? body.connection : null);
          if (connection) set({ model: connection });
          else void get().refresh();
          return { ok: true };
        }),

      recheck: () =>
        enqueueWrite('recheck', async (c) => {
          const res = await sendJson('PATCH', CONNECTION_URL, { recheck: true });
          const body = await readBody(res);
          if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
          if (!res.ok) {
            const failure = failureOf(body, res.status);
            const unavailable = isObj(body) && body.available === false;
            const refetch = failure.code === 'not_connected' || failure.code === 'key_rejected';
            if (unavailable || refetch) serverMoved();
            if (unavailable) set({ available: false });
            if (refetch) void get().refresh();
            return failure;
          }
          serverMoved();
          const connection = readModelView(isObj(body) ? body.connection : null);
          if (connection) set({ model: connection });
          else void get().refresh();
          return { ok: true };
        }),

      disconnect: () =>
        enqueueWrite('disconnect', async (c) => {
          const res = await sendJson('DELETE', CONNECTION_URL);
          const body = await readBody(res);
          if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
          if (!res.ok) return { ok: false, code: errorCodeOf(body, res.status) };
          serverMoved();
          listReplaced();
          set({ model: null, models: null, modelsListed: false, modelsStatus: 'idle' });
          return { ok: true };
        }),

      loadModels: (opts) => {
        const c = capture();
        if (c.uid === null) return Promise.resolve({ ok: false, code: 'unauthorized' });
        const s = get();
        if (!s.model) return Promise.resolve({ ok: false, code: 'not_connected' });
        if (modelsInflight) return modelsInflight;
        if (!opts?.force && s.modelsStatus === 'ready' && s.models) return Promise.resolve({ ok: true });
        set({ modelsStatus: 'loading' });
        const seq = listSeq;
        // The list was replaced while this was out (a connect brought its own,
        // a disconnect or another provider cleared it): this answer lists the
        // wrong connection. Answer the caller from what replaced it instead.
        const superseded = () => get().loadModels();
        const run = async (): Promise<ApiResult> => {
          try {
            const res = await sendJson('GET', MODELS_URL);
            const body = await readBody(res);
            if (!stillCurrent(c)) return { ok: false, code: 'unauthorized' };
            if (seq !== listSeq) return superseded();
            if (!res.ok) {
              set({ modelsStatus: 'error' });
              const code = errorCodeOf(body, res.status);
              if (code === 'key_rejected' || code === 'not_connected') {
                serverMoved();
                void get().refresh();
              }
              return { ok: false, code };
            }
            const data = (isObj(body) ? body : {}) as Partial<ModelsResponse>;
            set({
              models: readModelOptions(data.models),
              modelsListed: data.listed === true,
              modelsStatus: 'ready',
            });
            return { ok: true };
          } catch {
            if (!stillCurrent(c)) return { ok: false, code: 'server' };
            if (seq !== listSeq) return superseded();
            set({ modelsStatus: 'error' });
            return { ok: false, code: 'server' };
          }
        };
        const p = run().finally(() => {
          if (modelsInflight === p) modelsInflight = null;
        });
        modelsInflight = p;
        return p;
      },

      noteCallFailure: (code) => {
        if (code === 'auth') {
          // The server marked the key failing after any read now in flight
          // began; that read must not put 'ok' back.
          serverMoved();
          const model = get().model;
          if (model && model.status !== 'failing') {
            set({ model: { ...model, status: 'failing', problem: 'key_rejected' } });
          }
          void get().refresh();
        } else if (code === 'not_connected') {
          serverMoved();
          void get().refresh();
        }
      },

      reset: () => {
        generation += 1;
        dropInflightStatus();
        modelsInflight = null;
        currentUserId = null;
        clearedGen = generation;
        set({ ...INITIAL });
      },
    };
  });

/** The gate inputs this store contributes, as primitives, so `useShallow` can hold them still. */
function gateFields(s: AIConnectionState) {
  return {
    phase: s.phase,
    available: s.available,
    provider: s.model?.provider ?? null,
    modelId: s.model?.model ?? null,
    modelStatus: s.model?.status ?? null,
    gateway: s.openclaw.gateway,
    pluginChat: s.openclaw.pluginChat,
    agent: s.openclaw.agent,
    agentId: s.openclaw.agentId,
  };
}

/**
 * The gate, for a component. Re-renders only when an input the gate reads
 * changes — not on `busy`, the model list, `fetchedAt`, or a refresh that
 * brought back the same answer.
 */
export function useAICapabilities(): AICapabilities {
  const f = useAIConnectionStore(useShallow(gateFields));
  const choice = useAISettingsStore((s) => s.chatTarget);
  return useMemo(
    () =>
      resolveAICapabilities({
        phase: f.phase,
        available: f.available,
        // The gate reads `status` and `model` alone; the other view fields
        // are display, and selecting them would re-render every surface on
        // each recheck's new `checkedAt`.
        model:
          f.provider === null
            ? null
            : {
                provider: f.provider,
                model: f.modelId,
                status: f.modelStatus ?? 'failing',
                baseUrl: null,
                authMethod: 'key',
                problem: null,
                checkedAt: null,
              },
        openclaw: {
          gateway: f.gateway,
          pluginChat: f.pluginChat,
          agent: f.agent,
          agentId: f.agentId,
        },
        choice,
      }),
    [f, choice]
  );
}

/** The gate, for stores and commands (no subscription). */
export function getAICapabilities(): AICapabilities {
  const s = useAIConnectionStore.getState();
  return resolveAICapabilities({
    phase: s.phase,
    available: s.available,
    model: s.model,
    openclaw: s.openclaw,
    choice: useAISettingsStore.getState().chatTarget,
  });
}
