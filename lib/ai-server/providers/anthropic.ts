/**
 * Anthropic, through the native Messages API via `@anthropic-ai/sdk`.
 *
 * Server-only (design 4.3). Nothing outside `providers/index.ts` imports this
 * file. Anthropic's OpenAI-compatible layer is not used: its own docs call it
 * not production-ready, and it ignores `response_format`.
 *
 * The client is always built with an explicit key, `authToken: null`,
 * `webhookKey: null`, a constant base URL, `logLevel: 'off'` and a
 * `guardedFetch`, so none of the SDK's environment fallbacks (key, auth token,
 * credential profiles, base URL, log level) can answer for a user. One
 * fallback cannot be switched off by an option: the SDK merges its
 * custom-headers env variable into every request's headers in the
 * constructor. The header allowlist on the fetch drops anything it injected.
 *
 * Effort: `output_config.effort: 'low'` is sent only when the model's own
 * capabilities say low effort is supported (captured into `model_meta` when
 * the model is chosen), because older models reject the field. There are no
 * server-side fallbacks (D4): the model is the user's choice, and a fallback
 * would bill a model they did not pick.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';
import { isModelId } from '@/lib/ai-types';
import { ProviderError, isDeadlineAbort, toProviderErrorFor } from '../errors';
import { guardedFetch } from '../url-policy';
import { parseToolArgs } from './tool-args';
import type {
  ChatTurn,
  CompletionRequest,
  ListedModel,
  ModelMeta,
  ProviderAdapter,
  ProviderCredentials,
  ToolCall,
  ToolRequest,
  ToolTurn,
} from './types';

const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-opus-5-5';
const LIST_CAP = 300;
const LABEL_MAX = 200;

/** Chat and propose: the route's signal carries the real deadline; this is a backstop per attempt. */
const CALL = { timeout: 60_000, maxRetries: 1 } as const;
/** List, describe and the check's test question: never retried by the SDK. */
const META = { timeout: 10_000, maxRetries: 0 } as const;

const ANTHROPIC_HEADERS = (n: string) =>
  ['x-api-key', 'anthropic-version', 'content-type', 'accept', 'user-agent'].includes(n) ||
  n.startsWith('x-stainless-');

function makeClient(creds: ProviderCredentials, limits: { timeout: number; maxRetries: number }): Anthropic {
  return new Anthropic({
    apiKey: creds.apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_ORIGIN,
    logLevel: 'off',
    timeout: limits.timeout,
    maxRetries: limits.maxRetries,
    fetch: guardedFetch({ origin: ANTHROPIC_ORIGIN, checkDns: false, headerAllowlist: ANTHROPIC_HEADERS }),
  });
}

/**
 * The Messages API wants alternating turns that start and end with the user,
 * and the current models take no assistant prefill: drop empty turns, drop
 * leading assistant turns, merge consecutive same-role turns, and drop a
 * trailing assistant turn.
 */
function normalizeTurns(turns: readonly ChatTurn[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const t of turns) {
    if (typeof t?.content !== 'string' || t.content.trim() === '') continue;
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (out.length === 0 && t.role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      last.content = `${last.content as string}\n\n${t.content}`;
    } else {
      out.push({ role: t.role, content: t.content });
    }
  }
  while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();
  if (out.length === 0) throw new ProviderError('bad_request');
  return out;
}

function baseParams(req: CompletionRequest) {
  const system = req.system.filter((s) => s.trim() !== '').join('\n\n');
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    ...(system ? { system } : {}),
    messages: normalizeTurns(req.messages),
    ...(req.modelMeta?.effortLow ? { output_config: { effort: 'low' as const } } : {}),
  };
}

/**
 * A conversation with tools, in the Messages shape: an assistant turn's calls
 * are `tool_use` blocks after its text, and results go back as `tool_result`
 * blocks in a user turn. Turns are merged and trimmed as `normalizeTurns`
 * does, so the results of several calls land in one user turn, and a call
 * whose arguments were malformed is echoed with `{}`.
 */
function normalizeToolTurns(turns: readonly ToolTurn[]): MessageParam[] {
  const out: { role: 'user' | 'assistant'; content: ContentBlockParam[] }[] = [];
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    const blocks: ContentBlockParam[] = [];
    if (t.role === 'tool') {
      blocks.push({ type: 'tool_result', tool_use_id: t.callId, content: t.content });
    } else {
      if (typeof t.content === 'string' && t.content.trim() !== '') blocks.push({ type: 'text', text: t.content });
      if (t.role === 'assistant') {
        for (const c of t.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        }
      }
    }
    if (blocks.length === 0) continue;
    if (out.length === 0 && role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();
  if (out.length === 0) throw new ProviderError('bad_request');
  // A tool_result must come before any text in its user turn.
  for (const m of out) {
    if (m.role === 'user') {
      m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
  }
  return out;
}

function readToolCalls(message: Message): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const b of message.content) {
    if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: parseToolArgs(b.input) });
  }
  return calls;
}

