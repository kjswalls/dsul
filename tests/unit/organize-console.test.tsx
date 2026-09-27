import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { CONSOLE_SECTIONS, isConsoleSection } from '@/components/planner/organize/console-rail';
import { enableGoalsAndOrganize } from './support/extensions';

/**
 * The Organize console's frame (memory/plans/organize-console.md, Phase 2).
 *
 * These pin the contracts that are expensive to discover late — the ones the
 * seven doors and both e2e spec files depend on — rather than the layout, which
 * is a visual review's job.
 *
 * ResponsiveModal picks Dialog vs vaul off useIsMobile, which reads
 * window.innerWidth; jsdom reports 1024, so these exercise the DESKTOP plate.
 */

/** vaul touches APIs jsdom lacks; the desktop path never renders it. */
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

const tab = (name: string) => screen.getByRole('tab', { name });

/** Radix defers roving focus into a setTimeout. */
const tick = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/**
 * The console and both its gated halves are switched ON for this file. Every
 * test below is about the FRAME, not about the extension gate — the gate has
 * its own file (extension-gates-organize.test.tsx), and defaulting it on here
 * would make that file the only thing standing between a broken gate and green.
 */
beforeEach(enableGoalsAndOrganize);

describe('the Organize console frame', () => {
  afterEach(cleanup);

  it('exposes every section as a tab, in the decided order', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} />);
    // 'Habit groups' sat below 'Item types' until migration 039 (decision 7 put
    // it there to make a later fold cheap). The fold happened, and it went to
    // PROJECTS rather than to routines: a habit group described what a habit is
    // about, which is what a project is, not when it counts.
    //
    // Goals sit LAST in CONTAINERS: routines and seasons answer "is this on
    // today", goals answer "why is any of it here", and the daily questions
    // belong above the long one.
    // OVERVIEW leads: the console's front door and the map a first arrival
    // meets, above the two groups rather than inside either.
    expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual([
      'Overview',
      'Routines',
      'Seasons',
      'Goals',
      'Projects',
      'Item types',
      'Trash',
    ]);
  });

  it('keeps the group eyebrows out of every tab\'s accessible name', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} />);
    // The e2e specs drive the manager with getByRole('tab', { name }). Playwright
    // substring-matches by default, so "CONTAINERS Routines" would still pass —
    // and that would be a silent dependency on matcher behaviour rather than on
    // the DOM being right.
    expect(tab('Routines')).toHaveAccessibleName('Routines');
    expect(tab('Item types')).toHaveAccessibleName('Item types');
    expect(screen.queryByRole('tab', { name: /CONTAINERS|LABELS/ })).toBeNull();
  });

  it('defaults to the Overview when no section is given', () => {
    // Opening on Routines met a first-time arrival with one kind of thing and
    // no word about the other five. The map greets instead.
    render(<OrganizeConsole open onOpenChange={() => {}} />);
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('organize-overview')).toBeTruthy();
  });

  it('falls back to the first available section for a slug it does not know', () => {
    // `tab` arrives as a bare string from ActiveDialog and from the palette, so
    // a stale or hand-typed value must land somewhere real rather than render an
    // empty plate.
    render(<OrganizeConsole open onOpenChange={() => {}} section="nonsense" />);
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('lands on the section it is opened with', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} section="seasons" />);
    expect(tab('Seasons')).toHaveAttribute('aria-selected', 'true');
  });

  it('re-lands when reopened on a DIFFERENT section without unmounting', () => {
    // The whole reason ActiveDialog carries `tab`: the console stays mounted
    // between opens, so nothing resets on its own. A door that deep-links to
    // seasons after a visit to projects must not land on projects.
    const { rerender } = render(
      <OrganizeConsole open onOpenChange={() => {}} section="projects" />
    );
    expect(tab('Projects')).toHaveAttribute('aria-selected', 'true');

    rerender(<OrganizeConsole open={false} onOpenChange={() => {}} section="projects" />);
    rerender(<OrganizeConsole open onOpenChange={() => {}} section="seasons" />);

    expect(tab('Seasons')).toHaveAttribute('aria-selected', 'true');
  });

  it('does not remember the last section a visit ended on', () => {
    // Deliberately not a last-used memory: at monthly frequency a remembered
    // destination is a coin flip, and it makes the braindump door unlearnable.
    const { rerender } = render(
      <OrganizeConsole open onOpenChange={() => {}} section="routines" />
    );
    fireEvent.mouseDown(tab('Item types'), { button: 0 });
    expect(tab('Item types')).toHaveAttribute('aria-selected', 'true');

    rerender(<OrganizeConsole open={false} onOpenChange={() => {}} section="routines" />);
    rerender(<OrganizeConsole open onOpenChange={() => {}} section="routines" />);

    expect(tab('Routines')).toHaveAttribute('aria-selected', 'true');
  });

  it('walks the rail with ↓, stepping over the eyebrows and the Trash rule', async () => {
    render(<OrganizeConsole open onOpenChange={() => {}} />);

    tab('Routines').focus();
    fireEvent.focus(tab('Routines'));

    for (const next of ['Seasons', 'Goals', 'Projects', 'Item types', 'Trash']) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      await tick();
      expect(tab(next)).toHaveFocus();
    }
  });

  it('claims the bare-key space so a focused row cannot fire a global', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} />);
    // The console's rows are <button>s, so isFocusedOnInput() is false on them
    // and `n` would otherwise open the add dialog — replacing this console in
    // the single ActiveDialog slot. See hooks/use-command-shortcuts.ts.
    expect(document.querySelector('[data-keys-local="true"]')).not.toBeNull();
  });

  it('closes from its own header button rather than the stock floating one', () => {
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} />);

    // One close control, on the header band's baseline.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    fireEvent.click(screen.getByTestId('organize-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('gives the plate a title and a described purpose', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Organize');
  });

  it('shows the section teaching line, which is its permanent home', () => {
    // Today these sentences live only in an empty state and vanish the moment
    // one container exists, taking the only in-app explanation of what a routine
    // IS with them.
    render(<OrganizeConsole open onOpenChange={() => {}} section="seasons" />);
    expect(
      screen.getByText(/A season is a stretch of life/)
    ).toBeInTheDocument();
  });
});

