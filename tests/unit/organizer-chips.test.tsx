// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { format } from 'date-fns';
import {
  ChoiceChip,
  ColorChip,
  DateRangeChip,
  InlineAddRow,
  LinkExistingPill,
  OrganizerSection,
  colorName,
  rangeCopy,
} from '@/components/primitives/organizer-chips';

/**
 * The shared organizer chips: the copy each state reads as, the range fence
 * that keeps start ≤ end, and the add row's Enter/Escape grammar the goal,
 * program and routine panes (and their e2e `…-new-name` / `…-add` handles)
 * lean on.
 */

afterEach(cleanup);

const today = format(new Date(), 'yyyy-MM-dd');

describe('rangeCopy', () => {
  it('reads both sides with an arrow, one side with a word, neither as nothing', () => {
    expect(rangeCopy('2026-09-20', '2027-03-01')).toMatch(/Sep 20 → Mar 1/);
    expect(rangeCopy('2026-09-20', undefined)).toMatch(/^From Sep 20/);
    expect(rangeCopy(undefined, '2027-03-01')).toMatch(/^Until Mar 1/);
    expect(rangeCopy(undefined, undefined)).toBeUndefined();
  });

  it('says Today for today', () => {
    expect(rangeCopy(today, '2099-03-01')).toMatch(/^Today → /);
  });
});

describe('DateRangeChip', () => {
  const base = {
    startLabel: 'Started',
    endLabel: 'Target',
    emptyLabel: 'Target',
    testIdPrefix: 'goal-window',
  };

  it('is dashed with the empty noun when unset', () => {
    render(<DateRangeChip {...base} onChange={() => {}} />);
    const chip = screen.getByTestId('goal-window-chip');
    expect(chip.hasAttribute('data-set')).toBe(false);
    expect(chip.textContent).toBe('Target');
  });

  it('shows the key and both days when set', () => {
    render(
      <DateRangeChip
        {...base}
        label="Window"
        start="2026-09-20"
        end="2027-03-01"
        onChange={() => {}}
      />
    );
    const chip = screen.getByTestId('goal-window-chip');
    expect(chip.hasAttribute('data-set')).toBe(true);
    expect(chip.textContent).toBe('WindowSep 20Mar 1');
  });

  it('opens on the end side when only the start is set, and fences days before it', () => {
    render(<DateRangeChip {...base} start="2026-09-20" onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('goal-window-chip'));
    expect(screen.getByTestId('goal-window-end').getAttribute('aria-pressed')).toBe('true');
    // Sep 19 sits before the start — disabled on the end side.
    const sep19 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.includes('September 19th, 2026'));
    expect(sep19).toBeDefined();
    expect((sep19 as HTMLButtonElement).disabled).toBe(true);
  });

  it('writes the chosen side and clears one side without the other', () => {
    const onChange = vi.fn();
    render(<DateRangeChip {...base} start="2026-09-20" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('goal-window-chip'));
    const sep25 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.includes('September 25th, 2026'))!;
    fireEvent.click(sep25);
    expect(onChange).toHaveBeenLastCalledWith('2026-09-20', '2026-09-25');

    fireEvent.click(screen.getByTestId('goal-window-chip'));
    fireEvent.click(screen.getByTestId('goal-window-clear-start'));
    expect(onChange).toHaveBeenLastCalledWith(undefined, undefined);
  });
});

