import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * WHERE THE CURSOR GOES WHEN A CONFIRM IS DISMISSED.
 *
 * `ConfirmDialog` is mounted once in AppShell and driven by `ui-store.confirm()`
 * — which is what makes it shared, and also what makes it structurally
 * different from every AlertDialog Radix was designed around. There is no
 * `AlertDialogTrigger` anywhere: the caller is a button somewhere else entirely
 * that happens to call a store action.
 *
 * Radix's modal content closes with
 *
 *     onCloseAutoFocus: (event) => { event.preventDefault(); trigger?.focus() }
 *
 * and that `preventDefault` cancels FocusScope's own restore. With a trigger
 * that trade is right. With NO trigger the optional call is a no-op, the
 * default restore has already been cancelled, and focus lands on `<body>` — so
 * dismissing a delete confirm silently ends the keyboard session. Tab starts
 * again from the top of the document, which inside a modal console means
 * nowhere near the row you were on.
 *
 * The console makes this sharp because it is the surface people drive from the
 * keyboard: `/` to filter, ↓ to a row, ↵ to open it. Reading the confirm and
 * deciding NOT to delete is the ordinary outcome, and it is the one that used to
 * cost the user their place.
 */

vi.mock('vaul', () => ({
  Drawer: {
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Overlay: () => null,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Close: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    Handle: () => null,
  },
}));

import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { enableGoalsAndOrganize } from './support/extensions';

beforeEach(() => {
  // These drive the console's confirms, and the console ships off.
  enableGoalsAndOrganize();
  useUIStore.setState({ confirmRequest: null });
  usePlannerStore.setState({
    items: [],
    routines: [{ id: 'r1', name: 'Morning', itemIds: [] }],
    programs: [],
    projects: [],
    itemTypes: [],
    collectionsAvailable: true,
    itemTypesAvailable: true,
    isLoading: false,
    userId: 'u1',
    userTimezone: 'UTC',
  } as never);
});

afterEach(cleanup);

/**
 * The delete lives behind the pane's ⋯ menu (2026-09-25), so the control the
 * user pressed — the one the cursor must come back to — is the ⋯ trigger: the
 * menu item itself is gone by the time the confirm closes.
 */
const openConfirmFromMoreMenu = async () => {
  render(
    <>
      <OrganizeConsole open onOpenChange={() => {}} section="routines" />
      <ConfirmDialog />
    </>
  );
  fireEvent.click(screen.getByTestId('routine-row'));
  const trigger = screen.getByTestId('routine-more');
  act(() => trigger.focus());
  // Radix's DropdownMenuTrigger opens on pointerdown, not click.
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByTestId('routine-delete'));
  return trigger;
};

/**
 * This file is one of the two that exposed the suite's timeout problem: each
 * case stands up the whole OrganizeConsole plus a portalled AlertDialog and then
 * waits on two focus transitions, which fits comfortably in isolation and did
 * not at full parallelism. The budget was raised globally in vitest.config.ts
 * rather than here — `eod-dismiss` was crossing the same line, and a per-file
 * exemption would have fixed the symptom on the file that happened to be
 * measured.
 */
describe('dismissing the shared confirm', () => {
  it('puts the cursor back on the control that opened it', async () => {
    const trigger = await openConfirmFromMoreMenu();
    await screen.findByTestId('confirm-dialog');

    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });

    await waitFor(() => expect(useUIStore.getState().confirmRequest).toBeNull());
    // Not <body>. Landing there ends the keyboard session: the next Tab starts
    // from the top of the document, and the row the user was working on is gone.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('does the same for Cancel, which is the same decision by mouse', async () => {
    const trigger = await openConfirmFromMoreMenu();
    await screen.findByTestId('confirm-dialog');

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('leaves the delete path working, and does not dangle on the removed node', async () => {
    /**
     * SAYS WHAT IT PINS, because the first version of this claimed to pin the
     * `isConnected` guard and could not: it stayed green with the guard removed,
     * AND with the whole `onCloseAutoFocus` handler removed.
     *
     * The guard is not discriminable, and that is a fact about Radix rather than
     * a gap in the test. Confirming a delete unmounts the opener; preventing the
     * default and focusing a detached node is a no-op, and so is Radix's own
     * `trigger?.focus()` on a dialog that has no trigger. Both paths land focus
     * in the same place — measured, not assumed.
     *
     * What is worth holding here: the focus machinery does not break the
     * destructive path, the write still lands, and nothing is left pointing at
     * the detached button. The mechanism itself is carried by the two tests
     * above, which both go red when the handler is removed.
     */
    const trigger = await openConfirmFromMoreMenu();
    await screen.findByTestId('confirm-dialog');

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(useUIStore.getState().confirmRequest).toBeNull());
    expect(usePlannerStore.getState().routines).toEqual([]);
    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(trigger);
  });
});