describe('console section slugs', () => {
  it('accepts exactly the six, and nothing else', () => {
    for (const s of CONSOLE_SECTIONS) expect(isConsoleSection(s.id)).toBe(true);
    expect(isConsoleSection('settings')).toBe(false);
    expect(isConsoleSection(undefined)).toBe(false);
  });

  it('keeps the surviving legacy tab values verbatim, so no call site translates', () => {
    // Every existing openDialog({ tab }) literal must keep working — that was a
    // variant rename, not a value migration.
    const ids = CONSOLE_SECTIONS.map((s) => s.id);
    for (const legacy of ['routines', 'seasons', 'projects', 'types']) {
      expect(ids).toContain(legacy);
    }
  });

  it('retires the groups slug rather than aliasing it', () => {
    // 039 removed the section. A slug that survived as a dead value would not
    // fail loudly — `sectionMeta` falls through to the FIRST section — so
    // 'groups' would silently open Routines. `isConsoleSection` rejecting it is
    // what lets a caller find out.
    expect(isConsoleSection('groups')).toBe(false);
  });
});

describe('the footer bar only teaches keys that work', () => {
  /**
   * The footer is the console's teaching surface, and this repo has already
   * paid for it once: "the footer bar teaches `/`, so leaving it unbuilt
   * shipped a promise the plate did not keep."
   *
   * The Overview is the first section that is a MAP rather than a list — six
   * cards, all on screen, no filter field — so the hint that every other
   * section earns would point at nothing here. `/` is also swallowed rather
   * than passed on (the plate sets `data-keys-local`), so an unkept promise is
   * the whole of the failure: a key that is taught, pressed, and inert.
   */
  it('offers no Filter hint on the Overview, which has no filter field', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} section="overview" />);
    expect(screen.queryByTestId('organize-footer-filter')).toBeNull();
  });

  it('offers it on a list section', () => {
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" />);
    expect(screen.getByTestId('organize-footer-filter')).toBeTruthy();
  });

  it('claims a filter for every section that is not the Overview', () => {
    // Guards the pair: a new section added to the rail without a filter field
    // would otherwise inherit the hint by default.
    for (const s of CONSOLE_SECTIONS) {
      expect(s.filterable).toBe(s.id !== 'overview');
    }
  });
});
