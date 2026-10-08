/**
 * OpenAI, Google Gemini, OpenRouter and any OpenAI-compatible host ("Other"),
 * through the installed `openai` SDK with a per-provider base URL.
 *
 * Server-only (design 4.2). Nothing outside `providers/index.ts` imports this
 * file.
 *
 * The client is always built with an explicit key and base URL,
 * `organization: null`, `project: null`, `webhookSecret: null`,
 * `logLevel: 'off'` and a `guardedFetch` (with the error-body hints for
 * Gemini and OpenRouter, error-hints.ts), so none of the SDK's environment
 * defaults (its key, base URL, org, project, webhook secret and log-level
 * variables) are ever consulted: a server-wide key in the deployment's env can
 * never answer for a user, and debug logging, which prints request headers,
 * can never be switched on from outside.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { isModelId, type ModelProviderId } from '@/lib/ai-types';
import { hintingFetch } from '../error-hints';
import { ProviderError, classifyStatus, isDeadlineAbort, toProviderErrorFor } from '../errors';
import { readCappedJson } from '../stream';
import { CUSTOM_RESPONSE_CAPS, guardedFetch } from '../url-policy';
import type {
  CompletionRequest,
  ListedModel,
  ModelList,
  ProviderAdapter,
  ProviderCredentials,
  VerifyResult,
} from './types';

export type OpenAICompatibleProviderId = Exclude<ModelProviderId, 'anthropic'>;

interface Limits {
  timeout: number;
  maxRetries: number;
  /** Gemini and OpenRouter: which error-body hints the fetch throws (error-hints.ts). */
  throwAllHints: boolean;
}

/** Chat and propose: the route's signal carries the real deadline; this is a backstop per attempt. */
const CALL: Limits = { timeout: 60_000, maxRetries: 1, throwAllHints: false };
/**
 * Verify, list and the check's test question: never retried by the SDK (it
 * would obey an uncapped retry-after, and retry a thrown hint), so every hint
 * can be thrown.
 */
const META: Limits = { timeout: 10_000, maxRetries: 0, throwAllHints: true };

const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://do.dsul.app', 'X-Title': 'dsul' };
const OPENROUTER_KEY_MAX_BYTES = 64_000;
/** The public catalog (several hundred models, long descriptions) already sits near 2 MB. */
const OPENROUTER_LIST_MAX_BYTES = 8_000_000;
const OPENROUTER_LIST_CAP = 400;
const CUSTOM_LIST_CAP = 300;
const LABEL_MAX = 200;

/**
 * The guarded fetch, and for Gemini and OpenRouter the error-body hints on top
 * (error-hints.ts): their daily caps and Google's region refusal are told
 * apart from a minute's rate limit or a bad request only by the body.
 */
function providerFetch(
  provider: ModelProviderId,
  guarded: typeof fetch,
  limits: Pick<Limits, 'throwAllHints'>
): typeof fetch {
  if (provider !== 'gemini' && provider !== 'openrouter') return guarded;
  return hintingFetch(guarded, provider, { throwAll: limits.throwAllHints });
}

function makeClient(creds: ProviderCredentials, limits: Limits): OpenAI {
  const custom = creds.provider === 'custom';
  return new OpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseUrl,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: 'off',
    timeout: limits.timeout,
    maxRetries: limits.maxRetries,
    fetch: providerFetch(
      creds.provider,
      guardedFetch({
        origin: new URL(creds.baseUrl).origin,
        checkDns: custom,
        maxResponseBytes: custom ? CUSTOM_RESPONSE_CAPS : undefined,
      }),
      limits
    ),
    defaultHeaders: creds.provider === 'openrouter' ? OPENROUTER_HEADERS : undefined,
  });
}

// ── request shaping ─────────────────────────────────────────────────────────

