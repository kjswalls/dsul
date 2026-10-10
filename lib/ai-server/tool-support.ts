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
 * - Other (an OpenAI-compatible host): no, until a probe exists. Many local
 *   servers accept `tools` and ignore it, which would look like a model that
 *   never needs to look anything up.
 */

import type { ModelProviderId } from '@/lib/ai-types';
import { getAdapter, type ProviderCredentials } from './providers';

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
      return false;
    case 'openrouter': {
      // The auto router picks a model per request, and may pick one without tools.
      if (model === 'openrouter/auto') return false;
      const tools = await openRouterCatalog(creds, signal, now);
      return tools?.get(model) === true;
    }
  }
}

/** Tests only: forget the cached catalog. */
export function resetToolSupportCache(): void {
  catalog = null;
  inflight = null;
}
