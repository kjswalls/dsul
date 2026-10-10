/**
 * What an app connected over OAuth may do (memory/plans/mcp-oauth.md). Client-safe:
 * the consent page and Settings read the words; lib/mcp-oauth/core.ts the ids.
 *
 * `planner` is read and change, everything the MCP tools reach. `planner:read`
 * is the context, the item history and the agent's own queue, nothing that writes.
 */
export const SCOPES = ['planner', 'planner:read'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_WORDS: Record<Scope, string> = {
  planner: 'See and change your planner',
  'planner:read': 'See your planner, without changing it',
};

export function isScope(s: unknown): s is Scope {
  return typeof s === 'string' && (SCOPES as readonly string[]).includes(s);
}

/**
 * An access token's prefix, here rather than in core.ts because
 * lib/supabase-service.ts reads it and is in the browser bundle's import graph
 * (through lib/db.ts), where core.ts's node:crypto cannot go.
 */
export const ACCESS_PREFIX = 'dsul_at_';