/**
 * Gemini models that think by default. Their thinking tokens count against
 * `max_tokens`, so under MAX_OUTPUT_TOKENS an unguarded one can spend the whole
 * budget thinking and answer with nothing.
 *
 * Versioned ids think from 2.5 on (the version is compared as a number, so a
 * `gemini-10-…` is not read as 1.x). The unversioned family aliases
 * (`gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-pro-latest`)
 * point at the current release of a thinking family, and `pickGemini` chooses
 * `gemini-flash-latest` by default, so they count too. A versioned alias such
 * as `gemini-1.5-flash-latest` goes by its version. Anything else is left
 * alone: sending `reasoning_effort` to a model that cannot think is a 400.
 */
const GEMINI_THINKING_ALIAS_RE = /^gemini-(?:flash|flash-lite|pro)-latest$/;
const GEMINI_VERSION_RE = /^gemini-(\d+)(?:\.(\d+))?-/;

function geminiThinks(model: string): boolean {
  if (GEMINI_THINKING_ALIAS_RE.test(model)) return true;
  const m = GEMINI_VERSION_RE.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 5);
}

function wantsLowReasoning(p: OpenAICompatibleProviderId, model: string): boolean {
  if (p === 'openai') return /^(o\d|gpt-5)/.test(model) && !/-chat/.test(model);
  if (p === 'gemini') return geminiThinks(model);
  return false;
}

function baseParams(p: OpenAICompatibleProviderId, req: CompletionRequest) {
  const system = req.system.filter((s) => s.trim() !== '').join('\n\n');
  const messages: ChatCompletionMessageParam[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...req.messages.map((t) => ({ role: t.role, content: t.content })),
  ];
  return {
    model: req.model,
    messages,
    ...(p === 'openai'
      ? { max_completion_tokens: req.maxOutputTokens }
      : { max_tokens: req.maxOutputTokens }),
    ...(wantsLowReasoning(p, req.model) ? { reasoning_effort: 'low' as const } : {}),
    ...(req.json && (p === 'openai' || p === 'gemini')
      ? { response_format: { type: 'json_object' as const } }
      : {}),
  };
}

// ── <think> spans ───────────────────────────────────────────────────────────

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/** How many trailing characters of `buf` could be the start of `tag`. */
function partialTagSuffix(buf: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
    if (tag.startsWith(buf.slice(-n))) return n;
  }
  return 0;
}

/**
 * Drops `<think>…</think>` spans from streamed content, including tags split
 * across deltas. Some hosts put a reasoning model's thinking in `content`
 * instead of a separate field.
 */
class ThinkFilter {
  private inThink = false;
  private carry = '';
  private trimNext = false;

  push(delta: string): string {
    let buf = this.carry + delta;
    this.carry = '';
    let out = '';
    while (buf) {
      if (!this.inThink) {
        const i = buf.indexOf(OPEN_TAG);
        if (i === -1) {
          const hold = partialTagSuffix(buf, OPEN_TAG);
          out += buf.slice(0, buf.length - hold);
          this.carry = buf.slice(buf.length - hold);
          buf = '';
        } else {
          out += buf.slice(0, i);
          buf = buf.slice(i + OPEN_TAG.length);
          this.inThink = true;
        }
      } else {
        const j = buf.indexOf(CLOSE_TAG);
        if (j === -1) {
          const hold = partialTagSuffix(buf, CLOSE_TAG);
          this.carry = buf.slice(buf.length - hold);
          buf = '';
        } else {
          buf = buf.slice(j + CLOSE_TAG.length);
          this.inThink = false;
          this.trimNext = true;
        }
      }
    }
    return this.emit(out);
  }

  flush(): string {
    const rest = this.inThink ? '' : this.carry;
    this.carry = '';
    return this.emit(rest);
  }

  /** The blank lines a model leaves after `</think>` are not part of the answer. */
  private emit(s: string): string {
    if (!this.trimNext || !s) return s;
    const trimmed = s.trimStart();
    if (trimmed) this.trimNext = false;
    return trimmed;
  }
}

function stripThink(text: string): string {
  const f = new ThinkFilter();
  return f.push(text) + f.flush();
}

// ── model lists ─────────────────────────────────────────────────────────────

interface RawModel {
  id: unknown;
  created?: unknown;
}

function label(s: string): string {
  return s.slice(0, LABEL_MAX);
}

