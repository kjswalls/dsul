import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { ACCESS_PREFIX } from '@/lib/mcp-oauth/core'
import { resolveAccessToken } from '@/lib/mcp-oauth/store'
import { AGENT_KEY_PREFIX, type Scope } from '@/lib/mcp-oauth/scopes'
import { resolveAgentKey } from '@/lib/agent-keys'
import { assigneeForName, queueForName } from '@/lib/agent-assignees'

/** lib/agent-handoff.ts `DELEGATE_ASSIGNEE`, spelled out: that module pulls in the planner store. */
const DELEGATE = 'openclaw'

/**
 * Who is calling an agent surface (/api/mcp, /api/agent/events): the OpenClaw
 * plugin's key (everything), or an OAuth app or a named agent key at its
 * scope. `who` is the assignee its queue answers to (lib/agent-assignees.ts),
 * asked only by the calls that need it, so no other call pays for the name.
 * An agent KEY named OpenClaw answers to OpenClaw's queue (`queueForName`);
 * an OAuth app by that name does not, since an app picks its own name.
 */
export type AgentCaller = { userId: string; scope: Scope; who: () => Promise<string> }

/** Matches no stored assignee: an app whose name cannot be one has no queue. */
export const NO_QUEUE = '\u0000'

async function nameOf(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  pick: (row: Record<string, unknown>) => unknown,
  queue: (name: unknown) => string | null
): Promise<string> {
  const { data, error } = await query
  if (error || !data || typeof data !== 'object') return NO_QUEUE
  return queue(pick(data as Record<string, unknown>)) ?? NO_QUEUE
}

/**
 * Resolves a bearer token to its caller, or null when it is no live token.
 * Throws when the database cannot answer, which a route reports as 503.
 */
export async function resolveAgentCaller(token: string): Promise<AgentCaller | null> {
  const service = createServiceClient()
  if (token.startsWith(ACCESS_PREFIX)) {
    const caller = await resolveAccessToken(service, token)
    if (!caller) return null
    return {
      userId: caller.userId,
      scope: caller.scope,
      who: () =>
        nameOf(
          service.from('mcp_oauth_grants').select('mcp_oauth_clients!inner(client_name)').eq('id', caller.grantId).maybeSingle(),
          (row) => {
            const client = row.mcp_oauth_clients as { client_name?: unknown } | { client_name?: unknown }[] | undefined
            return (Array.isArray(client) ? client[0] : client)?.client_name
          },
          // An OAuth app names ITSELF when it registers, so one calling itself
          // OpenClaw is not given OpenClaw's queue: only its own name.
          assigneeForName
        ),
    }
  }
  if (token.startsWith(AGENT_KEY_PREFIX)) {
    const caller = await resolveAgentKey(service, token)
    if (!caller) return null
    return {
      userId: caller.userId,
      scope: caller.scope,
      who: () =>
        nameOf(
          service.from('agent_keys').select('name').eq('id', caller.keyId).maybeSingle(),
          (row) => row.name,
          // A key's name is the user's own, typed in Settings or set by Connect,
          // so a key named OpenClaw is OpenClaw.
          queueForName
        ),
    }
  }
  const userId = await resolveUserIdFromApiKey(token, service)
  return userId ? { userId, scope: 'planner', who: async () => DELEGATE } : null
}
