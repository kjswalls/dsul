import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The Organize console's gate — the console stops opening, and stays findable.
 *
 * The console is the easier of this PR's two gates because it is one surface
 * behind one dialog request, but its sections are not one switch — they are one
 * switch EACH (console-rail.tsx), and three answers rather than two:
 *
 *   · five sections ride EXT_ORGANIZE, the console's own switch;
 *   · Goals rides EXT_GOALS, because that is where a goal is CREATED;
 *   · Trash rides NOTHING and may never be gated, because deleting is not gated
 *     and a recovery route a default-off extension can close is a way for the
 *     app's DEFAULT configuration to destroy work.
 *
 * So every combination below still opens a console. The four-combination table
 * is the load-bearing test in this file.
 *
 * The other half is the doors. Every route into the console goes inert, and the
 * console itself refuses the request as a guard of last resort — returning the
 * ui-store's single dialog slot rather than rendering nothing into it, which
 * would leave a slot armed at a dialog nobody can see or Escape.
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

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

/** The Trash section fetches on mount now that it renders in every case here. */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listDeleted: vi.fn(async () => []),
    fetchTrashedNames: vi.fn(async () => ({ projects: [], groups: [] })),
  };
});

/**
 * The console's empty-section guard is UNREACHABLE through the toggles — trash
 * rides no extension — so the only honest way to cover it is to force the
 * section list empty. Off by default; one test flips it.
 */
const forceNoSections = vi.hoisted(() => ({ current: false }));
vi.mock('@/components/planner/organize/console-rail', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consoleSectionsFor: (isOn: (slug: string) => boolean) =>
      forceNoSections.current
        ? []
        : (actual.consoleSectionsFor as (p: (slug: string) => boolean) => unknown[])(isOn),
  };
});

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Braindump } from '@/components/sidebar/braindump';
import { ProgramNotice } from '@/components/views/program-notice';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import {
  CONSOLE_SECTIONS,
  consoleSectionExtension,
  consoleSectionsFor,
} from '@/components/planner/organize/console-rail';
import { useExtensionsStore } from '@/lib/extensions-store';
import {
  EXT_GOALS,
  EXT_ORGANIZE,
  OFFICIAL_EXTENSIONS,
  extensionManifest,
  resolveEnabled,
} from '@/lib/extension-registry';
import {
  ALL_PANES,
  extensionPaneId,
  isPaneId,
  settingsForPane,
  DESTINATIONS,
} from '@/lib/settings/manifest';
import { STATIC_COMMANDS, isAvailable, type CommandContext } from '@/lib/commands';
import { enableExtensions, disableExtensions } from './support/extensions';

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'user-1',
  isMobile: false,
};

/** The predicate the console resolves its rail through, read live. */
const isOn = (slug: string) => resolveEnabled(useExtensionsStore.getState().enabled, slug);

const tabNames = () => screen.queryAllByRole('tab').map((t) => t.textContent);

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  forceNoSections.current = false;
  useExtensionsStore.setState({ enabled: {} });
});
afterEach(cleanup);

/* ── it must stop ACTING ───────────────────────────────────────────────────*/