/** Every listed id passes `isModelId` BEFORE any filter, default, dedupe or cap (design 4.1). */
function validModels(raw: readonly RawModel[], stripPrefix?: string): ListedModel[] {
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const m of raw) {
    if (typeof m?.id !== 'string') continue;
    const id = stripPrefix && m.id.startsWith(stripPrefix) ? m.id.slice(stripPrefix.length) : m.id;
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const created = typeof m.created === 'number' && Number.isFinite(m.created) ? m.created : undefined;
    out.push({ id, label: label(id), ...(created !== undefined ? { created } : {}) });
  }
  return out;
}

const OPENAI_KEEP = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_DROP =
  /(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct|codex|computer-use|dall-e|whisper|davinci|babbage)/;
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

const byNewest = (a: ListedModel, b: ListedModel) =>
  (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id);

function filterOpenAI(models: ListedModel[]): ListedModel[] {
  const kept = models.filter(
    (m) => OPENAI_KEEP.test(m.id) && !OPENAI_DROP.test(m.id) && !DATED_SNAPSHOT.test(m.id)
  );
  return (kept.length > 0 ? kept : models).slice().sort(byNewest);
}

const GEMINI_DROP = /(embedding|aqa|imagen|veo|tts|image|live|native-audio|learnlm)/;

