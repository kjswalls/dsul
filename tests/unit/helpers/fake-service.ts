import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A service-role client stand-in for the recipe server runner's tests
 * (lib/recipes/server/): every query records its table and its chained calls,
 * and awaiting one asks `respond`. `rpc` records too. Nothing is real.
 */

export interface FakeQuery {
  table: string;
  calls: [string, unknown[]][];
}

export type FakeResult = { data?: unknown; error?: unknown; count?: number | null };

export const called = (q: FakeQuery, method: string) =>
  q.calls.filter(([m]) => m === method).map(([, args]) => args);

/** The query's verb. upsert before insert: a claim is an upsert. */
export const op = (q: FakeQuery) =>
  (['upsert', 'insert', 'update', 'delete', 'select'] as const).find((m) => called(q, m).length > 0);

/** The value a `.eq(column, value)` filtered on, if it did. */
export const eqOf = (q: FakeQuery, column: string): unknown =>
  called(q, 'eq').find(([c]) => c === column)?.[1];

export function fakeService(respond: (q: FakeQuery) => FakeResult) {
  const queries: FakeQuery[] = [];
  const rpc = vi.fn<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>(async () => ({
    data: null,
    error: null,
  }));
  const from = (table: string) => {
    const q: FakeQuery = { table, calls: [] };
    queries.push(q);
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => respond(q))
                .then(resolve, reject);
          }
          return (...args: unknown[]) => {
            q.calls.push([String(prop), args]);
            return builder;
          };
        },
      }
    );
    return builder;
  };
  const service = { from, rpc } as unknown as SupabaseClient;
  return { service, queries, rpc };
}
