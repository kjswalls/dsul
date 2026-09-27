import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * InlineCreate — the "make one without leaving the dialog" affordance the
 * routine / season / goal membership chips grow (C2).
 *
 * The wiring (create the container, then tick it on) is three short closures in
 * item-dialog.tsx, typechecked and exercised by the e2e specs that drive the
 * real popover. What is worth pinning HERE, where it is cheap and reliable, is
 * the component's own contract: it starts collapsed, opens to a field, hands the
 * typed name AND icon to onCreate, refuses an empty name, and resets — so a
 * second member can be added without the previous one's text lingering.
 */

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

import { InlineCreate } from '@/components/planner/item-dialog';

afterEach(cleanup);

const setup = () => {
  const onCreate = vi.fn();
  render(
    <InlineCreate
      label="New goal"
      defaultIcon="icon:Target"
      testId="test-new"
      onCreate={onCreate}
    />
  );
  return onCreate;
};

describe('InlineCreate', () => {
  it('starts as a single "New goal" row, no field yet', () => {
    setup();
    expect(screen.getByTestId('test-new-open').textContent).toContain('New goal');
    expect(screen.queryByTestId('test-new-name')).toBeNull();
  });

  it('opens to a name field when the row is pressed', () => {
    setup();
    fireEvent.click(screen.getByTestId('test-new-open'));
    expect(screen.getByTestId('test-new-name')).toBeTruthy();
    // The row itself is gone while the field is open.
    expect(screen.queryByTestId('test-new-open')).toBeNull();
  });

  it('hands the trimmed name and the default icon to onCreate', () => {
    const onCreate = setup();
    fireEvent.click(screen.getByTestId('test-new-open'));
    fireEvent.change(screen.getByTestId('test-new-name'), { target: { value: '  Run a 10k  ' } });
    fireEvent.click(screen.getByTestId('test-new-add'));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Run a 10k', 'icon:Target');
  });

  it('creates on Enter as well as the button', () => {
    const onCreate = setup();
    fireEvent.click(screen.getByTestId('test-new-open'));
    fireEvent.change(screen.getByTestId('test-new-name'), { target: { value: 'Learn Spanish' } });
    fireEvent.keyDown(screen.getByTestId('test-new-name'), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('Learn Spanish', 'icon:Target');
  });

  it('refuses an empty or whitespace-only name', () => {
    const onCreate = setup();
    fireEvent.click(screen.getByTestId('test-new-open'));
    fireEvent.change(screen.getByTestId('test-new-name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('test-new-add'));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('collapses and clears after a create, ready for the next member', () => {
    const onCreate = setup();
    fireEvent.click(screen.getByTestId('test-new-open'));
    fireEvent.change(screen.getByTestId('test-new-name'), { target: { value: 'Ship v1' } });
    fireEvent.click(screen.getByTestId('test-new-add'));
    // Back to the row…
    expect(screen.getByTestId('test-new-open')).toBeTruthy();
    expect(screen.queryByTestId('test-new-name')).toBeNull();
    // …and re-opening shows an empty field, not "Ship v1".
    fireEvent.click(screen.getByTestId('test-new-open'));
    expect((screen.getByTestId('test-new-name') as HTMLInputElement).value).toBe('');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
