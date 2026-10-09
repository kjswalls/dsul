import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Webhook registrations that survive a cold start.
 *
 * These lived in an in-process Map under a comment saying "in production this
 * would live in Supabase" — and production arrived. On Vercel that Map dies
 * with the instance and is absent on every other one, so a plugin registered
 * against instance A never heard about a mutation served by instance B, and the
 * plugin re-registering on startup did not save it: the next cold start lost it
 * again.
 *
 * The table is the truth. Three properties carry the weight: a registration
 * written on one instance is visible from another, the read is cached so the
 * mutation path does not pay a query per write, and the whole thing degrades to
 * the old Map when the table is not deployed yet.
 */

const rows: Array<Record<string, unknown>> = [];
const selectSpy = vi.fn();
let selectError: { code?: string; message: string } | null = null;
let writeError: { code?: string; message: string } | null = null;

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, userId: string) => {
          selectSpy(userId);
          return Promise.resolve({
            data: selectError ? null : rows.filter((r) => r.user_id === userId),
            error: selectError,
          });
        },
      }),
      upsert: (row: Record<string, unknown>) => {
        if (!writeError) {
          const i = rows.findIndex(
            (r) => r.user_id === row.user_id && r.plugin_id === row.plugin_id
          );
          if (i >= 0) rows[i] = row;
          else rows.push(row);
        }
        return Promise.resolve({ error: writeError });
      },
      delete: () => ({
        eq: (_c: string, userId: string) => {
          // One plugin (`.eq(plugin_id)` follows), or every one the user has
          // (awaited as is: Unpair).
          const one = {
            eq: (_c2: string, pluginId: string) => {
              const i = rows.findIndex(
                (r) => r.user_id === userId && r.plugin_id === pluginId
              );
              if (i >= 0) rows.splice(i, 1);
              return Promise.resolve({ error: null });
            },
            then: (resolve: (v: unknown) => void) => {
              if (!writeError) {
                for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].user_id === userId) rows.splice(i, 1);
              }
              resolve({ error: writeError });
            },
          };
          return one;
        },
      }),
    }),
  }),
}));

const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));

const reg = (over: Record<string, unknown> = {}) => ({
  pluginId: 'dsul-context',
  webhookUrl: 'https://gateway.example/hook',
  secret: 's3cret',
  userId: 'u1',
  events: ['tasks.updated'],
  registeredAt: '2026-08-26T10:00:00.000Z',
  ...over,
});