describe('ColorChip', () => {
  it('names a ramp colour and reads the noun when Auto', () => {
    expect(colorName('var(--accent-2)')).toBe('Teal');
    expect(colorName('#123456')).toBe('Custom');
    expect(colorName(undefined)).toBeUndefined();

    const { rerender } = render(<ColorChip onChange={() => {}} testId="c" />);
    expect(screen.getByTestId('c').textContent).toBe('Color');
    rerender(<ColorChip value="var(--accent-2)" onChange={() => {}} testId="c" />);
    expect(screen.getByTestId('c').textContent).toBe('Teal');
  });

  it('picks from the palette and Auto clears', () => {
    const onChange = vi.fn();
    render(<ColorChip value="var(--accent-2)" onChange={onChange} testId="c" />);
    fireEvent.click(screen.getByTestId('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Plum' }));
    expect(onChange).toHaveBeenLastCalledWith('var(--accent-4)');
    fireEvent.click(screen.getByTestId('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('ChoiceChip', () => {
  const options = [
    { value: 'active', label: 'Active', dot: 'lime' },
    { value: 'achieved', label: 'Achieved', dot: 'muted' },
    { value: 'abandoned', label: 'Set aside', dot: 'muted' },
  ] as const;

  it('shows the current label and marks it selected in the menu', () => {
    const onChange = vi.fn();
    render(
      <ChoiceChip
        label="Status"
        value="active"
        options={options}
        onChange={onChange}
        testIdPrefix="goal-state"
      />
    );
    fireEvent.click(screen.getByTestId('goal-state-chip'));
    expect(screen.getByTestId('goal-state-active').hasAttribute('data-selected')).toBe(true);
    fireEvent.click(screen.getByTestId('goal-state-achieved'));
    expect(onChange).toHaveBeenCalledWith('achieved');
  });

  it('does not re-write the current value', () => {
    const onChange = vi.fn();
    render(
      <ChoiceChip
        label="Status"
        value="active"
        options={options}
        onChange={onChange}
        testIdPrefix="goal-state"
      />
    );
    fireEvent.click(screen.getByTestId('goal-state-chip'));
    fireEvent.click(screen.getByTestId('goal-state-active'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('OrganizerSection + LinkExistingPill', () => {
  it('renders "Label · count", the action, and the rows', () => {
    const onLink = vi.fn();
    render(
      <OrganizerSection
        label="Milestones"
        count="2 of 5"
        testId="sec"
        action={<LinkExistingPill onClick={onLink} testId="link" />}
      >
        <div>row</div>
      </OrganizerSection>
    );
    const sec = screen.getByTestId('sec');
    expect(sec.textContent).toContain('Milestones · 2 of 5');
    expect(within(sec).getByText('row')).toBeTruthy();
    fireEvent.click(screen.getByTestId('link'));
    expect(onLink).toHaveBeenCalled();
    expect(screen.getByTestId('link').textContent).toBe('Link existing');
  });

  it('drops the dot with no count', () => {
    render(<OrganizerSection label="Habits" testId="sec" />);
    expect(screen.getByTestId('sec').textContent).toBe('Habits');
  });
});

describe('InlineAddRow', () => {
  it('Enter adds the trimmed title and clears; blank does nothing', () => {
    const onAdd = vi.fn();
    render(<InlineAddRow placeholder="Add milestone…" onAdd={onAdd} testIdPrefix="goal-new-milestone" />);
    const input = screen.getByTestId('goal-new-milestone-new-name') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  Ship v1 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('Ship v1');
    expect(input.value).toBe('');
  });

  it('shows the add button only with text, and it submits', () => {
    const onAdd = vi.fn();
    render(<InlineAddRow placeholder="Add milestone…" onAdd={onAdd} testIdPrefix="goal-new-milestone" />);
    expect(screen.queryByTestId('goal-new-milestone-add')).toBeNull();
    const input = screen.getByTestId('goal-new-milestone-new-name');
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.click(screen.getByTestId('goal-new-milestone-add'));
    expect(onAdd).toHaveBeenCalledWith('Draft');
    expect(screen.queryByTestId('goal-new-milestone-add')).toBeNull();
  });

  it('Escape clears without adding, and does not bubble to an enclosing dialog', () => {
    const onAdd = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <InlineAddRow placeholder="Add milestone…" onAdd={onAdd} testIdPrefix="p" />
      </div>
    );
    const input = screen.getByTestId('p-new-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onAdd).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
