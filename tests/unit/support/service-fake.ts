/**
 * A stand-in for the service-role Supabase client, for the code that runs with
 * nobody watching: the reminder scan, the stakes settlement, the live Beeminder
 * post. Promoted from tests/unit/reminders-scan.test.ts so that every suite
 * pinning "claim, then act" (CLAUDE.md) reads the order off the same list.
 *
 * Two choices carry the weight:
 *
 *   - ONE ordered list. A statement lands in `calls` the moment its verb is
 *     chained, and `mark` puts what is not a statement (a push sent, a webhook
 *     posted) into the same list. So "claimed before it delivered" is one index
 *     compared with another, never a flag set from inside some mock's body.
 *   - Answers routed by (table, verb), never by a call queue. The code issues
 *     its reads and writes in an order that is an implementation detail, and a
 *     queue would make every reordering look like a regression, which is the
 *     kind of test that gets deleted instead of read. A suite whose answers move
 *     with state (the ledger row an upsert creates) passes a function instead.
 *
 * What it does not model is PostgREST. A filter is recorded, never applied: the
 * answer is whatever the test said it is.
 */

/** What a statement answers. Either half left out reads as null, as a real client gives it. */
export type FakeResult = { data?: unknown; error?: unknown };

/** The verbs `from(table)` offers, which open a statement. */
export type FakeOp = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

const OPS: readonly FakeOp[] = ['select', 'insert', 'update', 'upsert', 'delete'];
const WRITE_OPS: ReadonlySet<string> = new Set<FakeOp>(['insert', 'update', 'upsert', 'delete']);

/** The `table` of a `mark`: parenthesised, so no real table can share it. */
export const OUTSIDE = '(outside)';

export interface FakeCall {
  table: string;
  /** The statement's verb, or the label a `mark` was given. */
  op: string;
  /** The verb's first argument: the row or rows written, or the columns selected. Absent on a delete. */
  payload?: unknown;
  /** The verb's second argument when there is one: an upsert's onConflict, a select's count. */
  options?: unknown;
  /**
   * Everything chained after the verb, in order, as [method, args]: the
   * filters (`eq`, `or`, `is`, `in`, `not`) and the modifiers a real builder
   * takes in the same place (`select` on a write, `maybeSingle`).
   */
  filters: [method: string, args: unknown[]][];
}

/**
 * How a statement is answered: a map keyed `${table}.${op}`, or a function of
 * the whole call. Either way it is asked when the statement is awaited, so a
 * function sees every filter, and a key nobody set answers `{}`.
 */
export type Responder =
  | Partial<Record<string, FakeResult>>
  | ((call: FakeCall) => FakeResult | undefined);

export function makeServiceFake(respond: Responder = {}) {
  const calls: FakeCall[] = [];

  const answer = (call: FakeCall): Promise<{ data: unknown; error: unknown }> => {
    try {
      const result = (typeof respond === 'function' ? respond(call) : respond[`${call.table}.${call.op}`]) ?? {};
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    } catch (err) {
      return Promise.reject(err);
    }
  };

  // Every method chains and is recorded; awaiting the chain, or ending it with
  // maybeSingle/single, asks for the answer.
  const chain = (call: FakeCall): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              answer(call).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            call.filters.push([prop, args]);
            return prop === 'maybeSingle' || prop === 'single' ? answer(call) : chain(call);
          };
        },
      },
    );

  const verb =
    (table: string, op: FakeOp) =>
    (...args: unknown[]) => {
      const call: FakeCall = { table, op, filters: [] };
      if (args.length > 0) call.payload = args[0];
      if (args.length > 1) call.options = args[1];
      calls.push(call);
      return chain(call);
    };

  const service = {
    from: (table: string) => Object.fromEntries(OPS.map((op) => [op, verb(table, op)])),
  };

  return {
    /** Typed `never` so it passes for the ServiceClient any function under test asks for. */
    service: service as never,
    calls,
    /** The statements that change a row, in order: every call but the reads and the marks. */
    writes: () => calls.filter((c) => c.table !== OUTSIDE && WRITE_OPS.has(c.op)),
    /** Records something that is not a statement, in its place in the one list. */
    mark: (label: string, payload?: unknown): FakeCall => {
      const call: FakeCall = { table: OUTSIDE, op: label, filters: [] };
      if (payload !== undefined) call.payload = payload;
      calls.push(call);
      return call;
    },
  };
}

export type ServiceFake = ReturnType<typeof makeServiceFake>;