function listed(m: ModelInfo): ListedModel {
  const created = Date.parse(m.created_at);
  return {
    id: m.id,
    label: (typeof m.display_name === 'string' && m.display_name.trim() !== '' ? m.display_name : m.id).slice(
      0,
      LABEL_MAX
    ),
    effortLow: m.capabilities?.effort?.low?.supported === true,
    ...(typeof m.max_input_tokens === 'number' ? { contextLength: m.max_input_tokens } : {}),
    ...(Number.isFinite(created) ? { created: Math.floor(created / 1000) } : {}),
  };
}

export function createAnthropicAdapter(): ProviderAdapter {
  const fail = (err: unknown, phase: 'verify' | 'call', signal?: AbortSignal) =>
    toProviderErrorFor(err, 'anthropic', phase, signal);

  async function listModels(creds: ProviderCredentials, signal: AbortSignal) {
    const client = makeClient(creds, META);
    const models: ListedModel[] = [];
    const seen = new Set<string>();
    try {
      // Auto-paginates; newest first.
      for await (const m of client.models.list({ limit: 100 }, { signal })) {
        if (!isModelId(m.id) || seen.has(m.id)) continue;
        seen.add(m.id);
        models.push(listed(m));
        if (models.length >= LIST_CAP) break;
      }
    } catch (err) {
      throw fail(err, 'verify', signal);
    }
    return { models, listed: true };
  }

  return {
    id: 'anthropic',

    async openStream(creds, req) {
      const client = makeClient(creds, CALL);
      const params: MessageCreateParamsStreaming = { ...baseParams(req), stream: true };
      let stream: AsyncIterable<RawMessageStreamEvent>;
      try {
        // `create` rejects on a non-2xx before it returns (not `.stream()`,
        // which would resolve first and fail later).
        stream = await client.messages.create(params, { signal: req.signal });
      } catch (err) {
        throw fail(err, 'call', req.signal);
      }

      return (async function* deltas() {
        let refused = false;
        try {
          for await (const ev of stream) {
            if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              if (ev.delta.text) yield ev.delta.text;
            } else if (ev.type === 'message_delta' && ev.delta.stop_reason === 'refusal') {
              refused = true;
            }
          }
        } catch (err) {
          throw fail(err, 'call', req.signal);
        }
        // The SDK ends a stream quietly when its signal aborts; say why.
        if (req.signal.aborted) throw new ProviderError(isDeadlineAbort(req.signal) ? 'timeout' : 'aborted');
        // Any partial text has already streamed; the refusal follows it.
        if (refused) throw new ProviderError('refused');
      })();
    },

    async completeText(creds, req) {
      const client = makeClient(creds, CALL);
      const params: MessageCreateParamsNonStreaming = baseParams(req);
      let message: Message;
      try {
        message = await client.messages.create(params, { signal: req.signal });
      } catch (err) {
        throw fail(err, 'call', req.signal);
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('refused');
      const text = message.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (!text) throw new ProviderError('empty');
      return text;
    },

    async completeWithTools(creds, req: ToolRequest) {
      const client = makeClient(creds, CALL);
      const system = req.system.filter((s) => s.trim() !== '').join('\n\n');
      const params: MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        ...(system ? { system } : {}),
        messages: normalizeToolTurns(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: { ...t.parameters, type: 'object' as const },
        })),
        ...(req.modelMeta?.effortLow ? { output_config: { effort: 'low' as const } } : {}),
      };
      let message: Message;
      try {
        message = await client.messages.create(params, { signal: req.signal });
      } catch (err) {
        throw fail(err, 'call', req.signal);
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('refused');
      const text = message.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      const toolCalls = readToolCalls(message);
      if (!text && toolCalls.length === 0) throw new ProviderError('empty');
      return { text, toolCalls };
    },

    // The model list is free and answers 401 for a bad key: it IS the check.
    async verify(creds, { signal }) {
      return listModels(creds, signal);
    },

    listModels,

    // The check's test question (lib/ai-server/check.ts). The model list is
    // free and proves the key; only a message proves the account can be
    // billed for one.
    async ping(creds, model, signal) {
      const client = makeClient(creds, META);
      try {
        await client.messages.create(
          { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
          { signal }
        );
      } catch (err) {
        throw fail(err, 'call', signal);
      }
    },

    async describeModel(creds, model, signal): Promise<ModelMeta> {
      const client = makeClient(creds, META);
      try {
        const m = await client.models.retrieve(model, {}, { signal });
        return { effortLow: m.capabilities?.effort?.low?.supported === true };
      } catch (err) {
        throw fail(err, 'verify', signal);
      }
    },

    pickDefaultModel(result) {
      if (result.models.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
      return result.models[0]?.id ?? null;
    },
  };
}
