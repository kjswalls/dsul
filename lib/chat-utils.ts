import type { ChatTarget } from './ai-types';

/**
 * Whoever is answering. The chat surface is named after the effective target,
 * so the placeholder, the empty state and the tab header all have to agree —
 * three places computing the same ternary is how a model's name ends up under
 * an OpenClaw transcript.
 *
 * The AI has no name of its own: a connected model is "AI"; OpenClaw keeps
 * its name because that is the agent's.
 */
export function chatAssistantName(t: ChatTarget | 'none' | string): 'AI' | 'OpenClaw' {
  return t === 'openclaw' ? 'OpenClaw' : 'AI';
}

/**
 * The same name, qualified by WHICH agent when there is more than one to mean.
 * Header rows use this; anything speaking to the user in a sentence uses the
 * bare name above.
 */
export function chatAssistantLabel(t: ChatTarget | string, agentId?: string | null): string {
  const name = chatAssistantName(t);
  return t === 'openclaw' && agentId ? `${name} · ${agentId}` : name;
}

/** The composer's placeholder for whoever answers. */
export function chatPlaceholder(t: ChatTarget | string): string {
  return t === 'openclaw' ? 'Message OpenClaw…' : 'Ask anything…';
}

/**
 * The same, for a box bound to one item's conversation: it says the item is
 * what it is about, since the box itself looks like every other one.
 */
export function itemChatPlaceholder(t: ChatTarget | string): string {
  return t === 'openclaw' ? 'Ask OpenClaw about this item…' : 'Ask about this item…';
}

/**
 * A stored assignee, as the user reads it. `'beacon'` is a persisted value from
 * before the AI lost its name, so it renders as "AI"; the stored value itself
 * is an external contract and is never rewritten.
 */
export function assigneeLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  if (raw === 'openclaw') return 'OpenClaw';
  if (raw === 'beacon') return 'AI';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Strips reasoning/internal tags from AI assistant output.
 *
 * Handles:
 * - <think>...</think> blocks (and unclosed <think>...EOF)
 * - <final>...</final> wrappers (content preserved, tags removed; unclosed tags also handled)
 * - [[reply_to ...]] routing tags (anywhere in the string)
 */
export function stripReasoningTags(text: string): string {
  // Remove <think>...</think> OR unclosed <think>...EOF
  let out = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
  // Unwrap <final>...</final> OR strip unclosed <final>...EOF
  out = out.replace(/<final>([\s\S]*?)(?:<\/final>|$)/gi, '$1')
  // Remove [[reply_to ...]] routing tags
  out = out.replace(/\[\[reply_to[^\]]*\]\]/gi, '')
  return out
}
