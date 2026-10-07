import { describe, expect, it } from 'vitest';
import { jsonbTextBytes } from '@/lib/mods/store-bytes';

/**
 * Each expected value is `octet_length($j$<JSON.stringify(value)>$j$::jsonb::text)`
 * from Postgres 16, run once by hand when this was written: the jsonb text
 * 061's store CHECK and mod_store_set measure.
 */
const FIXTURES: [unknown, number][] = [
  [null, 4],
  [true, 4],
  [false, 5],
  [0, 1],
  [-1, 2],
  [3.25, 4],
  ['plain', 7],
  ['', 2],
  ['quote " and \\ back', 22],
  ['tab\tnew\nline\u0001', 22],
  ['é ü 日本 💧', 19],
  [' ', 5],
  [[], 2],
  [{}, 2],
  [[1, [2, [3, []]]], 17],
  [{ a: 1, b: [1, 2] }, 21],
  [{ nested: { deep: { x: 'y', n: null, list: [true, false, { k: 'v' }] } }, z: 'last' }, 91],
  [{ 'kéy "q"': 'välue', emoji: '💧💧', arr: ['a', 'b', 'c'] }, 69],
  [{ count: 42, days: ['2026-03-10', '2026-03-11'], done: { '2026-03-10': true } }, 81],
  [Array.from({ length: 20 }, (_, i) => ({ i, s: 'x'.repeat(i) })), 580],
];

describe('jsonbTextBytes', () => {
  it.each(FIXTURES.map(([v, n]) => [JSON.stringify(v).slice(0, 40), v, n]))('%s', (_, value, bytes) => {
    expect(jsonbTextBytes(value)).toBe(bytes);
  });

  it('leaves out what JSON leaves out', () => {
    expect(jsonbTextBytes({ a: 1, gone: undefined })).toBe(jsonbTextBytes({ a: 1 }));
  });
});