function filterGemini(models: ListedModel[]): ListedModel[] {
  return models
    .filter((m) => m.id.startsWith('gemini-') && !GEMINI_DROP.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function filterCustom(models: ListedModel[]): ListedModel[] {
  return models.filter((m) => !/embed/i.test(m.id)).slice(0, CUSTOM_LIST_CAP);
}

function pickOpenAI(models: ListedModel[]): string | null {
  const newest = (re: RegExp) => models.filter((m) => re.test(m.id)).sort(byNewest)[0]?.id ?? null;
  return (
    newest(/^gpt-[0-9.]+o?-mini$/) ??
    (models.some((m) => m.id === 'gpt-4o-mini') ? 'gpt-4o-mini' : null) ??
    newest(/^gpt-/) ??
    models[0]?.id ??
    null
  );
}

function pickGemini(models: ListedModel[]): string | null {
  if (models.some((m) => m.id === 'gemini-flash-latest')) return 'gemini-flash-latest';
  let best: { id: string; version: number } | null = null;
  for (const m of models) {
    const match = /^gemini-(\d+(?:\.\d+)?)-flash$/.exec(m.id);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = { id: m.id, version };
  }
  if (best) return best.id;
  return models.find((m) => m.id.includes('flash'))?.id ?? models[0]?.id ?? null;
}

function pickOpenRouter(result: VerifyResult): string {
  if (result.freeTier) {
    const free = result.models
      .filter((m) => m.free)
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
    if (free[0]) return free[0].id;
  }
  return 'openrouter/auto';
}

/** OpenRouter's public catalog entry: only these fields are read. */
function openRouterEntry(raw: unknown): ListedModel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isModelId(r.id)) return null;

  const arch = (typeof r.architecture === 'object' && r.architecture) as Record<string, unknown> | false;
  const outputs = arch && Array.isArray(arch.output_modalities) ? arch.output_modalities : null;
  const textOut = outputs
    ? outputs.includes('text')
    : arch && typeof arch.modality === 'string'
      ? /->.*text/.test(arch.modality)
      : false;
  if (!textOut) return null;

  const pricing = (typeof r.pricing === 'object' && r.pricing) as Record<string, unknown> | false;
  const free = !!pricing && pricing.prompt === '0' && pricing.completion === '0';
  const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name : r.id;
  const context =
    typeof r.context_length === 'number' && Number.isFinite(r.context_length) ? r.context_length : undefined;
  const created = typeof r.created === 'number' && Number.isFinite(r.created) ? r.created : undefined;
  return {
    id: r.id,
    label: label(name),
    ...(free ? { free: true } : {}),
    ...(context !== undefined ? { contextLength: context } : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

// ── the adapter ─────────────────────────────────────────────────────────────

export function createOpenAICompatibleAdapter(id: OpenAICompatibleProviderId): ProviderAdapter {
  const fail = (err: unknown, phase: 'verify' | 'call', signal?: AbortSignal) =>
    toProviderErrorFor(err, id, phase, signal);

  /** A raw GET through the same guarded fetch, for OpenRouter's non-OpenAI endpoints. */
  async function rawJson(
    creds: ProviderCredentials,
    path: string,
    opts: { signal: AbortSignal; withKey: boolean; maxBytes: number }
  ): Promise<unknown> {
    const origin = new URL(creds.baseUrl).origin;
    const fetchGuarded = providerFetch(id, guardedFetch({ origin, checkDns: false }), META);
    try {
      const res = await fetchGuarded(`${creds.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(opts.withKey ? { authorization: `Bearer ${creds.apiKey}` } : {}),
          ...OPENROUTER_HEADERS,
        },
        signal: opts.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new ProviderError(classifyStatus(res.status, id, 'verify'), res.status);
      }
      return await readCappedJson(res, opts.maxBytes);
    } catch (err) {
      throw fail(err, 'verify', opts.signal);
    }
  }

  async function listViaSdk(creds: ProviderCredentials, signal: AbortSignal): Promise<ListedModel[]> {
    const client = makeClient(creds, META);
    const page = await client.models.list({ signal });
    const raw = (page.data ?? []) as unknown as RawModel[];
    return validModels(raw, id === 'gemini' ? 'models/' : undefined);
  }

  async function listOpenRouter(creds: ProviderCredentials, signal: AbortSignal): Promise<ModelList> {
    const body = await rawJson(creds, '/models', { signal, withKey: false, maxBytes: OPENROUTER_LIST_MAX_BYTES });
    const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : null;
    if (!Array.isArray(data)) throw new ProviderError('upstream');
    const seen = new Set<string>();
    const entries: ListedModel[] = [];
    for (const raw of data) {
      const entry = openRouterEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    // Keep the newest when capping, then present by name.
    const models = entries
      .sort(byNewest)
      .slice(0, OPENROUTER_LIST_CAP)
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    return { models, listed: true };
  }

  /** A 1-token call that exercises the key on `model`, its failure classified for `phase`. */
  async function pingModel(
    creds: ProviderCredentials,
    model: string,
    signal: AbortSignal,
    phase: 'verify' | 'call'
  ): Promise<void> {
    const client = makeClient(creds, META);
    try {
      await client.chat.completions.create(
        { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        { signal }
      );
    } catch (err) {
      throw fail(err, phase, signal);
    }
  }

  /**
   * The check's test question (lib/ai-server/check.ts): streamed, as Ask
   * streams, so it exercises the request shape Ask sends. It does not make
   * the check fail a model that only refuses a streamed request: that 400
   * reads as `bad_request`, which the check passes as the model's business,
   * not the key's. One output token, under the same token parameter chat
   * sends, and read to the end, since a stream can still fail after it starts.
   */
  async function ping(creds: ProviderCredentials, model: string, signal: AbortSignal): Promise<void> {
    const client = makeClient(creds, META);
    const params: ChatCompletionCreateParamsStreaming = {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      ...(id === 'openai' ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
      stream: true,
    };
    try {
      const stream = await client.chat.completions.create(params, { signal });
      for await (const chunk of stream) void chunk;
    } catch (err) {
      throw fail(err, 'call', signal);
    }
    // The SDK ends a stream quietly when its signal aborts: that is no answer.
    if (signal.aborted) throw new ProviderError(isDeadlineAbort(signal) ? 'timeout' : 'aborted');
  }

  /** A host that cannot list its models answers one of these to `GET /models`. */
  const NO_LIST_STATUSES = new Set([404, 405, 501]);

  async function listModels(creds: ProviderCredentials, signal: AbortSignal): Promise<ModelList> {
    if (id === 'openrouter') return listOpenRouter(creds, signal);
    try {
      const models = await listViaSdk(creds, signal);
      if (id === 'openai') return { models: filterOpenAI(models), listed: true };
      if (id === 'gemini') return { models: filterGemini(models), listed: true };
      return { models: filterCustom(models), listed: true };
    } catch (err) {
      const e = fail(err, 'verify', signal);
      if (id === 'custom' && e.status !== undefined && NO_LIST_STATUSES.has(e.status)) {
        return { models: [], listed: false };
      }
      throw e;
    }
  }

  return {
    id,

    async openStream(creds, req) {
      const client = makeClient(creds, CALL);
      const params: ChatCompletionCreateParamsStreaming = { ...baseParams(id, req), stream: true };
      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        // `create` rejects on a non-2xx before it returns, which is what lets a
        // route answer JSON before any stream exists.
        stream = await client.chat.completions.create(params, { signal: req.signal });
      } catch (err) {
        throw fail(err, 'call', req.signal);
      }

      return (async function* deltas() {
        const think = new ThinkFilter();
        let emitted = false;
        let filtered = false;
        try {
          for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            const content = choice?.delta?.content;
            if (typeof content === 'string' && content !== '') {
              const out = think.push(content);
              if (out) {
                emitted = true;
                yield out;
              }
            }
            if (choice?.finish_reason === 'content_filter') filtered = true;
          }
        } catch (err) {
          throw fail(err, 'call', req.signal);
        }
        const tail = think.flush();
        if (tail) {
          emitted = true;
          yield tail;
        }
        // The SDK ends a stream quietly when its signal aborts; say why.
        if (req.signal.aborted) throw new ProviderError(isDeadlineAbort(req.signal) ? 'timeout' : 'aborted');
        if (filtered && !emitted) throw new ProviderError('refused');
      })();
    },

    async completeText(creds, req) {
      const client = makeClient(creds, CALL);
      const params: ChatCompletionCreateParamsNonStreaming = baseParams(id, req);
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create(params, { signal: req.signal });
      } catch (err) {
        throw fail(err, 'call', req.signal);
      }
      const choice = completion.choices?.[0];
      const raw = choice?.message?.content;
      const text = typeof raw === 'string' ? stripThink(raw).trim() : '';
      if (text) return text;
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
        throw new ProviderError('refused');
      }
      throw new ProviderError('empty');
    },

    async verify(creds, { signal, modelHint }) {
      if (id === 'openrouter') {
        // GET /key is free and answers 401 for a bad key. Only `is_free_tier`
        // is read: `label` is a masked copy of the key itself.
        const body = await rawJson(creds, '/key', { signal, withKey: true, maxBytes: OPENROUTER_KEY_MAX_BYTES });
        const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : null;
        const freeTier =
          typeof data === 'object' && data !== null && (data as Record<string, unknown>).is_free_tier === true;
        return { models: [], listed: false, freeTier };
      }

      const listed = await listModels(creds, signal);
      if (id !== 'custom') return listed;

      if (listed.listed) {
        // Some hosts list their models without checking the key (OpenRouter's
        // catalog is public, and so is llama-server's), so a list proves the
        // host, not the key. With a model known (the one named, or the only
        // one listed, which becomes the default), a 1-token call checks the
        // key too. It is judged as a chat would be: only a 401 is a refused
        // key, since a 403 there is the model's access, not the key's, and
        // anything else says nothing the list did not.
        const probe = isModelId(modelHint)
          ? modelHint
          : listed.models.length === 1
            ? listed.models[0].id
            : undefined;
        if (probe) {
          try {
            await pingModel(creds, probe, signal, 'call');
          } catch (err) {
            if (err instanceof ProviderError && err.kind === 'auth') throw err;
          }
        }
        return listed;
      }

      // A custom host that cannot list: check the key with a 1-token call on
      // the model the user named, or ask for one.
      if (!isModelId(modelHint)) throw new ProviderError('model_required');
      await pingModel(creds, modelHint, signal, 'verify');
      return { models: [], listed: false };
    },

    listModels,

    ping,

    pickDefaultModel(result) {
      switch (id) {
        case 'openai':
          return pickOpenAI(result.models);
        case 'gemini':
          return pickGemini(result.models);
        case 'openrouter':
          return pickOpenRouter(result);
        case 'custom':
          return result.models.length === 1 ? result.models[0].id : null;
      }
    },
  };
}
