import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * The bulk-add dialog, rendered for real: the count must be the truth about
 * what Add will create, the submit payload must carry the shared fields, and
 * a structured import must survive as notes/dates rather than being folded
 * into titles.
 */

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
import type { ActiveDialog } from '@/lib/ui-store';

type BulkSeed = Extract<ActiveDialog, { type: 'bulk-add' }>;

const addTasksBulk = vi.fn();

function mount(seed: Omit<BulkSeed, 'type'> = {}) {
  const onOpenChange = vi.fn();
  render(
    <BulkAddDialog open seed={{ type: 'bulk-add', ...seed }} onOpenChange={onOpenChange} />
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlannerStore.setState({
    userId: 'user-1',
    items: [],
    tasks: [],
    habits: [],
    projects: [{ id: 'proj-1', name: 'Groceries', emoji: '🛒' }],
    itemTypes: [],
    addTasksBulk,
  });
});

afterEach(() => cleanup());

describe('BulkAddDialog', () => {
  it('seeds from the paste and counts parsed lines, markers stripped', () => {
    mount({ text: '- one\n- two\n\n- three' });
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('3 items');
    expect(screen.getByTestId('bulk-add-submit')).toHaveTextContent('Add 3 items');
  });

  it('recounts as the textarea is edited', () => {
    mount({ text: 'one\ntwo' });
    fireEvent.change(screen.getByTestId('bulk-add-textarea'), {
      target: { value: 'one\ntwo\nthree\nfour' },
    });
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('4 items');
  });

  it('submits every line through addTasksBulk with the shared fields', () => {
    const { onOpenChange } = mount({
      text: 'milk\neggs',
      project: 'Groceries',
      date: '2026-08-24',
    });
    fireEvent.click(screen.getByTestId('bulk-add-submit'));

    expect(addTasksBulk).toHaveBeenCalledTimes(1);
    const [type, payloads] = addTasksBulk.mock.calls[0];
    expect(type).toBe('task');
    expect(payloads).toEqual([
      {
        title: 'milk',
        notes: undefined,
        project: 'Groceries',
        startDate: '2026-08-24',
        timeBucket: 'anytime',
      },
      {
        title: 'eggs',
        notes: undefined,
        project: 'Groceries',
        startDate: '2026-08-24',
        timeBucket: 'anytime',
      },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('undated batches carry no bucket and no date', () => {
    mount({ text: 'a\nb' });
    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    const [, payloads] = addTasksBulk.mock.calls[0];
    expect(payloads[0].startDate).toBeUndefined();
    expect(payloads[0].timeBucket).toBeUndefined();
  });

  it('disables submit when nothing parses', () => {
    mount({ text: '' });
    expect(screen.getByTestId('bulk-add-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    expect(addTasksBulk).not.toHaveBeenCalled();
  });

  it('the date chip is removable, and removal unschedules the batch', () => {
    mount({ text: 'a\nb', date: '2026-08-24' });
    fireEvent.click(screen.getByTestId('bulk-add-date-chip'));
    expect(screen.queryByTestId('bulk-add-date-chip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    const [, payloads] = addTasksBulk.mock.calls[0];
    expect(payloads[0].startDate).toBeUndefined();
    expect(payloads[0].timeBucket).toBeUndefined();
  });

  it('never seeds the habit pipeline — a stale habit hand-off falls back to task', () => {
    mount({ text: 'a\nb', itemType: 'habit' });
    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    expect(addTasksBulk.mock.calls[0][0]).toBe('task');
  });

  it('a structured file import shows the preview and submits notes and dates', async () => {
    mount({ text: '' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(
      ['Title,Notes,Due Date\nBuy milk,whole,2026-08-24\nCall bank,,'],
      'list.csv',
      { type: 'text/csv' }
    );
    fireEvent.change(input, { target: { files: [file] } });

    const preview = await screen.findByTestId('bulk-add-preview');
    expect(preview).toHaveTextContent('Buy milk');
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('2 items');

    fireEvent.click(screen.getByTestId('bulk-add-submit'));
    const [, payloads] = addTasksBulk.mock.calls[0];
    expect(payloads[0]).toMatchObject({
      title: 'Buy milk',
      notes: 'whole',
      startDate: '2026-08-24',
      timeBucket: 'anytime',
    });
    expect(payloads[1]).toMatchObject({ title: 'Call bank' });
    expect(payloads[1].startDate).toBeUndefined();
  });

  it('a flat text import lands RAW in the editable textarea, appended to what was typed', async () => {
    mount({ text: 'already here' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['- one\n- two'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    // Raw, markers and all — the live parse strips them, and keeping the raw
    // text means the cap notice can derive from what is actually in the box.
    // waitFor on the VALUE, not findBy on the element: the textarea is already
    // on screen (it holds what was typed), so `findByTestId` resolves on the
    // first tick and waits for nothing. The import lands a File read later, so
    // the element's existence is not the signal — its contents are.
    const textarea = screen.getByTestId('bulk-add-textarea');
    await waitFor(() => expect(textarea).toHaveValue('already here\n- one\n- two'));
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('3 items');
  });

  it('a flat import over a table preview carries the previewed titles into the text', async () => {
    mount({ text: 'stale paste' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    // First: a structured CSV takes over (and retires the stale paste).
    fireEvent.change(input, {
      target: { files: [new File(['Title,Notes\nBuy milk,whole'], 'a.csv', { type: 'text/csv' })] },
    });
    await screen.findByTestId('bulk-add-preview');

    // Then: a flat file arrives — the previewed titles survive as text, the
    // stale pre-table paste does not resurrect.
    fireEvent.change(input, {
      target: { files: [new File(['walk dog'], 'b.txt', { type: 'text/plain' })] },
    });
    // Here the textarea does NOT pre-exist — the CSV swapped it for the table
    // preview — so this waits for it to come back AND to carry the merged text.
    // waitFor around getBy covers both edges; findBy would only cover the first.
    await waitFor(() =>
      expect(screen.getByTestId('bulk-add-textarea')).toHaveValue('Buy milk\nwalk dog')
    );
    expect(screen.getByTestId('bulk-add-count')).toHaveTextContent('2 items');
  });
});
