import type { ModelProviderId } from './ai-types';

/**
 * A model's name as a person reads it ("Gemini Flash"), never its raw id
 * ("gemini-flash-latest") where a name is known.
 *
 * Client-safe and pure. Three sources, in order:
 * 1. a short catalog of the ids dsul picks by default or that are common
 *    enough to name, with a line about what each is for;
 * 2. the shapes of Claude's and Gemini's versioned ids;
 * 3. the label the provider listed the model under, when the caller has it
 *    (the connect answer's `models`: Anthropic's and OpenRouter's own names).
 * Anything else reads as its id: an unknown model is still the person's choice.
 */

export interface ModelName {
  name: string;
  /** What it is for, in a few words, when the catalog knows ("Google’s quick everyday model"). */
  about: string | null;
}

const CATALOG: Readonly<Record<string, ModelName>> = Object.freeze({
  'gemini-flash-latest': { name: 'Gemini Flash', about: 'Google’s quick everyday model' },
  'gemini-flash-lite-latest': { name: 'Gemini Flash-Lite', about: 'Google’s fastest, lightest model' },
  'gemini-pro-latest': { name: 'Gemini Pro', about: 'Google’s most capable model' },
  'gpt-5': { name: 'GPT-5', about: null },
  'gpt-5-mini': { name: 'GPT-5 mini', about: 'OpenAI’s quick everyday model' },
  'gpt-5-nano': { name: 'GPT-5 nano', about: null },
  'gpt-4o': { name: 'GPT-4o', about: null },
  'gpt-4o-mini': { name: 'GPT-4o mini', about: null },
  'gpt-4.1': { name: 'GPT-4.1', about: null },
  'gpt-4.1-mini': { name: 'GPT-4.1 mini', about: null },
  'openrouter/auto': { name: 'Auto', about: 'OpenRouter picks the model for each question' },
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** claude-sonnet-4-5 → Claude Sonnet 4.5; claude-haiku-4-5-20251001 → Claude Haiku 4.5. */
const CLAUDE_RE = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;
/** gemini-2.5-flash → Gemini 2.5 Flash; gemini-2.5-flash-lite → Gemini 2.5 Flash-Lite. */
const GEMINI_RE = /^gemini-(\d{1,2}(?:\.\d{1,2})?)-(flash|pro)(-lite)?$/;

function fromShape(id: string): string | null {
  const c = CLAUDE_RE.exec(id);
  if (c) return `Claude ${cap(c[1])} ${c[3] ? `${c[2]}.${c[3]}` : c[2]}`;
  const g = GEMINI_RE.exec(id);
  if (g) return `Gemini ${g[1]} ${cap(g[2])}${g[3] ? '-Lite' : ''}`;
  return null;
}

/**
 * The model's name. `listed` is the label the provider listed it under, used
 * only when neither the catalog nor an id shape names it.
 */
export function modelName(provider: ModelProviderId, id: string, listed?: string | null): ModelName {
  const known = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (known && provider !== 'custom') return known;
  const shaped = provider === 'custom' ? null : fromShape(id);
  if (shaped) return { name: shaped, about: null };
  const label = typeof listed === 'string' ? listed.trim() : '';
  return { name: label && label !== id ? label : id, about: null };
}
