import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(() => 'id', { error: vi.fn(), success: vi.fn() }) }));

import { toast } from 'sonner';
import {
  cleanFileName,
  deleteItemFile,
  fileLink,
  listItemFiles,
  opensInline,
  sizeLabel,
  uploadItemFile,
} from '@/lib/item-files';
import { sweepItemFiles } from '@/lib/item-files-sweep';
import { useItemFilesStore } from '@/lib/item-files-store';
import { usePlannerStore } from '@/lib/planner-store';
import { AttachFileButton, ItemFilesSection } from '@/components/planner/item-files';

/**
 * Files kept on an item (migration 073): the browser's row-then-bytes order,
 * the refusals, the delete order, the one-minute links, the server's sweep,
 * the panel's two pieces, and the migration's shape.
 */

type Row = Record<string, unknown>;
type Call = [string, ...unknown[]];

/** A stand-in for the session or service client: tables in memory, Storage calls recorded. */
function fakeDb(opts: { insertError?: { code?: string; message?: string }; uploadError?: boolean; listError?: { code: string } } = {}) {
  const tables: Record<string, Row[]> = { item_files: [], storage_sweep: [] };
  const calls: Call[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    let inserted: Row[] = [];
    let limit = Infinity;
    const run = () => {
      if (op === 'insert') return { data: inserted, error: null };
      const hit = tables[table].filter((r) => filters.every((f) => f(r)));
      if (op === 'update') for (const r of hit) Object.assign(r, patch);
      if (op === 'delete') {
        tables[table] = tables[table].filter((r) => !hit.includes(r));
        // 073's AFTER DELETE trigger.
        if (table === 'item_files') for (const r of hit) tables.storage_sweep.push({ bucket: 'item-files', path: r.path });
      }
      return { data: hit.slice(0, limit), error: null };
    };
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), b),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
      order: () => b,
      limit: (n: number) => ((limit = n), b),
      update: (p: Row) => ((op = 'update'), (patch = p), calls.push([`update:${table}`, p]), b),
      delete: () => ((op = 'delete'), calls.push([`delete:${table}`]), b),
      insert: (r: Row) => {
        op = 'insert';
        calls.push([`insert:${table}`, r]);
        if (!opts.insertError) {
          inserted = [{ created_at: '2026-10-11T00:00:00Z', ready: false, ...r }];
          tables[table].push(...inserted);
        }
        return b;
      },
      async single() {
        if (opts.insertError) return { data: null, error: opts.insertError };
        return { data: run().data[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        if (op === 'select' && opts.listError) return Promise.resolve({ data: null, error: opts.listError }).then(resolve);
        return Promise.resolve(run()).then(resolve);
      },
    };
    return b;
  }
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string) => (calls.push(['upload', bucket, path]), { error: opts.uploadError ? { message: 'no' } : null }),
      remove: async (paths: string[]) => (calls.push(['remove', bucket, paths]), { error: null }),
      createSignedUrl: async (path: string, ttl: number, o?: { download?: string }) => (
        calls.push(['sign', bucket, path, ttl, o]), { data: { signedUrl: `https://files.test/${path}` }, error: null }
      ),
    }),
  };
  return { db: { from, storage } as never, tables, calls };
}

