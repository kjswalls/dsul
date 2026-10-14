/**
 * Who work can be handed to, beyond OpenClaw (memory/plans/power-mode.md,
 * build order 5).
 *
 * An app connected over MCP (Claude, Cursor: lib/mcp-oauth/) or a named agent
 * key (lib/agent-keys.ts) is an agent too, once it may change the planner.
 * Its assignee is its NAME as the user knows it ("Claude"), not an id: a name
 * survives disconnecting and connecting again, and the user's two Claude apps
 * sharing one queue is what "hand it to Claude" means. Names are compared
 * without case or extra spaces.
 *
 * Each agent's `dsul_my_work` serves only its own items (app/api/mcp/route.ts):
 * OpenClaw's queue is `openclaw`, plus the legacy `beacon` value it has always
 * served; an app's is its own name. So nothing handed to Claude is picked up by
 * OpenClaw, or the other way round.
 *
 * Pure and client-safe.
 */

import { assigneeLabel } from './chat-utils';

/** The stored value OpenClaw answers to. lib/agent-handoff.ts `DELEGATE_ASSIGNEE`. */
const OPENCLAW = 'openclaw';

/** Values that already mean something and are never an app's name. */
const RESERVED = new Set(['openclaw', 'beacon', 'ai', 'you', 'me']);

/** An agent the user can hand work to. */
export interface AgentAssignee {
  /** The stored `items.assignee` value. */
  assignee: string;
  /** As the user reads it. */
  name: string;
  kind: 'openclaw' | 'app' | 'key';
  /**
   * Started the moment work is handed to it (lib/agent-wake.ts). Absent for an
   * app that finds its work the next time it is opened, and for OpenClaw,
   * which hears its own work (/api/agent/events).
   */
  wake?: boolean;
}

/** A name, trimmed and with inner runs of space collapsed, compared without case. */
function fold(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The assignee an app or key with this name answers to, or null when the name
 * is blank, too long, or one the app already uses for something else.
 */
export function assigneeForName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > 60) return null;
  if (RESERVED.has(name.toLowerCase())) return null;
  return name;
}

/**
 * The name an OpenClaw connection's agent key carries (Settings → AI →
 * OpenClaw → Connect, app/api/ai/openclaw/route.ts). A KEY by this name
 * answers to OpenClaw's own queue rather than to a queue of its own name, so a
 * plugin-free OpenClaw and the plugin's key are one agent to the planner. Only
 * a key: its name is the user's, where an OAuth app names itself
 * (lib/agent-caller.ts).
 */
export const OPENCLAW_KEY_NAME = 'OpenClaw';

/**
 * The queue an agent KEY works from: OpenClaw's for the name OpenClaw (any
 * case), otherwise its own name (`assigneeForName`).
 */
export function queueForName(raw: unknown): string | null {
  if (typeof raw === 'string' && fold(raw) === fold(OPENCLAW_KEY_NAME)) return OPENCLAW;
  return assigneeForName(raw);
}

/** Whether two assignee values name the same agent. */
export function sameAssignee(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return fold(a) === fold(b);
}

/** Whether `assignee` is in the queue of the agent calling as `caller`. */
export function inQueueOf(assignee: unknown, caller: string): boolean {
  if (typeof assignee !== 'string' || assignee === '') return false;
  if (caller === OPENCLAW) return assignee === OPENCLAW || assignee === 'beacon';
  return sameAssignee(assignee, caller);
}

/**
 * The roster: OpenClaw first when paired, then apps and keys by name, one row
 * per name (two "Claude" apps are one agent).
 */
export function roster(
  openclaw: boolean,
  others: readonly { name: string; kind: 'app' | 'key' }[]
): AgentAssignee[] {
  const out: AgentAssignee[] = openclaw ? [{ assignee: OPENCLAW, name: assigneeLabel(OPENCLAW), kind: 'openclaw' }] : [];
  const seen = new Set<string>();
  for (const o of others) {
    const assignee = assigneeForName(o.name);
    if (!assignee || seen.has(fold(assignee))) continue;
    seen.add(fold(assignee));
    out.push({ assignee, name: assignee, kind: o.kind });
  }
  return out;
}
