/**
 * "The migration is not there yet", as a database error code.
 *
 * Server-only. One set for every AI table and RPC, so a deploy that lands
 * ahead of its migration degrades the same way everywhere (503 'unavailable',
 * never a 500):
 *   42P01     undefined table
 *   PGRST205  PostgREST: table not in its schema cache
 *   PGRST202  PostgREST: function not in its schema cache
 *   42883     undefined function
 *   42703     undefined column
 *   PGRST204  PostgREST: column not in its schema cache
 *
 * The PGRST codes also cover a freshly pushed migration whose `notify pgrst`
 * PostgREST has not acted on yet. Everything else is a real failure.
 */

const MISSING_SCHEMA_CODES: ReadonlySet<string> = new Set([
  '42P01',
  'PGRST205',
  'PGRST202',
  '42883',
  '42703',
  'PGRST204',
]);

export function isMissingSchema(code: unknown): boolean {
  return typeof code === 'string' && MISSING_SCHEMA_CODES.has(code);
}
