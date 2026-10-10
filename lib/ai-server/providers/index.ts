/**
 * The provider registry: which adapter answers for a provider, and the
 * credentials it is handed.
 *
 * Server-only (design 1.6). Adapters are stateless (each call builds its own
 * SDK client around the credentials it is given), so one per provider is
 * created lazily and reused.
 */

import type { ModelProviderId } from '@/lib/ai-types';
import { ProviderError } from '../errors';
import { checkModelBaseUrl } from '../url-policy';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderAdapter, ProviderCredentials } from './types';

export type {
  ChatTurn,
  CompletionRequest,
  ListedModel,
  ModelList,
  ModelMeta,
  ProviderAdapter,
  ProviderCredentials,
  ToolCall,
  ToolDef,
  ToolRequest,
  ToolStep,
  ToolTurn,
  VerifyResult,
} from './types';

export const BUILTIN_BASE_URLS: {
  openai: 'https://api.openai.com/v1';
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai';
  openrouter: 'https://openrouter.ai/api/v1';
  anthropic: 'https://api.anthropic.com';
} = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com',
};

const adapters = new Map<ModelProviderId, ProviderAdapter>();

export function getAdapter(id: ModelProviderId): ProviderAdapter {
  const cached = adapters.get(id);
  if (cached) return cached;
  const adapter = id === 'anthropic' ? createAnthropicAdapter() : createOpenAICompatibleAdapter(id);
  adapters.set(id, adapter);
  return adapter;
}

/**
 * Re-runs checkModelBaseUrl for custom; throws ProviderError('blocked_url') if
 * the stored URL no longer passes.
 */
export function credentialsFor(
  provider: ModelProviderId,
  baseUrl: string | null,
  apiKey: string
): ProviderCredentials {
  if (provider === 'custom') {
    const policy = checkModelBaseUrl(baseUrl);
    if (!policy.ok) throw new ProviderError('blocked_url');
    return { provider, apiKey, baseUrl: policy.baseUrl };
  }
  return { provider, apiKey, baseUrl: BUILTIN_BASE_URLS[provider] };
}
