/**
 * Reading what a model sent as a tool call's arguments.
 *
 * Server-only. A model's arguments are untrusted text: anything that is not a
 * JSON object reads as `null`, and the caller answers that call with an error
 * rather than guessing what was meant. An empty string is `{}`, since some
 * hosts send nothing for a tool that takes no arguments.
 */

/** The longest arguments string read; a longer one is malformed. */
export const TOOL_ARGS_MAX_CHARS = 20_000;

export function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    if (raw.length > TOOL_ARGS_MAX_CHARS) return null;
    if (raw.trim() === '') return {};
    try {
      return asObject(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asObject(raw);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
