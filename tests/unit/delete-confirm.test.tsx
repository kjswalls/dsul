import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { deleteConfirmPreview, deleteConfirmRequest } from '@/lib/item-verbs';
import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { useUIStore } from '@/lib/ui-store';

/**
 * The delete confirm's "item in hand" (Kirby, 2026-11-07): one request shape
 * for every surface that deletes an item, sentence case, and the item drawn as
 * its row with the full sentence kept for screen readers.
 */
describe('deleteConfirmRequest', () => {
  it('titles in sentence case with the type noun and keeps the registry sentence', () => {
    const req = deleteConfirmRequest({ title: 'make youtube schedule' }, 'task', () => {});
    expect(req.title).toBe('Delete task?');
    expect(req.description).toBe(
      'Moves "make youtube schedule" to Trash for 30 days, then deletes it for good.'
    );
    expect(req.destructive).toBe(true);
    expect(req.preview).toEqual({ title: 'make youtube schedule', meta: undefined, note: 'In Trash for 30 days' });
  });

  it("shows a dated item's day and an undated item's tally", () => {
    expect(deleteConfirmPreview({ title: 'a', startDate: '2026-11-10' }, 'task').meta).toBe('Tue, Nov 10');
    expect(deleteConfirmPreview({ title: 'b', completedDates: ['2026-11-01', '2026-11-02'] }, 'habit')).toEqual({
      title: 'b',
      meta: '2 done',
      note: 'History goes too. In Trash for 30 days',
    });
    expect(deleteConfirmPreview({ title: 'c', completedDates: [] }, 'habit').meta).toBeUndefined();
  });
});

describe('ConfirmDialog with a preview', () => {
  afterEach(() => {
    act(() => useUIStore.getState().resolveConfirm(false));
    cleanup();
  });

  it('draws the row and the note, and keeps the sentence as the description', () => {
    render(<ConfirmDialog />);
    const onConfirm = vi.fn();
    act(() => useUIStore.getState().confirm(deleteConfirmRequest({ title: 'Stretch' }, 'habit', onConfirm)));
    expect(screen.getByText('Delete habit?')).toBeTruthy();
    expect(screen.getByTestId('confirm-dialog-item').textContent).toContain('Stretch');
    expect(screen.getByText('History goes too. In Trash for 30 days')).toBeTruthy();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    const desc = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(desc?.textContent).toContain('and its history to Trash');
    expect(desc?.className).toContain('sr-only');
  });

  it('shows the description plainly when there is no preview', () => {
    render(<ConfirmDialog />);
    act(() =>
      useUIStore.getState().confirm({ title: 'Reset streak?', description: 'Sets it to 0.', onConfirm: () => {} })
    );
    expect(screen.queryByTestId('confirm-dialog-item')).toBeNull();
    expect(screen.getByText('Sets it to 0.').className).not.toContain('sr-only');
  });
});
