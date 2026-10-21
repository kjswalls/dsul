import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Braindump to things (lib/braindump-split.ts): a paragraph is split by the
 * person's own model into drafts, checked in the bulk-add dialog, added in one
 * gesture and then got ready like anything else in the braindump.
 */

const caps = vi.hoisted(() => ({ canPrep: true }));
vi.mock('@/lib/ai-connection-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-connection-store')>();
  return { ...actual, useAICapabilities: () => caps, getAICapabilities: () => caps };
});
vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  createItems: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { BulkAddDialog } from '@/components/planner/bulk-add-dialog';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { isParagraphPaste, MAX_SPLIT_ITEMS, splitDrafts } from '@/lib/braindump-split';
import type { Item } from '@/lib/planner-types';

const PARAGRAPH =
  'I need to email Sam about the boiler before Friday, and book the dentist. Also pick up the parcel and pay the council tax.';

describe('isParagraphPaste and splitDrafts', () => {
  it('offers a long paragraph, never a list, a short line or one long title', () => {
    expect(isParagraphPaste(PARAGRAPH)).toBe(true);
    expect(isParagraphPaste('one\ntwo')).toBe(false);
    expect(isParagraphPaste('Email Sam about the boiler')).toBe(false);
    expect(isParagraphPaste('A'.repeat(200))).toBe(false);
  });

  it('keeps titles, keeps notes only where given, and caps the count', () => {
    expect(splitDrafts([{ title: '  Email   Sam ', notes: ' before Friday ' }, { title: '' }, { notes: 'x' }, 'no', { title: 'Book the dentist', notes: '' }])).toEqual([
      { title: 'Email Sam', notes: 'before Friday' },
      { title: 'Book the dentist' },
    ]);
    expect(splitDrafts(Array.from({ length: 50 }, (_, i) => ({ title: `t${i}` })))).toHaveLength(MAX_SPLIT_ITEMS);
    expect(splitDrafts('nope')).toEqual([]);
  });
});

describe('the dialog', () => {
  const prepare = vi.fn(async () => {});
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    caps.canPrep = true;
    prepare.mockClear();
    usePrepPacksStore.setState({ prepare });
    usePlannerStore.setState({
      userId: 'user-1',
      items: [],
      projects: [],
      itemTypes: [],
      addTasksBulk: (type: string, rows: { title: string; notes?: string }[]) =>
        usePlannerStore.setState((s) => ({
          items: [
            ...s.items,
            ...rows.map((r, i) => ({ type, id: `new-${i}`, title: r.title, notes: r.notes, status: 'pending', isScheduled: false, order: i }) as unknown as Item),
          ],
        })),
    } as never);
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ drafts: [{ title: 'Email Sam about the boiler', notes: 'before Friday' }, { title: 'Book the dentist' }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const mount = (split = true) =>
    render(<BulkAddDialog open seed={{ type: 'bulk-add', text: PARAGRAPH, split }} onOpenChange={() => {}} />);

  it('splits the paragraph with the AI, shows the drafts with their notes, and adds them', async () => {
    mount();
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('1 item');
    fireEvent.click(screen.getByTestId('bulk-add-split'));
    await waitFor(() => expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('2 items'));
    expect(screen.getByTestId('bulk-add-ai-note')).toBeInTheDocument();
    expect(screen.getByText('before Friday')).toBeInTheDocument();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/ai/split');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string).text).toBe(PARAGRAPH);

    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    const titles = usePlannerStore.getState().items.map((i) => i.title);
    expect(titles).toEqual(['Email Sam about the boiler', 'Book the dentist']);
    // Then they are got ready, like anything in the braindump.
    expect(prepare).toHaveBeenCalledTimes(1);
    const asked = (prepare.mock.calls[0] as unknown as [{ title: string; notes?: string }[]])[0];
    expect(asked.map((a) => a.title)).toEqual(titles);
    expect(asked[0].notes).toBe('before Friday');
  });

  it('a plain list added without the AI is not got ready, and no model means no button', () => {
    mount(false);
    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    expect(prepare).not.toHaveBeenCalled();
    cleanup();
    caps.canPrep = false;
    mount();
    expect(screen.queryByTestId('bulk-add-split')).toBeNull();
  });

  it("says so when the AI found nothing, and keeps the text", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ drafts: [] }), { status: 200 }));
    mount();
    fireEvent.click(screen.getByTestId('bulk-add-split'));
    await screen.findByText('Your AI found nothing to do in that.');
    expect(screen.getByTestId('bulk-add-textarea')).toHaveValue(PARAGRAPH);
  });
});
