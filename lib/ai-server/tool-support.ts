/**
 * Whether the connected model can be offered tools (AI step 3: chat tools).
 *
 * Server-only. Decided when a chat asks, never stored: a stored answer would
 * need a migration and would go stale when a provider adds tools to a model.
 *
 * - OpenAI, Gemini and Anthropic: yes. Every chat model they list takes tools.
 * - OpenRouter: what its public catalog says (`supported_parameters` holding
 *   `tools`), read once an hour per server instance. A model missing from the
 *   catalog, or a catalog that cannot be read, is a no: chat then runs as it
 *   always has, on the snapshot alone.
 * - Other (an OpenAI-compatible host): what a probe says. Many local servers
 *   accept `tools` and ignore it, which would look like a model that never
 *   needs to look anything up, so the request is not enough: the probe asks
 *   the model to call one harmless tool, and only a call back is a yes. The
 *   answer is kept an hour per host, model and key (the key only as a hash, in
 *   this server instance's memory), like OpenRouter's catalog, and never
 *   written to the connection. A probe that could not be judged (a timeout,
 *   a refused key, a host that is down) is a no for a few minutes, so a blip
 *   does not take the lookups away for the hour.
 */

import { createHash } from 'node:crypto';
import type { ModelProviderId } from '@/lib/ai-types';
import { ProviderError } from './errors';
import { getAdapter, type ProviderCredentials, type ToolDef } from './providers';

export const CATALOG_TTL_MS = 60 * 60 * 1000;

let catalog: { at: number; tools: Map<string, boolean> } | null = null;
let inflight: Promise<Map<string, boolean> | null> | null = null;

async function openRouterCatalog(creds: ProviderCredentials, signal: AbortSignal, now: number) {
  if (catalog && now - catalog.at < CATALOG_TTL_MS) return catalog.tools;
  if (!inflight) {
    inflight = getAdapter('openrouter')
      .listModels(creds, signal)
      .then((list) => {
        const tools = new Map(list.models.map((m) => [m.id, m.tools === true] as const));
        catalog = { at: Date.now(), tools };
        return tools;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// ── the custom-host probe ───────────────────────────────────────────────────

export const PROBE_TTL_MS = CATALOG_TTL_MS;
/** How long a probe that could not be judged counts as a no before it is asked again. */
export const PROBE_RETRY_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
/** Room for a model that thinks before it calls; one that does not uses a few dozen. */
const PROBE_MAX_TOKENS = 1024;
/** Answers kept per server instance, oldest dropped first. */
const PROBE_MAX_ENTRIES = 500;

export const PROBE_TOOL: ToolDef = {
  name: 'check_connection',
  description: 'Confirms that the planner can be reached. Takes no arguments.',
  parameters: { type: 'object', properties: {} },
};
const PROBE_SYSTEM = 'Call the check_connection tool now. Do not answer in words.';

/** Kinds that are the host's answer about tools: a request it refused, or one it answered with nothing. */
const JUDGED = new Set(['bad_request', 'empty', 'refused']);

const probes = new Map<string, { at: number; ttl: number; tools: boolean }>();
const probing = new Map<string, Promise<boolean>>();

function probeKey(creds: ProviderCredentials, model: string): string {
  return createHash('sha256').update(`${creds.baseUrl}\n${model}\n${creds.apiKey}`).digest('hex');
}

async function runProbe(creds: ProviderCredentials, model: string): Promise<{ tools: boolean; ttl: number }> {
  try {
    const step = await getAdapter('custom').completeWithTools(creds, {
      model,
      modelMeta: {},
      system: [PROBE_SYSTEM],
      messages: [{ role: 'user', content: 'Check the connection.' }],
      tools: [PROBE_TOOL],
      maxOutputTokens: PROBE_MAX_TOKENS,
      // Its own deadline, not the asking request's: a probe in flight is shared
      // by every chat that asks meanwhile, and one Stop must not spoil it.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { tools: step.toolCalls.some((c) => c.name === PROBE_TOOL.name), ttl: PROBE_TTL_MS };
  } catch (err) {
    const judged = err instanceof ProviderError && JUDGED.has(err.kind);
    return { tools: false, ttl: judged ? PROBE_TTL_MS : PROBE_RETRY_MS };
  }
}

function probeCustomHost(creds: ProviderCredentials, model: string, signal: AbortSignal, now: number): Promise<boolean> {
  const key = probeKey(creds, model);
  const hit = probes.get(key);
  if (hit && now - hit.at < hit.ttl) return Promise.resolve(hit.tools);
  let pending = probing.get(key);
  if (!pending) {
    pending = runProbe(creds, model)
      .then(({ tools, ttl }) => {
        probes.delete(key);
        probes.set(key, { at: now, ttl, tools });
        if (probes.size > PROBE_MAX_ENTRIES) probes.delete(probes.keys().next().value as string);
        return tools;
      })
      .finally(() => probing.delete(key));
    probing.set(key, pending);
  }
  // A chat stopped while the probe runs stops waiting for it (as a no); the
  // probe itself runs on, and its answer is kept for the next ask.
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, () => resolve(false)).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function supportsTools(
  provider: ModelProviderId,
  model: string,
  creds: ProviderCredentials,
  signal: AbortSignal,
  now: number = Date.now()
): Promise<boolean> {
  switch (provider) {
    case 'openai':
    case 'gemini':
    case 'anthropic':
      return true;
    case 'custom':
      return probeCustomHost(creds, model, signal, now);
    case 'openrouter': {
      // The auto router picks a model per request, and may pick one without tools.
      if (model === 'openrouter/auto') return false;
      const tools = await openRouterCatalog(creds, signal, now);
      return tools?.get(model) === true;
    }
  }
}

/** Tests only: forget the cached catalog and every probe's answer. */
export function resetToolSupportCache(): void {
  catalog = null;
  inflight = null;
  probes.clear();
  probing.clear();
}
