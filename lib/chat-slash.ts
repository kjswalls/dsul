/**
 * / commands in the chat box (step 2c, memory/plans/ai-vision.md): a message
 * that starts with "/" lists the app's commands (lib/commands, the ⌘K
 * registry) under what follows it, and picking one runs it instead of sending
 * anything. Only at the very start of the message, so "and/or" or a path in
 * the middle of a question is never a command.
 */

/** A query longer than this is a message that happens to start with "/". */
const MAX_QUERY = 40

/** The command being typed: what follows the "/" up to the caret. */
export function activeSlash(text: string, caret: number): { query: string } | null {
  if (!text.startsWith('/') || caret < 1) return null
  const query = text.slice(1, caret)
  if (query.length > MAX_QUERY || /[\r\n]/.test(query)) return null
  return { query }
}
