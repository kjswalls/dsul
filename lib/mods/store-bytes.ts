/**
 * How many bytes a value takes once Postgres holds it as jsonb and prints it
 * back as text, which is what 061's `octet_length(store::text)` CHECK and
 * mod_store_set's 64KB test measure (memory/plans/mods.md, build order 8).
 * Pure.
 *
 * jsonb prints JSON with one space after every `:` and `,` between members
 * (`{"a": 1, "b": [1, 2]}`), escapes strings as JSON.stringify does, and
 * writes other characters as raw UTF-8. Key order does not change the
 * length. The broker keeps a margin under 65,536 for the rest: a number
 * jsonb spells differently (`1e+21` prints in full) is the only known drift.
 */

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s).length;

export function jsonbTextBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case 'string':
      return utf8(JSON.stringify(value));
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value).length : 4;
    case 'boolean':
      return value ? 4 : 5;
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length === 0) return 2;
        // `[` `]`, and `, ` between items. JSON.stringify writes a hole as null.
        return value.reduce((n: number, v) => n + jsonbTextBytes(v), 2 + 2 * (value.length - 1));
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined && typeof v !== 'function'
      );
      if (entries.length === 0) return 2;
      // `{` `}`, `, ` between members, and `": "` after each key.
      return entries.reduce(
        (n, [k, v]) => n + utf8(JSON.stringify(k)) + 2 + jsonbTextBytes(v),
        2 + 2 * (entries.length - 1)
      );
    }
    default:
      return 4;
  }
}
