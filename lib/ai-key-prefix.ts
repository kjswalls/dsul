import type { ModelProviderId } from './ai-types';

/**
 * Which company a pasted key belongs to, read from its first few characters.
 *
 * Client-safe and pure (tests/unit/ai-server-boundary.test.ts). The browser
 * asks it before a key leaves the page, so a key pasted into the wrong box is
 * caught there; the connect route asks it again before any upstream call, so a
 * key detected as another company's is never sent to the one it was not made
 * for, whatever a client sends.
 *
 * A detection is only a guess. A key it cannot place returns null, and is sent
 * only where the person explicitly sends it; the provider's test call decides
 * whether a key works. Google changed its key format once (2026), and may
 * again. "Another service" (custom) is never checked: an OpenAI-compatible
 * host may issue keys in any shape, `sk-` included.
 *
 * Nothing here returns, stores or logs any part of the key.
 */

export type DetectedProvider = Exclude<ModelProviderId, 'custom'>;

/**
 * Order matters: Anthropic's and OpenRouter's keys also start with `sk-`, so
 * their longer prefixes are read first. Google AI Studio has issued `AQ.` auth
 * keys since 2026-05-28; older standard keys start `AIza`. Case-sensitive:
 * `aiza` is nobody's.
 */
const PREFIXES: ReadonlyArray<readonly [prefix: string, provider: DetectedProvider]> = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['sk-', 'openai'],
  ['AIza', 'gemini'],
  ['AQ.', 'gemini'],
];

/**
 * The forms only one company issues. A bare `sk-` is not one of them: DeepSeek,
 * Moonshot and others issue `sk-` keys too. OpenAI's own older keys carry its
 * marker (`T3BlbkFJ`, "OpenAI" in base64) in the middle.
 */
const SURE_PREFIXES: readonly string[] = ['sk-ant-', 'sk-or-', 'AIza', 'AQ.', 'sk-proj-', 'sk-svcacct-', 'sk-admin-'];
const OPENAI_MARKER = 'T3BlbkFJ';

export function detectKeyProvider(raw: string): DetectedProvider | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  for (const [prefix, provider] of PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) return provider;
  }
  return null;
}

/**
 * True when the detection is not a guess: the key has a form only its company
 * issues. A paste checks itself at once only when this holds; anything else
 * waits for the person to press Connect.
 */
export function isSureKey(raw: string): boolean {
  if (detectKeyProvider(raw) === null) return false;
  const key = raw.trim();
  if (SURE_PREFIXES.some((p) => key.startsWith(p))) return true;
  return key.startsWith('sk-') && key.includes(OPENAI_MARKER);
}

/**
 * The company a key was detected for, when that is not the one it is being
 * sent to. Null for custom, for a key nothing recognises, and for a match.
 */
export function mismatchedKey(provider: ModelProviderId, raw: string): DetectedProvider | null {
  if (provider === 'custom') return null;
  const detected = detectKeyProvider(raw);
  return detected !== null && detected !== provider ? detected : null;
}

/** What the connect route accepts as a key: printable ASCII, no spaces, 8 to 512 characters. */
export const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;

export function isPlausibleKey(raw: string): boolean {
  return typeof raw === 'string' && API_KEY_RE.test(raw.trim());
}
