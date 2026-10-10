import { isAuthApiError, type User } from '@supabase/supabase-js';
import { isModelProviderId, PROVIDER_META } from '@/lib/ai-types';
import { isKnownSecretKey } from '@/lib/extension-settings';
import { readAgentKey } from '@/lib/supabase-service';
import { KEY_SERVICES, type AccountFacts, type KeyService } from '@/lib/account-types';
import { appleRevocationConfig } from './apple';
import type { ServiceClient } from './http';

/**
 * What the delete confirmation tells the person before they delete: the
 * account it is about to delete, and what dsul can't delete for them
 * (memory/plans/account-deletion.md, "What the person is told").
 *
 * NAMES AND BOOLEANS, NEVER A VALUE. user_secrets is read here, on the server,
 * only to learn which services dsul held a key for; the values are mapped to
 * names the moment they are read and never logged or returned.
 *
 * ONLY THE USER READ CAN FAIL THE FACTS. Every other read is advisory: one that
 * fails drops its line and logs the table and the error's code, never a value,
 * so a lost line can never keep someone from deleting. A read that meets a
 * missing column or table (a database behind 033, 040 or 053) is "no" and
 * logs nothing, as readOpenClawStatus does. Its code set is
 * lib/ai-server/schema-codes.ts's four of them, kept here because
 * lib/account-server may not import lib/ai-server.
 *
 * THE AGENT KEY IS ASKED ABOUT THROUGH readAgentKey (lib/supabase-service.ts),
 * the one reader of that column, which also finds it in its pre-059 home,
 * user_settings, when user_secrets has no such column yet. Only whether there
 * is one survives this file.
 */

const MISSING_SCHEMA: ReadonlySet<string> = new Set(['42703', 'PGRST204', '42P01', 'PGRST205']);

type Row = Record<string, unknown> | null;
interface Read {
  data: unknown;
  error: { code?: unknown } | null;
}

const codeOf = (error: { code?: unknown } | null): string =>
  typeof error?.code === 'string' && error.code !== '' ? error.code : 'unknown';

/** The row, or null for none, a missing schema (silent) or a failure (one line). Never throws. */
async function advisory(table: string, read: () => PromiseLike<Read>): Promise<Row> {
  try {
    const { data, error } = await read();
    if (error) {
      const code = codeOf(error);
      if (!MISSING_SCHEMA.has(code)) console.warn('[account] facts', table, code);
      return null;
    }
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Row) : null;
  } catch {
    console.warn('[account] facts', table, 'threw');
    return null;
  }
}

const present = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** The provider ids of the user's Apple identities (the credential's `user`), each once. */
export function appleIdsOf(user: Pick<User, 'identities'>): string[] {
  const ids = (user.identities ?? [])
    .filter((identity) => identity.provider === 'apple' && typeof identity.id === 'string' && identity.id !== '')
    .map((identity) => identity.id);
  return [...new Set(ids)];
}

/** Does this slug's bag in reminder_secrets hold a credential, by /api/reminders/secrets' own test? */
function holdsSecret(bag: unknown, slug: string): boolean {
  if (typeof bag !== 'object' || bag === null) return false;
  const values = (bag as Record<string, unknown>)[slug];
  if (typeof values !== 'object' || values === null) return false;
  return Object.entries(values as Record<string, unknown>).some(
    ([key, value]) => typeof value === 'string' && value !== '' && isKnownSecretKey(slug, key),
  );
}

/** The services whose keys dsul held, in KEY_SERVICES' order. */
function keyServicesOf(secrets: Row): KeyService[] {
  if (!secrets) return [];
  const bag = secrets.reminder_secrets;
  const held: Record<KeyService, boolean> = {
    Beeminder: holdsSecret(bag, 'beeminder'),
    Twilio: holdsSecret(bag, 'sms-nudge') || holdsSecret(bag, 'phone-call'),
    'Home Assistant': holdsSecret(bag, 'voice-announcements'),
    OpenClaw: present(secrets.openclaw_gateway_token) || present(secrets.openclaw_hooks_token),
  };
  return KEY_SERVICES.filter((service) => held[service]);
}

/** The provider as Disconnect names it: its label, or a custom connection's host. */
function providerNameOf(connection: Row): string | null {
  const provider = connection?.provider;
  if (!isModelProviderId(provider)) return null;
  if (provider !== 'custom') return PROVIDER_META[provider].label;
  const baseUrl = connection?.base_url;
  if (typeof baseUrl !== 'string') return null;
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}

export async function readAccountFacts(
  svc: ServiceClient,
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AccountFacts | 'gone' | 'unavailable'> {
  let user: User | null;
  try {
    const { data, error } = await svc.auth.admin.getUserById(userId);
    if (error) return isAuthApiError(error) && error.status === 404 ? 'gone' : 'unavailable';
    user = data.user;
  } catch {
    return 'unavailable';
  }
  if (!user) return 'unavailable';

  const agentKey = async (): Promise<boolean> => {
    try {
      return (await readAgentKey(userId, svc)) !== null;
    } catch {
      // Its error carries the database's message, which is never logged here.
      console.warn('[account] facts', 'user_secrets', 'agent_key');
      return false;
    }
  };

  const [extension, stake, secrets, hasAgentKey, connection] = await Promise.all([
    advisory('user_extensions', () =>
      svc
        .from('user_extensions')
        .select('slug')
        .eq('user_id', userId)
        .eq('slug', 'beeminder')
        .eq('enabled', true)
        .maybeSingle(),
    ),
    advisory('stake_events', () =>
      svc.from('stake_events').select('user_id').eq('user_id', userId).limit(1).maybeSingle(),
    ),
    advisory('user_secrets', () =>
      svc
        .from('user_secrets')
        .select('reminder_secrets, openclaw_gateway_token, openclaw_hooks_token')
        .eq('user_id', userId)
        .maybeSingle(),
    ),
    agentKey(),
    advisory('model_connections', () =>
      svc.from('model_connections').select('provider, base_url').eq('user_id', userId).maybeSingle(),
    ),
  ]);

  return {
    userId,
    email: user.email || null,
    appleIds: appleIdsOf(user),
    appleRevocable: appleRevocationConfig(env) !== null,
    beeminder: extension !== null,
    ledger: stake !== null,
    openclaw: hasAgentKey || present(secrets?.openclaw_gateway_token),
    keyServices: keyServicesOf(secrets),
    modelProviderName: providerNameOf(connection),
  };
}
