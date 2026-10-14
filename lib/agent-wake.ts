/**
 * Waking a connected app when work is handed to it (memory/plans/power-mode.md,
 * "Waking an app").
 *
 * An app connected over MCP can only be called while someone has a chat open
 * with it, so dsul cannot reach it on its own. A Claude Code routine can be
 * started over HTTP: a POST to its own /fire URL with its own bearer token
 * starts a run (https://code.claude.com/docs/en/routines, "Add an API
 * trigger"). The person saves that URL and token per app (Settings → AI →
 * Connected apps), and a hand-off to the app fires it, so the routine reads the
 * app's queue (`dsul_my_work`) at once instead of the next time anyone looks.
 *
 * Only a routine's /fire URL on api.anthropic.com is accepted: dsul's server
 * makes the request, and an arbitrary URL would let anyone signed in point it
 * at whatever host they liked. Another app with its own wake can join by
 * adding its URL shape here.
 *
 * The wake is a nudge, never the hand-off: a refused, failed or missing one
 * changes nothing, because the app still finds the item on its next read.
 */

/** The /fire endpoint: a routine id, nothing else in the path. */
const ROUTINE_FIRE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/([A-Za-z0-9_-]{1,100})\/fire$/;

/** Sent with every fire; the endpoint ships behind it while in research preview. */
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

/** The most item ids one fire names; past this the run reads its queue anyway. */
export const MAX_FIRE_ITEMS = 50;

export interface AgentWake {
  url: string;
  token: string;
}

/** The key a wake is stored under: an assignee folded as lib/agent-assignees.ts compares them. */
export function wakeKey(assignee: string): string {
  return assignee.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The routine URL as stored, or null when it is not a routine's /fire URL. */
export function routineFireUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  return ROUTINE_FIRE.test(url) ? url : null;
}

/** The token as stored, or null when it is blank, too long, or has spaces in it. */
export function routineToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token.length < 8 || token.length > 512 || /\s/.test(token)) return null;
  return token;
}

/** One stored wake, checked on read: a shape this build does not know is no wake. */
export function readWake(raw: unknown): AgentWake | null {
  if (!raw || typeof raw !== 'object') return null;
  const { url, token } = raw as { url?: unknown; token?: unknown };
  const u = routineFireUrl(url);
  const t = routineToken(token);
  return u && t ? { url: u, token: t } : null;
}

/** The names, folded, that have a usable wake in a stored bag. */
export function wakesSet(bag: unknown): string[] {
  if (!bag || typeof bag !== 'object') return [];
  return Object.entries(bag as Record<string, unknown>)
    .filter(([, v]) => readWake(v) !== null)
    .map(([k]) => k);
}

/**
 * What the run is told. Ids only, never titles: the routine reads each item
 * through its own MCP connection, and the text is labelled untrusted data on
 * arrival, so it only says where to look.
 */
export function fireText(itemIds: readonly string[]): string {
  const ids = itemIds.slice(0, MAX_FIRE_ITEMS);
  const n = itemIds.length;
  const what = n === 1 ? 'an item' : `${n} items`;
  return `dsul handed ${what} to you. Item ids: ${ids.join(', ')}. Read your queue with dsul_my_work.`;
}

/** Start the routine. Never throws; true when the endpoint accepted it. */
export async function fireRoutine(wake: AgentWake, text: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(wake.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wake.token}`,
        'anthropic-beta': ROUTINE_BETA,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}