const file = (name: string, size: number, type = 'application/pdf') => {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('the rules', () => {
  it('keeps a clean name: no path, no control characters, at most 200 with its extension', () => {
    expect(cleanFileName('C:\\Users\\k\\receipt.pdf')).toBe('receipt.pdf');
    expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(cleanFileName('   ')).toBe('File');
    const long = cleanFileName(`${'x'.repeat(300)}.jpeg`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.jpeg')).toBe(true);
  });

  it('says a size in words', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(820 * 1024)).toBe('820 KB');
    expect(sizeLabel(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(sizeLabel(2 * 1024 * 1024)).toBe('2 MB');
  });

  it('opens pictures, PDFs and plain text in the browser, and downloads the rest (an SVG or HTML never renders)', () => {
    expect(opensInline('image/png')).toBe(true);
    expect(opensInline('application/pdf')).toBe(true);
    expect(opensInline('image/svg+xml')).toBe(false);
    expect(opensInline('text/html')).toBe(false);
  });
});

describe('the browser half', () => {
  it('writes the row, then the bytes at <user>/<id>, then marks it ready', async () => {
    const { db, tables, calls } = fakeDb();
    const res = await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('form.pdf', 2048) }, db);
    if (!res.ok) throw new Error(res.refusal);
    const row = tables.item_files[0];
    expect(row.path).toBe(`u1/${row.id}`);
    expect(calls.map((c) => c[0])).toEqual(['insert:item_files', 'upload', 'update:item_files']);
    expect(row.ready).toBe(true);
    expect(res.file).toMatchObject({ itemId: 'i1', name: 'form.pdf', size: 2048, mime: 'application/pdf' });
  });

  it('refuses an empty file or one over 10 MB before writing anything', async () => {
    const { db, calls } = fakeDb();
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('big.mov', 11 * 1024 * 1024) }, db)).toEqual({
      ok: false,
      refusal: 'too_big',
    });
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('e.txt', 0) }, db)).toEqual({ ok: false, refusal: 'empty' });
    expect(calls).toEqual([]);
  });

  it('names the cap the database refused on', async () => {
    const item = fakeDb({ insertError: { code: 'P0001', message: 'item_files_limit_item' } });
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('a.pdf', 9) }, item.db)).toEqual({ ok: false, refusal: 'item_full' });
    const bytes = fakeDb({ insertError: { code: 'P0001', message: 'item_files_limit_bytes' } });
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('a.pdf', 9) }, bytes.db)).toEqual({ ok: false, refusal: 'account_full' });
    const missing = fakeDb({ insertError: { code: 'PGRST205' } });
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('a.pdf', 9) }, missing.db)).toEqual({ ok: false, refusal: 'unavailable' });
  });

  it('takes its row back when the bytes did not go up', async () => {
    const { db, tables } = fakeDb({ uploadError: true });
    expect(await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('a.pdf', 9) }, db)).toEqual({ ok: false, refusal: 'failed' });
    expect(tables.item_files).toEqual([]);
  });

  it('deletes the bytes first, while the row still grants them, then the row', async () => {
    const { db, tables, calls } = fakeDb();
    const res = await uploadItemFile({ itemId: 'i1', userId: 'u1', file: file('a.pdf', 9) }, db);
    if (!res.ok) throw new Error();
    calls.length = 0;
    expect(await deleteItemFile(res.file, 'u1', db)).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['remove', 'delete:item_files']);
    expect(tables.item_files).toEqual([]);
  });

  it('links for one minute, and asks a download under its name for what should not render', async () => {
    const { db, calls } = fakeDb();
    await fileLink({ id: 'f1', name: 'a.png', mime: 'image/png' }, 'u1', db);
    await fileLink({ id: 'f2', name: 'page.html', mime: 'text/html' }, 'u1', db);
    expect(calls).toEqual([
      ['sign', 'item-files', 'u1/f1', 60, undefined],
      ['sign', 'item-files', 'u1/f2', 60, { download: 'page.html' }],
    ]);
  });

  it('lists only ready files, and says unavailable while 073 is missing', async () => {
    const { db, tables } = fakeDb();
    tables.item_files.push(
      { id: 'a', item_id: 'i1', name: 'a', mime: 'x', size: 1, path: 'u1/a', ready: true, created_at: '1' },
      { id: 'b', item_id: 'i1', name: 'b', mime: 'x', size: 1, path: 'u1/b', ready: false, created_at: '2' }
    );
    expect((await listItemFiles('i1', db) as { id: string }[]).map((f) => f.id)).toEqual(['a']);
    expect(await listItemFiles('i1', fakeDb({ listError: { code: 'PGRST205' } }).db)).toBe('unavailable');
  });
});

