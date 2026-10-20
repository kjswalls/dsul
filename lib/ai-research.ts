import type { ModelProviderId } from './ai-types';

/**
 * WEB RESEARCH for prep (memory/plans/power-mode.md, "Research"): which
 * connected models can look things up before they get an item ready.
 *
 * Shared by the settings row (which says when a provider cannot) and the prep
 * route (which only ever asks one that can). Each provider searches with its
 * own tool, billed on the person's key:
 *
 * - Anthropic: the Messages API's web search server tool.
 * - OpenAI: the Responses API's web search tool (Chat Completions has none for
 *   most models).
 * - OpenRouter: its web plugin, on any model.
 * - Gemini and a custom host: no. Gemini's search lives in its native API, not
 *   the OpenAI-compatible endpoint dsul talks to, and a custom host has none.
 */
export function researchSupported(provider: ModelProviderId | null | undefined): boolean {
  return provider === 'anthropic' || provider === 'openai' || provider === 'openrouter';
}

/** Searches one prep ask may make: a batch is up to four items. */
export const RESEARCH_MAX_USES = 5;
