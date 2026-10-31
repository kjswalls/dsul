import { describe, expect, it, vi } from 'vitest';

/**
 * fetchItemEventsFor's `strict` read (Atlas's Momentum): a failed read must
 * throw, so the caller can tell "no events" from "the read failed"; the quiet
 * default (the container panes' Activity) still answers [].
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import { fetchItemEventsFor, getItemEventsAvailable } from '@/lib/db';

function clientAnswering(answer: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'gte', 'or', 'order']) chain[m] = () => chain;
  chain.limit = async () => answer;
  return { from: () => chain } as never;
}

describe('fetchItemEventsFor', () => {
  const failed = { data: null, error: { code: '500', message: 'timeout' } };

  it('answers [] quietly on an error by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchItemEventsFor(['a'], '2026-01-01', clientAnswering(failed))).resolves.toEqual([]);
    spy.mockRestore();
  });

  it('throws on an error when strict', async () => {
    await expect(fetchItemEventsFor(['a'], '2026-01-01', clientAnswering(failed), { strict: true })).rejects.toThrow();
    expect(getItemEventsAvailable()).toBe(true);
  });

  it('a missing table still answers [] when strict, and latches unavailable', async () => {
    const missing = { data: null, error: { code: '42P01', message: 'no table' } };
    await expect(fetchItemEventsFor(['a'], '2026-01-01', clientAnswering(missing), { strict: true })).resolves.toEqual([]);
    expect(getItemEventsAvailable()).toBe(false);
  });
});