describe('Organize switched off — the console stops opening', () => {
  it('drops every section it owns and keeps the bin', () => {
    disableExtensions(EXT_ORGANIZE, EXT_GOALS);
    render(<OrganizeConsole open onOpenChange={() => {}} />);

    // NOT an empty console. Deleting is not gated, so the only route back out
    // of a delete must not be — and both extensions off is what a brand-new
    // account gets, not an unusual state a user has to opt into.
    expect(screen.getByTestId('organize-console')).toBeInTheDocument();
    expect(tabNames()).toEqual(['Trash']);
  });

  it('lands a deep link to the trash on the trash, whatever is switched off', () => {
    disableExtensions(EXT_ORGANIZE, EXT_GOALS);
    render(<OrganizeConsole open onOpenChange={() => {}} section="trash" />);

    expect(screen.getByRole('tab', { name: 'Trash' })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  it('still opens for GOALS alone, which is the one section it does not own', () => {
    // The combination that would otherwise strand the other extension: Goals on
    // buys a filter, a grouping and a page for goals you would have no way to
    // create.
    disableExtensions(EXT_ORGANIZE);
    enableExtensions(EXT_GOALS);
    render(<OrganizeConsole open onOpenChange={() => {}} />);

    expect(screen.getByTestId('organize-console')).toBeInTheDocument();
    expect(tabNames()).toEqual(['Goals', 'Trash']);
  });

  it('lands a gated deep link on a section that exists', () => {
    disableExtensions(EXT_ORGANIZE);
    enableExtensions(EXT_GOALS);
    // 'routines' rides the console, which is off — the old hard-coded fallback
    // was also 'routines', so a naive gate leaves Radix on a tab with no
    // trigger and draws a blank plate.
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" />);

    expect(screen.getByRole('tab', { name: 'Goals' })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  it('drops the console sections and keeps Goals — all four combinations', () => {
    const ids = (goals: boolean, organize: boolean) =>
      consoleSectionsFor((slug) => (slug === EXT_GOALS ? goals : organize)).map((s) => s.id);

    expect(ids(true, true)).toEqual(CONSOLE_SECTIONS.map((s) => s.id));
    expect(ids(true, false)).toEqual(['goals', 'trash']);
    expect(ids(false, true)).toEqual(
      CONSOLE_SECTIONS.filter((s) => s.id !== 'goals').map((s) => s.id)
    );
    // The one that matters: NOT empty. Trash rides no extension, so the
    // default configuration of the app still has a way back out of a delete.
    expect(ids(false, false)).toEqual(['trash']);
  });

  it('lets no section be silently ungated, and gates the bin on nothing', () => {
    for (const section of CONSOLE_SECTIONS) {
      if (section.extension !== null) {
        expect(OFFICIAL_EXTENSIONS.map((e) => e.slug)).toContain(section.extension);
      }
      expect(consoleSectionExtension(section.id)).toBe(section.extension);
    }
    // `null` is a declaration, not a missing field — and it is asserted by name
    // so that "tidying" trash back onto EXT_ORGANIZE fails here rather than
    // silently closing the only door to a deleted project.
    expect(CONSOLE_SECTIONS.find((s) => s.id === 'trash')!.extension).toBeNull();
    expect(consoleSectionExtension('trash')).toBeNull();
    // Anything the rail cannot show answers with the console's own switch,
    // which is the safe default for a caller holding a stale section id — and
    // is deliberately DIFFERENT from the null above, which means "no gate".
    expect(consoleSectionExtension('not-a-section')).toBe(EXT_ORGANIZE);
    expect(consoleSectionExtension(undefined)).toBe(EXT_ORGANIZE);
  });

  it('never returns an empty rail, whatever the predicate says', () => {
    // The invariant that makes the console's own empty-guard unreachable. If a
    // later change gates every section, this is what goes red first.
    expect(consoleSectionsFor(() => false).map((s) => s.id)).toEqual(['trash']);
  });

  it('hands the dialog slot back if a section list ever DOES come back empty', () => {
    // The guard of last resort. It cannot fire today (see the test above), and
    // it stays because "every section is gated" is one config edit away —
    // ui-store holds ONE activeDialog, so returning null while `open` is true
    // would leave that slot armed at a dialog nobody can see or Escape out of.
    forceNoSections.current = true;
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} />);

    expect(screen.queryByTestId('organize-console')).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens the whole console once it is switched back on', () => {
    enableExtensions(EXT_ORGANIZE, EXT_GOALS);
    render(<OrganizeConsole open onOpenChange={() => {}} />);

    expect(screen.getByTestId('organize-console')).toBeInTheDocument();
    expect(tabNames()).toEqual(CONSOLE_SECTIONS.map((s) => s.label));
    expect(consoleSectionsFor(isOn)).toHaveLength(CONSOLE_SECTIONS.length);
  });
});

/* ── the doors ─────────────────────────────────────────────────────────────*/

describe('Organize switched off — the doors are inert, not absent', () => {
  /**
   * A door that VANISHES teaches nothing; a door that is visibly shut and says
   * why is the extension-store posture. These are the two that stay rendered.
   *
   * The third door — the user card's "Recently deleted" — is deliberately NOT
   * here, because it is no longer gated at all: trash rides `extension: null`,
   * so that button is always live. The regression guard for THAT decision is
   * the four-combination table above, which fails if trash is ever put back
   * behind the console's switch.
   */
  function seedBraindump() {
    const items = [
      {
        type: 'task',
        id: 't1',
        title: 'Loose thought',
        status: 'pending',
        isScheduled: false,
        order: 0,
      },
    ];
    usePlannerStore.setState({
      userId: 'u1',
      userTimezone: 'UTC',
      isLoading: false,
      items,
      tasks: items as never,
      habits: [] as never,
      projects: [],
      habitGroups: [],
      routines: [],
      programs: [],
      goals: [],
    } as never);
    useViewStore.setState({ braindumpGroupBy: 'none', braindumpSortBy: 'default' });
  }

  const braindump = () =>
    render(
      <DndContext>
        <Braindump />
      </DndContext>
    );

  it('shuts the braindump folder button rather than removing it', () => {
    seedBraindump();

    disableExtensions(EXT_ORGANIZE);
    braindump();
    const shut = screen.getByLabelText('Organize projects & groups');
    expect(shut).toBeDisabled();
    // Why it is shut: a tooltip on a pointer (hover-only, so not asserted here)
    // and this for a screen reader. The native title is the phone's alone.
    expect(shut).toHaveAttribute('aria-description', expect.stringContaining('Settings'));
    expect(shut).not.toHaveAttribute('title');
    cleanup();

    enableExtensions(EXT_ORGANIZE);
    braindump();
    const open = screen.getByLabelText('Organize projects & groups');
    expect(open).toBeEnabled();
    expect(open).not.toHaveAttribute('title');
    expect(open).not.toHaveAttribute('aria-description');
  });

  it('keeps the program notice REPORTING while it stops being a button', () => {
    const items = [
      {
        type: 'task',
        id: 't-off',
        title: 'Season work',
        status: 'pending',
        isScheduled: false,
        order: 0,
        startDate: '2026-07-15',
        timeBucket: 'morning',
      },
    ];
    usePlannerStore.setState({
      userId: 'u1',
      userTimezone: 'UTC',
      selectedDate: new Date('2026-07-15T12:00:00Z'),
      items,
      tasks: items as never,
      habits: [] as never,
      routines: [],
      programs: [{ id: 'p1', name: 'Summer', state: 'paused', itemIds: ['t-off'], routineIds: [] }],
      goals: [],
    } as never);
    useViewStore.setState({ scope: 'day' });

    disableExtensions(EXT_ORGANIZE);
    render(<ProgramNotice />);
    const notice = screen.getByTestId('program-notice');
    // The SENTENCE is the part that matters — rows are hidden whether or not
    // the console can be reached, so a notice that disappeared would hide the
    // reason as well as the work. Only the way back is gone.
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/Summer/);
    expect(notice).toBeDisabled();
    cleanup();

    enableExtensions(EXT_ORGANIZE);
    render(<ProgramNotice />);
    expect(screen.getByTestId('program-notice')).toBeEnabled();
  });
});

/* ── and it must stay findable ─────────────────────────────────────────────*/

describe('Organize switched off — still in the catalogue', () => {
  beforeEach(() => disableExtensions(EXT_ORGANIZE));

  it('keeps its manifest row, which is what generates every way of finding it', () => {
    expect(OFFICIAL_EXTENSIONS.map((e) => e.slug)).toContain(EXT_ORGANIZE);
    const manifest = extensionManifest(EXT_ORGANIZE);
    expect(manifest?.name).toBe('Organize console');
    expect(manifest?.description).toBeTruthy();
    // Ships ON since the console was made approachable (2026-08-28). The row is
    // still here — "findable" is about the catalogue entry existing, not about
    // the default — but a no-saved-choice account now resolves to enabled.
    expect(manifest?.defaultEnabled).toBe(true);
    expect(resolveEnabled({}, EXT_ORGANIZE)).toBe(true);
  });

  it('keeps its settings pane and the one switch that turns it back on', () => {
    const pane = extensionPaneId(EXT_ORGANIZE);
    expect(isPaneId(pane)).toBe(true);
    expect(ALL_PANES.map((p) => p.id)).toContain(pane);

    const toggle = settingsForPane(pane).find((r) => r.control === 'switch' && !r.dependsOn);
    expect(toggle).toBeDefined();
    // This describe's beforeEach disabled Organize in the store, and read()
    // reads the live store — so OFF here is the explicit off, not the default.
    // The switch being present and readable is the point.
    expect(toggle!.read({} as never)).toBe(false);
  });

  it('keeps every Organize destination in the settings search index', () => {
    // These are how someone in trouble finds the trash. They stay searchable
    // with the console off; the page sends them to the switch instead of to a
    // console that would close on arrival (app/settings/[[...pane]]/page.tsx).
    const organize = DESTINATIONS.filter((d) => d.action === 'organize').map((d) => d.id);
    expect(organize).toContain('dest.trash');
    expect(organize).toContain('dest.projects');
    expect(organize).toContain('dest.goals');
  });

  it('keeps the Organize commands, greyed rather than deleted', () => {
    const categories = STATIC_COMMANDS.find((c) => c.id === 'app.categories');
    const collections = STATIC_COMMANDS.find((c) => c.id === 'app.collections');
    expect(categories).toBeDefined();
    expect(collections).toBeDefined();
    expect(isAvailable(categories!, ctx)).toBe(false);
    expect(isAvailable(collections!, ctx)).toBe(false);

    enableExtensions(EXT_ORGANIZE);
    expect(isAvailable(categories!, ctx)).toBe(true);
    expect(isAvailable(collections!, ctx)).toBe(true);
  });

  it('leaves the goals command alone — it rides Goals, not the console', () => {
    // Same row, different switch: `app.goals` opens the one section the console
    // does not own, so a console that is off must not grey it out.
    enableExtensions(EXT_GOALS);
    const goals = STATIC_COMMANDS.find((c) => c.id === 'app.goals');
    expect(isAvailable(goals!, ctx)).toBe(true);
  });
});