describe('the sweep', () => {
  it('removes queued bytes through Storage and clears the queue, with abandoned rows a day old', async () => {
    const { db, tables, calls } = fakeDb();
    const now = new Date('2026-10-11T12:00:00Z');
    tables.item_files.push(
      { id: 'old', path: 'u1/old', ready: false, created_at: '2026-10-10T11:00:00.000Z' },
      { id: 'new', path: 'u1/new', ready: false, created_at: '2026-10-11T11:00:00.000Z' },
      { id: 'done', path: 'u1/done', ready: true, created_at: '2026-10-01T00:00:00.000Z' }
    );
    tables.storage_sweep.push({ bucket: 'item-files', path: 'u2/gone' });
    const summary = await sweepItemFiles(db, now);
    expect(summary).toEqual({ removed: 2, stale: 1, notes: [] });
    expect(calls.find((c) => c[0] === 'remove')).toEqual(['remove', 'item-files', ['u2/gone', 'u1/old']]);
    expect(tables.storage_sweep).toEqual([]);
    expect(tables.item_files.map((r) => r.id)).toEqual(['new', 'done']);
  });
});

describe('the panel', () => {
  const ready = (files: Row[]) =>
    useItemFilesStore.setState({ available: true, byItem: { i1: { status: 'ready', files: files as never } }, uploading: {} });

  beforeEach(() => {
    usePlannerStore.setState({ userId: 'u1' } as never);
    useItemFilesStore.setState({ available: null, byItem: {}, uploading: {}, load: async () => {} });
  });
  afterEach(() => {
    cleanup();
    vi.mocked(toast.error).mockClear();
  });

  it('draws nothing for an item with no files', () => {
    const { container } = render(<ItemFilesSection itemId="i1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists files with their size, and deletes one only after a confirm', async () => {
    const remove = vi.fn(async () => true);
    useItemFilesStore.setState({ remove });
    ready([{ id: 'f1', itemId: 'i1', name: 'receipt.pdf', mime: 'application/pdf', size: 2048, createdAt: '' }]);
    render(<ItemFilesSection itemId="i1" />);
    expect(screen.getByTestId('item-file')).toHaveTextContent('receipt.pdf');
    expect(screen.getByTestId('item-file')).toHaveTextContent('2 KB');
    fireEvent.click(screen.getByTestId('item-file-delete'));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('item-file-confirm'));
    });
    expect(remove).toHaveBeenCalledWith('i1', expect.objectContaining({ id: 'f1' }));
  });

  it('shows the paperclip until a read says files are not available, and hands picked files to the store', () => {
    const add = vi.fn(async () => {});
    useItemFilesStore.setState({ add });
    const { rerender } = render(<AttachFileButton itemId="i1" />);
    expect(screen.getByTestId('item-dialog-attach')).toBeInTheDocument();
    const picked = file('a.pdf', 9);
    fireEvent.change(screen.getByTestId('item-files-input'), { target: { files: [picked] } });
    expect(add).toHaveBeenCalledWith('i1', [picked]);
    act(() => useItemFilesStore.setState({ available: false }));
    rerender(<AttachFileButton itemId="i1" />);
    expect(screen.queryByTestId('item-dialog-attach')).toBeNull();
  });
});

describe('migration 073', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/073_item_files.sql'), 'utf8');
  it('makes a private bucket, owner-only rows, a derived path, and a sweep queue no user can reach', () => {
    expect(sql).toMatch(/values \('item-files', 'item-files', false, 10485760\)/);
    expect(sql).toMatch(/user_id\s+uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/item_id\s+uuid not null references public\.items \(id\) on delete cascade/);
    expect(sql).toMatch(/check \(path = user_id::text \|\| '\/' \|\| id::text\)/);
    expect(sql).toMatch(/revoke all on public\.storage_sweep from public, anon, authenticated/);
    expect(sql).toMatch(/after delete on public\.item_files/);
  });

  it('lets Storage serve or take a file only where a row of yours names its path', () => {
    for (const policy of ['item_files_read', 'item_files_write', 'item_files_delete']) expect(sql).toContain(policy);
    expect(sql.match(/where f\.path = objects\.name and f\.user_id = \(select auth\.uid\(\)\)/g)).toHaveLength(3);
    // A bare `name` there is item_files.name, the file's own name: every check would fail.
    expect(sql).not.toMatch(/f\.path = name\b/);
  });
});
