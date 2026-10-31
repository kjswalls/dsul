import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ATLAS_CONFLICT,
  ATLAS_LOCAL_KEY,
  clearAtlasLocalState,
  coercePlace,
  deleteAtlasPlace,
  fetchAtlasPlaces,
  readLocalPlaces,
  upsertAtlasPlaces,
  writeLocalPlaces,
  type AtlasPlace,
} from '@/lib/atlas-positions';

/**
 * lib/atlas-positions.ts over a fake session client: what each call sends, how
 * each answer (087 missing, the cap's message, a blip) maps, how rows are
 * coerced, and the per-device blob's owner rule and hostile storage.
 */

type Answer = { data?: unknown; error?: { code?: string; message?: string } | null };

/** A copy of item-notes.test.ts's local fakeDb (never imported from another test file). */
function fakeDb(answers: Answer[]) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const next = () => Promise.resolve({ data: null, error: null, ...(answers.shift() ?? {}) });
  const db = {
    from(table: string) {
      const rec = { table, ops: [] as [string, ...unknown[]][] };
      calls.push(rec);
      const b: Record<string, unknown> = new Proxy(
        {},
        {
          get(_, prop: string) {
            if (prop === 'then')
              return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => next().then(res, rej);
            return (...args: unknown[]) => {
              rec.ops.push([prop, ...args]);
              return b;
            };
          },
        }
      );
      return b;
    },
    rpc: vi.fn(() => next()),
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const place = (over: Partial<AtlasPlace> = {}): AtlasPlace => ({
  kind: 'project',
  id: 'p1',
  x: 10,
  y: 20,
  band: null,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('coercion', () => {
  it('maps a row and keeps updated_at', () => {
    expect(
      coercePlace({ container_kind: 'goal', container_id: 'g1', x: 1, y: 2, pinned_band: 'soon', updated_at: 'T' })
    ).toEqual({ kind: 'goal', id: 'g1', x: 1, y: 2, band: 'soon', updatedAt: 'T' });
  });

  it('drops an unknown kind or a blank id, nulls a stray band, and nulls a half or non-finite pair', () => {
    expect(coercePlace({ container_kind: 'item', container_id: 'i1', x: 1, y: 2 })).toBeNull();
    expect(coercePlace({ container_kind: 'project', container_id: '', x: 1, y: 2 })).toBeNull();
    expect(coercePlace(null)).toBeNull();
    expect(coercePlace({ container_kind: 'project', container_id: 'p', x: 1, y: 2, pinned_band: 'later' })?.band).toBeNull();
    const half = coercePlace({ container_kind: 'project', container_id: 'p', x: 1, y: null });
    expect([half?.x, half?.y]).toEqual([null, null]);
    const nan = coercePlace({ kind: 'routine', id: 'r', x: Number.NaN, y: 3 });
    expect([nan?.x, nan?.y]).toEqual([null, null]);
  });

  it('clamps a coordinate into 087 range', () => {
    expect(coercePlace({ kind: 'season', id: 's', x: 5e9, y: -5e9 })).toMatchObject({ x: 1_000_000, y: -1_000_000 });
  });
});

describe('fetch', () => {
  it('reads the table and coerces every row', async () => {
    const { db, calls } = fakeDb([
      {
        data: [
          { container_kind: 'project', container_id: 'p1', x: 1, y: 2, pinned_band: null, updated_at: 'T' },
          { container_kind: 'nope', container_id: 'x', x: 1, y: 2 },
        ],
      },
    ]);
    expect(await fetchAtlasPlaces(db)).toEqual([{ kind: 'project', id: 'p1', x: 1, y: 2, band: null, updatedAt: 'T' }]);
    expect(calls[0].table).toBe('atlas_positions');
  });

  it.each(['42P01', 'PGRST205'])('is unavailable on %s (087 missing)', async (code) => {
    const { db } = fakeDb([{ error: { code, message: 'missing' } }]);
    expect(await fetchAtlasPlaces(db)).toBe('unavailable');
  });

  it('throws on any other error, so a blip is never mistaken for a missing table', async () => {
    const { db } = fakeDb([{ error: { code: '57014', message: 'timeout' } }]);
    await expect(fetchAtlasPlaces(db)).rejects.toThrow('timeout');
  });
});

describe('fetch paging', () => {
  it('pages past the API row limit in key order, up to the cap', async () => {
    const row = (i: number) => ({ container_kind: 'project', container_id: `p${i}`, x: i, y: i });
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const { db, calls } = fakeDb([{ data: full }, { data: [row(1000), row(1001)] }]);
    const got = await fetchAtlasPlaces(db);
    expect(got).not.toBe('unavailable');
    expect((got as AtlasPlace[]).length).toBe(1002);
    expect(calls).toHaveLength(2);
    expect(calls[0].ops.find((o) => o[0] === 'range')).toEqual(['range', 0, 999]);
    expect(calls[1].ops.find((o) => o[0] === 'range')).toEqual(['range', 1000, 1999]);
    expect(calls[0].ops.filter((o) => o[0] === 'order').map((o) => o[1])).toEqual(['container_kind', 'container_id']);
  });

  it('stops after one short page', async () => {
    const { db, calls } = fakeDb([{ data: [] }]);
    expect(await fetchAtlasPlaces(db)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('upsert', () => {
  it('insertOnly is ON CONFLICT DO NOTHING (ignoreDuplicates); the default updates', async () => {
    const { db, calls } = fakeDb([{}, {}]);
    await upsertAtlasPlaces([place()], db, 'xy', { insertOnly: true });
    await upsertAtlasPlaces([place()], db, 'xy');
    expect(calls[0].ops.find((o) => o[0] === 'upsert')![2]).toEqual({
      onConflict: 'user_id,container_kind,container_id',
      ignoreDuplicates: true,
    });
    expect(calls[1].ops.find((o) => o[0] === 'upsert')![2]).toEqual({ onConflict: 'user_id,container_kind,container_id' });
  });

  it('sends no user_id and conflicts on the primary key', async () => {
    const { db, calls } = fakeDb([{}]);
    expect(await upsertAtlasPlaces([place({ band: 'now' })], db)).toBe('ok');
    const op = calls[0].ops.find((o) => o[0] === 'upsert')!;
    expect(op[1]).toEqual([{ container_kind: 'project', container_id: 'p1', x: 10, y: 20, pinned_band: 'now' }]);
    expect(op[2]).toEqual({ onConflict: 'user_id,container_kind,container_id' });
    expect(ATLAS_CONFLICT).toBe('user_id,container_kind,container_id');
    expect(JSON.stringify(op[1])).not.toContain('user_id');
  });

  it("sends only x and y for a drag ('xy') and only the band for a pin ('band')", async () => {
    const { db, calls } = fakeDb([{}, {}]);
    await upsertAtlasPlaces([place({ band: 'soon' })], db, 'xy');
    await upsertAtlasPlaces([place({ band: 'soon' })], db, 'band');
    expect(calls[0].ops.find((o) => o[0] === 'upsert')![1]).toEqual([
      { container_kind: 'project', container_id: 'p1', x: 10, y: 20 },
    ]);
    expect(calls[1].ops.find((o) => o[0] === 'upsert')![1]).toEqual([
      { container_kind: 'project', container_id: 'p1', pinned_band: 'soon' },
    ]);
  });

  it('sends nothing for nothing', async () => {
    const { db, calls } = fakeDb([]);
    expect(await upsertAtlasPlaces([], db)).toBe('ok');
    expect(calls).toHaveLength(0);
  });

  it("maps the cap's message to 'full', a missing table to 'unavailable', and anything else to 'failed'", async () => {
    const { db } = fakeDb([
      { error: { code: 'P0001', message: 'atlas_positions_limit' } },
      { error: { code: 'PGRST205', message: 'missing' } },
      { error: { code: '23514', message: 'check' } },
    ]);
    expect(await upsertAtlasPlaces([place()], db)).toBe('full');
    expect(await upsertAtlasPlaces([place()], db)).toBe('unavailable');
    expect(await upsertAtlasPlaces([place()], db)).toBe('failed');
  });

  it('deletes one card by kind and id', async () => {
    const { db, calls } = fakeDb([{}, { error: { code: '42P01' } }]);
    expect(await deleteAtlasPlace('routine', 'r1', db)).toBe('ok');
    expect(calls[0].ops).toEqual([['delete'], ['eq', 'container_kind', 'routine'], ['eq', 'container_id', 'r1']]);
    expect(await deleteAtlasPlace('routine', 'r1', db)).toBe('unavailable');
  });
});

describe('the per-device blob', () => {
  it("round-trips the owner's places and reads another owner's as empty", () => {
    writeLocalPlaces('u1', [place(), place({ id: 'p2', x: null, y: null, band: 'resting' })]);
    expect(readLocalPlaces('u1')).toEqual([place(), place({ id: 'p2', x: null, y: null, band: 'resting' })]);
    expect(readLocalPlaces('u2')).toEqual([]);
    expect(JSON.parse(localStorage.getItem(ATLAS_LOCAL_KEY)!).userId).toBe('u1');
  });

  it('reads junk as empty and clears', () => {
    localStorage.setItem(ATLAS_LOCAL_KEY, '{not json');
    expect(readLocalPlaces('u1')).toEqual([]);
    clearAtlasLocalState();
    expect(localStorage.getItem(ATLAS_LOCAL_KEY)).toBeNull();
  });

  it('is harmless when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => writeLocalPlaces('u1', [place()])).not.toThrow();
    expect(readLocalPlaces('u1')).toEqual([]);
    expect(() => clearAtlasLocalState()).not.toThrow();
  });
});

describe('the boundaries', () => {
  const ROOT = path.resolve(__dirname, '../..');

  it('reads atlas_far_paper only as a pending-schema column (087 is on prod; design D11)', () => {
    // A pending column falls back with the rest if a database lacks it, so a
    // build ahead of 087 still loads every stable setting.
    const src = readFileSync(path.join(ROOT, 'lib/settings-service.ts'), 'utf8');
    const start = src.indexOf('PENDING_SCHEMA_COLUMNS = [');
    const pending = src.slice(start, src.indexOf('] as const', start));
    expect(pending).toContain("'atlas_far_paper'");
  });

  it('keeps atlas_positions out of every agent, model and server surface', () => {
    const scanned = ['app/api', 'lib/ai-server', 'lib/mcp', 'lib/agent-api.ts', 'lib/ai-context.ts'];
    const files: string[] = [];
    const walk = (p: string) => {
      let st;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      if (st.isFile()) {
        if (/\.(ts|tsx|js|mjs)$/.test(p)) files.push(p);
        return;
      }
      for (const name of readdirSync(p)) if (name !== 'node_modules' && name !== 'generated') walk(path.join(p, name));
    };
    for (const s of scanned) walk(path.join(ROOT, s));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /atlas_positions|atlas-positions|atlas-store/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
