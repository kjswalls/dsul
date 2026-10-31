import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtlasPlace } from '@/lib/atlas-positions';

/**
 * lib/atlas-store.ts: where places live (account or device), the one-time
 * upload of device places when 087 first answers, a blip that keeps places
 * and mode, a write that finds the table missing and latches device mode, a
 * stale account dropped after an await, one upload for two concurrent loads,
 * device mode holding for the session, and a drop written at once.
 *
 * The I/O is mocked; the per-device blob is the real one (jsdom localStorage).
 */

const io = vi.hoisted(() => ({
  fetch: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn(),
}));
vi.mock('@/lib/atlas-positions', async (orig) => {
  const real = await orig<typeof import('@/lib/atlas-positions')>();
  return {
    ...real,
    fetchAtlasPlaces: io.fetch,
    upsertAtlasPlaces: io.upsert,
    deleteAtlasPlace: io.del,
  };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { useAtlasStore, atlasWritesSettled } from '@/lib/atlas-store';
import { ATLAS_LOCAL_KEY, readLocalPlaces, writeLocalPlaces } from '@/lib/atlas-positions';

const P = (id: string, x = 1, y = 2, over: Partial<AtlasPlace> = {}): AtlasPlace => ({
  kind: 'project',
  id,
  x,
  y,
  band: null,
  ...over,
});
const store = () => useAtlasStore.getState();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  store().reset();
  localStorage.clear();
  io.fetch.mockReset();
  io.upsert.mockReset().mockResolvedValue('ok');
  io.del.mockReset().mockResolvedValue('ok');
  toast.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('load', () => {
  it('account mode: the rows are the places', async () => {
    io.fetch.mockResolvedValue([P('a', 5, 6)]);
    await store().load('u1');
    expect(store()).toMatchObject({ userId: 'u1', mode: 'account', loaded: true, failed: false });
    expect(store().places['project:a']).toEqual(P('a', 5, 6));
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('device mode when 087 is missing: the blob is the places', async () => {
    writeLocalPlaces('u1', [P('a', 7, 8)]);
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    expect(store()).toMatchObject({ mode: 'device', loaded: true, failed: false });
    expect(store().places['project:a']).toEqual(P('a', 7, 8));
  });

  it('uploads the device places the server lacks, once, then clears the blob', async () => {
    writeLocalPlaces('u1', [P('a', 1, 1), P('b', 2, 2)]);
    io.fetch.mockResolvedValue([P('a', 9, 9)]);
    await store().load('u1');
    expect(io.upsert).toHaveBeenCalledTimes(1);
    expect(io.upsert.mock.calls[0][0]).toEqual([P('b', 2, 2)]);
    expect(io.upsert.mock.calls[0][2]).toBe('all');
    expect(io.upsert.mock.calls[0][3]).toEqual({ insertOnly: true });
    expect(localStorage.getItem(ATLAS_LOCAL_KEY)).toBeNull();
    // The server wins where both have the card.
    expect(store().places['project:a']).toEqual(P('a', 9, 9));
    expect(store().places['project:b']).toEqual(P('b', 2, 2));
  });

  it('clears a blob the server already holds, with no upload', async () => {
    writeLocalPlaces('u1', [P('a')]);
    io.fetch.mockResolvedValue([P('a', 4, 4)]);
    await store().load('u1');
    expect(io.upsert).not.toHaveBeenCalled();
    expect(localStorage.getItem(ATLAS_LOCAL_KEY)).toBeNull();
  });

  it('keeps the blob when the upload fails, for the next load', async () => {
    writeLocalPlaces('u1', [P('b')]);
    io.fetch.mockResolvedValue([]);
    io.upsert.mockResolvedValue('failed');
    await store().load('u1');
    expect(readLocalPlaces('u1')).toEqual([P('b')]);
    expect(store().mode).toBe('account');
  });

  it('a blip keeps the places and the mode, and sets failed', async () => {
    io.fetch.mockResolvedValueOnce([P('a', 3, 3)]);
    await store().load('u1');
    // A second read (the focus retry path) that throws.
    useAtlasStore.setState({ failed: true });
    io.fetch.mockRejectedValueOnce(new Error('network'));
    await store().load('u1');
    expect(store()).toMatchObject({ mode: 'account', failed: true, loaded: true });
    expect(store().places['project:a']).toEqual(P('a', 3, 3));
  });

  it('a first read that throws stays unknown, never device', async () => {
    io.fetch.mockRejectedValue(new Error('network'));
    await store().load('u1');
    expect(store()).toMatchObject({ mode: 'unknown', failed: true, loaded: true });
    expect(localStorage.getItem(ATLAS_LOCAL_KEY)).toBeNull();
  });

  it('drops an answer for an account that is no longer the store’s', async () => {
    const d = deferred<AtlasPlace[]>();
    io.fetch.mockReturnValueOnce(d.promise);
    const first = store().load('u1');
    store().reset();
    d.resolve([P('a')]);
    await first;
    expect(store()).toMatchObject({ userId: null, mode: 'unknown', loaded: false });
    expect(store().places).toEqual({});
  });

  it('a switch to another account starts clean and ignores the first one’s answer', async () => {
    const d = deferred<AtlasPlace[]>();
    io.fetch.mockReturnValueOnce(d.promise).mockResolvedValueOnce([P('b')]);
    const first = store().load('u1');
    await store().load('u2');
    d.resolve([P('a')]);
    await first;
    expect(store().userId).toBe('u2');
    expect(Object.keys(store().places)).toEqual(['project:b']);
  });

  it('two concurrent loads share one read and one upload', async () => {
    writeLocalPlaces('u1', [P('b')]);
    const d = deferred<AtlasPlace[]>();
    io.fetch.mockReturnValueOnce(d.promise);
    const a = store().load('u1');
    const b = store().load('u1');
    d.resolve([]);
    await Promise.all([a, b]);
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(io.upsert).toHaveBeenCalledTimes(1);
  });

  it('a loaded account is not read again; device mode holds for the session', async () => {
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    await store().load('u1');
    expect(io.fetch).toHaveBeenCalledTimes(1);
    // Even after a write latch sets failed-like state, device does not reload.
    useAtlasStore.setState({ failed: true });
    await store().load('u1');
    expect(io.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('writes', () => {
  it('place() is optimistic and writes x and y at once, keeping the pin', async () => {
    io.fetch.mockResolvedValue([P('a', 0, 0, { band: 'now' })]);
    await store().load('u1');
    store().place('project', 'a', 40, 50);
    expect(store().places['project:a']).toEqual(P('a', 40, 50, { band: 'now' }));
    expect(io.upsert).toHaveBeenCalledTimes(1);
    expect(io.upsert.mock.calls[0][0]).toEqual([P('a', 40, 50, { band: 'now' })]);
    expect(io.upsert.mock.calls[0][2]).toBe('xy');
    await atlasWritesSettled();
  });

  it('ignores a non-finite drop', async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    store().place('project', 'a', Number.NaN, 1);
    expect(store().places).toEqual({});
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('placeMany() writes every seed in one upsert', async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    store().placeMany([P('a'), P('b', 3, 4), P('c', null as never, null as never)]);
    expect(io.upsert).toHaveBeenCalledTimes(1);
    expect(io.upsert.mock.calls[0][0]).toEqual([P('a'), P('b', 3, 4)]);
    // A seed never lands over a place another tab or device put.
    expect(io.upsert.mock.calls[0][3]).toEqual({ insertOnly: true });
  });

  it("a write answering 'unavailable' latches device mode and writes the blob", async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    io.upsert.mockResolvedValueOnce('unavailable');
    store().place('project', 'a', 1, 2);
    await atlasWritesSettled();
    expect(store().mode).toBe('device');
    expect(readLocalPlaces('u1')).toEqual([P('a', 1, 2)]);
    // From now on the blob takes every write, and the table is not asked.
    store().place('project', 'b', 3, 4);
    await atlasWritesSettled();
    expect(io.upsert).toHaveBeenCalledTimes(1);
    expect(readLocalPlaces('u1')).toEqual([P('a', 1, 2), P('b', 3, 4)]);
  });

  it('device mode writes the blob, never the table', async () => {
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    store().place('routine', 'r', 5, 5);
    expect(io.upsert).not.toHaveBeenCalled();
    expect(readLocalPlaces('u1')).toEqual([{ kind: 'routine', id: 'r', x: 5, y: 5, band: null }]);
  });

  it("'full' says so once a session", async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    io.upsert.mockResolvedValue('full');
    store().place('project', 'a', 1, 1);
    store().place('project', 'b', 1, 1);
    await atlasWritesSettled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe("Atlas can't remember more places");
  });

  it('writes go out in order', async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    const first = deferred<'ok'>();
    const order: number[] = [];
    io.upsert
      .mockImplementationOnce(async () => {
        await first.promise;
        order.push(1);
        return 'ok';
      })
      .mockImplementationOnce(async () => {
        order.push(2);
        return 'ok';
      });
    store().place('project', 'a', 1, 1);
    store().place('project', 'a', 2, 2);
    await Promise.resolve();
    first.resolve('ok');
    await atlasWritesSettled();
    expect(order).toEqual([1, 2]);
  });

  it('with no account, places live in memory only', () => {
    store().place('project', 'a', 1, 2);
    expect(store().places['project:a']).toEqual(P('a', 1, 2));
    expect(io.upsert).not.toHaveBeenCalled();
    expect(localStorage.getItem(ATLAS_LOCAL_KEY)).toBeNull();
  });

  it('pin() writes only the band; unpinning a card with no place forgets the row', async () => {
    io.fetch.mockResolvedValue([P('a', 1, 1)]);
    await store().load('u1');
    store().pin('project', 'a', 'soon');
    expect(io.upsert.mock.calls[0][2]).toBe('band');
    expect(store().places['project:a'].band).toBe('soon');

    store().pin('goal', 'g', 'now');
    expect(store().places['goal:g']).toEqual({ kind: 'goal', id: 'g', x: null, y: null, band: 'now' });
    store().pin('goal', 'g', null);
    expect(store().places['goal:g']).toBeUndefined();
    await atlasWritesSettled();
    expect(io.del).toHaveBeenCalledWith('goal', 'g');

    // Unpinning a placed card keeps the row with its place.
    store().pin('project', 'a', null);
    expect(store().places['project:a']).toEqual(P('a', 1, 1));
    expect(io.del).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes (PR1b)', () => {
  it('a write after a first read that threw latches device mode WITHOUT wiping the blob', async () => {
    writeLocalPlaces('u1', [P('a'), P('b'), P('c')]);
    io.fetch.mockRejectedValue(new Error('network'));
    await store().load('u1');
    io.upsert.mockResolvedValueOnce('unavailable');
    store().place('project', 'x', 9, 9);
    await atlasWritesSettled();
    expect(store().mode).toBe('device');
    expect(readLocalPlaces('u1').map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'x']);
    expect(store().places['project:a']).toEqual(P('a'));
  });

  it('the upload is on the write chain: a drag made during it lands after it', async () => {
    writeLocalPlaces('u1', [P('a', 1, 1)]);
    io.fetch.mockResolvedValue([]);
    const held = deferred<'ok'>();
    const order: string[] = [];
    io.upsert
      .mockImplementationOnce(async () => {
        await held.promise;
        order.push('upload');
        return 'ok';
      })
      .mockImplementationOnce(async () => {
        order.push('drag');
        return 'ok';
      });
    const loading = store().load('u1');
    await vi.waitFor(() => expect(io.upsert).toHaveBeenCalledTimes(1));
    store().place('project', 'a', 50, 50);
    expect(io.upsert).toHaveBeenCalledTimes(1);
    held.resolve('ok');
    await loading;
    await atlasWritesSettled();
    expect(order).toEqual(['upload', 'drag']);
    expect(store().places['project:a']).toMatchObject({ x: 50, y: 50 });
  });

  it('a write still queued at sign-out is never sent under the next session', async () => {
    io.fetch.mockResolvedValue([]);
    await store().load('u1');
    const held = deferred<'ok'>();
    io.upsert.mockImplementationOnce(() => held.promise);
    store().place('project', 'a', 1, 1);
    store().place('project', 'b', 2, 2);
    store().reset();
    await store().load('u2');
    held.resolve('ok');
    await atlasWritesSettled();
    expect(io.upsert).toHaveBeenCalledTimes(1);
  });

  it('device writes merge by key with what another tab wrote since', async () => {
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    // Another tab seeds c after this one read.
    writeLocalPlaces('u1', [P('c', 7, 7)]);
    store().place('project', 'x', 1, 1);
    expect(readLocalPlaces('u1').map((p) => p.id).sort()).toEqual(['c', 'x']);
  });

  it('a device seed keeps the place the blob already has, and memory takes it', async () => {
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    writeLocalPlaces('u1', [P('a', 7, 7)]);
    store().placeMany([P('a', 1, 1)]);
    expect(readLocalPlaces('u1')).toEqual([P('a', 7, 7)]);
    expect(store().places['project:a']).toEqual(P('a', 7, 7));
  });

  it('a device forget removes only its key from the blob', async () => {
    io.fetch.mockResolvedValue('unavailable');
    await store().load('u1');
    store().pin('project', 'a', 'now');
    writeLocalPlaces('u1', [...readLocalPlaces('u1'), P('c', 7, 7)]);
    store().pin('project', 'a', null);
    expect(readLocalPlaces('u1')).toEqual([P('c', 7, 7)]);
  });
});