/** Fresh module per test — the cache and the availability flag are module state. */
async function load() {
  vi.resetModules();
  return import('@/lib/openclaw-registry');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  rows.length = 0;
  selectSpy.mockClear();
  fetchSpy.mockClear();
  selectError = null;
  writeError = null;
  process.env.SUPABASE_SECRET_KEY = 'test-key';
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('surviving a cold start', () => {
  it('writes the registration to the table, not only to memory', async () => {
    const m = await load();
    await m.registerPlugin(reg());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'u1',
      plugin_id: 'dsul-context',
      webhook_url: 'https://gateway.example/hook',
    });
  });

  it('delivers to a registration this instance never saw', async () => {
    // The whole point: instance A registered, instance B is serving the write.
    const instanceA = await load();
    await instanceA.registerPlugin(reg());

    const instanceB = await load();
    await instanceB.notifyPlugins('u1', 'tasks.updated', { id: 't1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://gateway.example/hook');
  });

  it('replaces a plugin row on re-registration rather than accumulating', async () => {
    const m = await load();
    await m.registerPlugin(reg());
    await m.registerPlugin(reg({ webhookUrl: 'https://gateway.example/moved' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].webhook_url).toBe('https://gateway.example/moved');
  });

  it('forgets a deregistered plugin everywhere', async () => {
    const instanceA = await load();
    await instanceA.registerPlugin(reg());
    await instanceA.deregisterPlugin('u1', 'dsul-context');

    const instanceB = await load();
    await instanceB.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Unpair: every registration the user has', () => {
  it('goes from the table and from memory, and no other user\'s does', async () => {
    const instanceA = await load();
    await instanceA.registerPlugin(reg());
    await instanceA.registerPlugin(reg({ pluginId: 'second', webhookUrl: 'https://gateway.example/two' }));
    await instanceA.registerPlugin(reg({ userId: 'u2' }));

    expect(await instanceA.deregisterAllPlugins('u1')).toEqual({ ok: true, durable: true });
    expect(rows.map((r) => r.user_id)).toEqual(['u2']);
    expect([...instanceA.registeredPlugins.values()].map((r) => r.userId)).toEqual(['u2']);

    // This instance re-reads rather than serving its cached answer.
    await instanceA.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
    await instanceA.notifyPlugins('u2', 'tasks.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('says so when the table refused, and logs the code alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await load();
    await m.registerPlugin(reg());
    writeError = { code: '57014', message: 'canceling statement SENTINEL' };
    expect(await m.deregisterAllPlugins('u1')).toEqual({ ok: false, reason: 'deregister failed' });
    expect(warn).toHaveBeenCalledWith('[openclaw-registry] deregister all failed', '57014');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL');
    warn.mockRestore();
  });

  it('refuses to claim it when the table is not there', async () => {
    selectError = { code: '42P01', message: 'relation does not exist' };
    const m = await load();
    await m.notifyPlugins('u1', 'tasks.updated', {}); // trips the latch
    expect((await m.deregisterAllPlugins('u1')).ok).toBe(false);
  });
});

describe('who gets told', () => {
  it('never crosses a user boundary', async () => {
    const m = await load();
    await m.registerPlugin(reg({ userId: 'u1' }));
    await m.registerPlugin(reg({ userId: 'u2', pluginId: 'other' }));
    m.clearRegistrationCache();

    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledWith('u1');
  });

  it('honours the event filter', async () => {
    const m = await load();
    await m.registerPlugin(reg({ events: ['habits.updated'] }));
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours a wildcard subscription', async () => {
    const m = await load();
    await m.registerPlugin(reg({ events: ['*'] }));
    await m.notifyPlugins('u1', 'projects.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('signs the payload when a secret is set', async () => {
    const m = await load();
    await m.registerPlugin(reg());
    await m.notifyPlugins('u1', 'tasks.updated', { id: 't1' });
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Dsul-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('sends unsigned when the plugin chose not to set one', async () => {
    const m = await load();
    await m.registerPlugin(reg({ secret: '' }));
    await m.notifyPlugins('u1', 'tasks.updated', {});
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Dsul-Signature']).toBeUndefined();
  });
});

describe('the cache in front of the table', () => {
  it('does not query per mutation', async () => {
    // This runs on EVERY write. A query each to find the usually-zero rows
    // would be a real cost for a rare payoff.
    const m = await load();
    await m.registerPlugin(reg());
    m.clearRegistrationCache();

    for (let i = 0; i < 5; i++) await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('re-reads after a registration changes, so a new hook is not shut out', async () => {
    const m = await load();
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();

    // registerPlugin invalidates this user's cached answer.
    await m.registerPlugin(reg());
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('deployed ahead of the migration', () => {
  const missing = { code: '42P01', message: 'relation does not exist' };

  it('falls back to memory rather than failing to register', async () => {
    selectError = missing;
    writeError = missing;

    const m = await load();
    await m.registerPlugin(reg());
    await m.notifyPlugins('u1', 'tasks.updated', {});
    // The in-process Map still carries it — the pre-039 behaviour, unchanged.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('says the registration is not durable rather than just "ok"', async () => {
    writeError = missing;
    const m = await load();
    // Memory-only until this instance restarts, which is the bug 039 fixes.
    // Reporting plain success would make it silent instead of absent.
    expect(await m.registerPlugin(reg())).toEqual({ ok: true, durable: false });
  });

  it('refuses to claim a deregistration it could not perform', async () => {
    // The row may exist and be unreachable from here. Every other instance
    // keeps reading it and POSTing the user's items to a webhook they revoked.
    selectError = missing;
    const m = await load();
    await m.notifyPlugins('u1', 'tasks.updated', {}); // trips the latch
    const removed = await m.deregisterPlugin('u1', 'dsul-context');
    expect(removed.ok).toBe(false);
  });

  it('stops asking for a while, then tries again', async () => {
    /**
     * A one-way latch was wrong here. PostgREST returns PGRST205 for anything
     * missing from its SCHEMA CACHE, which includes the propagation window on
     * a table that genuinely exists — so one reply right after `db:push` would
     * have disabled persistence for the whole life of that instance.
     */
    selectError = { code: 'PGRST205', message: 'not in schema cache' };
    const m = await load();
    await m.notifyPlugins('u1', 'tasks.updated', {});
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(selectSpy).toHaveBeenCalledTimes(1);

    // The schema cache catches up.
    selectError = null;
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a revoked webhook when a read blips', async () => {
    // The table EXISTS and this was transient. The Map may hold a registration
    // revoked days ago on another instance, and delivering the user's items to
    // a webhook they took away is worse than missing a notification.
    const m = await load();
    await m.registerPlugin(reg());
    m.clearRegistrationCache();
    selectError = { code: '08006', message: 'connection failure' };

    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forgets a registration the table no longer has', async () => {
    // Deregistered on another instance, or the account cascaded away.
    const m = await load();
    await m.registerPlugin(reg());
    rows.length = 0;
    m.clearRegistrationCache();

    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
    // And it is gone from memory too, so a later blip cannot revive it.
    m.clearRegistrationCache();
    selectError = { code: '08006', message: 'blip' };
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('cache invalidation ordering', () => {
  it('does not serve the pre-write answer for a full TTL after a change', async () => {
    /**
     * `cache.delete` used to run BEFORE the write, and the dynamic import
     * guarantees an await boundary — so a concurrent notify could read the
     * pre-write table and re-cache it fresh, and the very instance that
     * accepted the change served the old answer for a minute.
     */
    const m = await load();
    await m.registerPlugin(reg());
    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await m.deregisterPlugin('u1', 'dsul-context');
    await m.notifyPlugins('u1', 'tasks.updated', {});
    // Still once: the second notify must not find the removed hook.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('in the browser', () => {
  it('does nothing, because lib/db.ts reaches this from the client too', async () => {
    // Next inlines only NEXT_PUBLIC_* into the client bundle, so the service key
    // is undefined there by construction. A no-op is exactly what the empty Map
    // did before, and it is why this gates on the KEY rather than on `window` —
    // the latter is present under jsdom, which would have made every server
    // path in this file silently untested.
    delete process.env.SUPABASE_SECRET_KEY;
    const m = await load();
    await m.registerPlugin(reg());
    await m.notifyPlugins('u1', 'tasks.updated', {});

    expect(rows).toHaveLength(0);
    expect(selectSpy).not.toHaveBeenCalled();
    // Still delivered from this instance's own Map, as before.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a webhook that fails', () => {
  it('does not throw into the mutation that triggered it', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('gateway down'));
    const m = await load();
    await m.registerPlugin(reg());
    await expect(m.notifyPlugins('u1', 'tasks.updated', {})).resolves.toBeUndefined();
  });

  it('survives a non-2xx without breaking the others', async () => {
    const m = await load();
    await m.registerPlugin(reg());
    await m.registerPlugin(reg({ pluginId: 'second', webhookUrl: 'https://b.example/hook' }));
    m.clearRegistrationCache();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });

    await m.notifyPlugins('u1', 'tasks.updated', {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
