// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Organize doors on a route that mounts no console.
 *
 * `OrganizeConsole` is mounted once, in AppShell, and /item/[id] deliberately
 * does not render AppShell — so an Organize door there used to arm a dialog slot
 * nothing on the page reads. Because ui-store is a module singleton the armed
 * slot then SURVIVED the trip home and sprang the console open unasked, which is
 * strictly worse than a dead control. /goal/[id] and /settings each hit this and
 * each answered it privately; lib/console-door.ts is that answer stated once.
 *
 * These drive the real ItemDialog. The pair that matters is the same press in
 * two trees: with a console mounted beside it the press must NOT navigate,
 * without one it must — and in both the slot has to end up armed at the
 * section the door named.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/item/t1',
  useParams: () => ({ id: 't1' }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => []),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));

import { ItemDialog } from '@/components/planner/item-dialog';
import { consoleHosted } from '@/lib/console-door';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { useUIStore } from '@/lib/ui-store';
import { usePlannerStore } from '@/lib/planner-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import type { Item } from '@/lib/planner-types';

const ITEM: Item = {
  type: 'task',
  id: 't1',
  title: 'Write the deck',
  status: 'pending',
  isScheduled: false,
  order: 0,
} as Item;

beforeEach(() => {
  push.mockClear();
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  useUIStore.setState({ activeDialog: null });
  /* Zero containers, which is the state the doors matter most in: with nothing
     to pick, the door IS the popover's content. */
  usePlannerStore.setState({
    items: [ITEM],
    projects: [],
    routines: [],
    programs: [],
    goals: [],
    itemTypes: [],
    collectionsAvailable: true,
    goalsAvailable: true,
    itemTypesAvailable: true,
    userTimezone: 'UTC',
    isLoading: false,
    userId: 'u1',
  } as never);
});

afterEach(cleanup);

/** The panel, as /item/[id] and DesktopShell both mount it. */
const panel = (
  <ItemDialog
    presentation="panel"
    state={{ mode: 'edit', item: ITEM }}
    onOpenChange={() => {}}
    withDetailSections={false}
  />
);

/** No console in the tree — /item/[id]. */
const renderOffShell = () => render(panel);
/**
 * The REAL console beside the panel, exactly as AppShell mounts it: shut, and a
 * sibling rather than an ancestor. Nothing here declares the tree hosted — the
 * console registers itself — so this proves the actual wiring rather than a
 * flag the test set for itself.
 */
const renderOnShell = () =>
  render(
    <>
      <OrganizeConsole open={false} onOpenChange={() => {}} />
      {panel}
    </>
  );

/* Panel + edit is CLEARING mode: an unset container has no chip at rest, so
   every one of these has to be summoned from the "Add property" seed first.
   Matched on `data-value`, never on label copy. */
const pressDoor = (kind: 'routine' | 'program' | 'goal') => {
  fireEvent.click(screen.getByTestId('item-clearing-seed'));
  const option = screen
    .getAllByTestId('item-clearing-seed-option')
    .find((el) => el.getAttribute('data-value') === kind);
  if (!option) throw new Error(`no seed option for ${kind}`);
  // Summoning a property opens its picker on its own — no second click.
  fireEvent.click(option);
  fireEvent.click(screen.getByTestId(`item-dialog-${kind}-manage`));
};

const armed = () => useUIStore.getState().activeDialog;

/* The three doors ItemDialog offers in EDIT mode, which is the only mode
   /item/[id] opens. The types door is add-mode only (edit shows the type as a
   static span), so it cannot be reached from that route — it goes through the
   same helper anyway, and the source guard below is what holds it there. */
const DOORS = [
  { kind: 'routine', section: 'routines' },
  { kind: 'program', section: 'programs' },
  { kind: 'goal', section: 'goals' },
] as const;

describe('an Organize door on a route with no console', () => {
  for (const { kind, section } of DOORS) {
    it(`${kind}: arms ${section} and goes where the console lives`, () => {
      renderOffShell();
      pressDoor(kind);

      expect(armed()).toMatchObject({ type: 'organize', section });
      // Armed AND navigated. Either alone is the bug: no arm and the console
      // opens on the wrong section, no push and it opens on the wrong page.
      expect(push).toHaveBeenCalledWith('/');
    });
  }
});

describe('the same door inside the shell', () => {
  for (const { kind, section } of DOORS) {
    it(`${kind}: arms ${section} and stays put`, () => {
      renderOnShell();
      pressDoor(kind);

      expect(armed()).toMatchObject({ type: 'organize', section });
      // The console is a sibling of this panel, so navigating would be a
      // pointless remount of the whole planner.
      expect(push).not.toHaveBeenCalled();
    });
  }
});

/* ── The wiring underneath ────────────────────────────────────────────────
   The behaviour above only holds while two things stay true: the console keeps
   registering itself, and nobody adds a door that bypasses the helper. */

describe('the console registers itself as the host', () => {
  it('is not hosted with no console mounted, and is while one is', () => {
    // The predicate, not a rendered assertion: this is the fact every door
    // reads at click time.
    expect(consoleHosted()).toBe(false);
    renderOnShell();
    expect(consoleHosted()).toBe(true);
    cleanup();
    expect(consoleHosted()).toBe(false);
  });

  it('counts mounts, so a StrictMode remount cannot strand it at false', () => {
    const a = render(<OrganizeConsole open={false} onOpenChange={() => {}} />);
    const b = render(<OrganizeConsole open={false} onOpenChange={() => {}} />);
    expect(consoleHosted()).toBe(true);
    a.unmount();
    // Still hosted: one console left. A boolean flag would have gone false here
    // and sent every door on the planner navigating.
    expect(consoleHosted()).toBe(true);
    b.unmount();
    expect(consoleHosted()).toBe(false);
  });
});

/**
 * Does this source arm an organize slot?
 *
 * Deliberately COARSE — `openDialog` anywhere in the file plus the literal
 * `'organize'` anywhere in it. A tighter regex around the call was tried and
 * leaked: `openDialog({ focusId: nextMilestone(g)?.id, type: 'organize' })`
 * closes the paren early, and `openDialog(slot)` with the literal built above
 * never mentions it at all. Both are things this repo already writes — goal/[id]
 * passes a computed `focusId` today. The cost of coarseness is a file that
 * merely NAMES the slot in a comment landing on the list below with a reason
 * saying so, which is cheap and self-explaining; the cost of a leak is the bug
 * coming back silently.
 */
const armsOrganize = (src: string) =>
  src.includes('openDialog') && /['"]organize['"]/.test(src);

/**
 * Every place in the app that arms an 'organize' slot directly, and why each is
 * allowed to. A new entry here is not forbidden — it is a claim that the file
 * can only ever render inside AppShell, or that it does its own navigating, and
 * this list is where that claim gets written down instead of assumed.
 */
const DIRECT_ARM_ALLOWED: Readonly<Record<string, string>> = {
  'lib/console-door.ts': 'the helper itself',
  // The two the coarse matcher above catches without either of them arming
  // anything. Listed rather than regexed around, per that note.
  'lib/ui-store.ts': 'declares the slot and defines openDialog; arms nothing',
  'components/shell/app-shell.tsx':
    'READS the slot to render the console, and is the one tree that always ' +
    'hosts one — a direct arm here could not be stranded anyway',
  'app/goal/[id]/page.tsx': 'arms then pushes home, the precedent this helper generalises',
  'app/settings/[[...pane]]/page.tsx': 'same, plus its own extension-pane redirect',
  'lib/commands/registry.ts':
    'module-scope run() closures, so no hook — safe only while the omnibar and ' +
    'useCommandShortcuts mount solely inside AppShell, which they do today',
  'components/sidebar/braindump.tsx': 'Sidebar → DesktopShell → AppShell',
  'components/sidebar/user-card.tsx': 'Sidebar → DesktopShell → AppShell',
  'components/views/program-notice.tsx': 'a day view, so always inside AppShell',
};

describe('nothing arms an organize slot behind the helper\'s back', () => {
  it('every direct arm site is one we have argued for', () => {
    const root = path.resolve(__dirname, '../..');
    /* APP SOURCE ONLY. `git ls-files '*.ts'` matches across slashes, so adding
       those patterns swept in tests/, packages/ and openclaw-plugin/ — and a
       test arming the slot directly is the CORRECT thing for a test to do. The
       rule is about shipped code. */
    const files = execFileSync('git', ['ls-files', 'app', 'components', 'lib', 'hooks'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));

    /* Matched on the CALL, not on a key order or a quote style: `type` and
       `section` can be written either way round, the repo has no formatter to
       normalise quotes, and this file's house style puts comments inside object
       literals. `[^)]*` spans all of that. */
        const offenders = files.filter((f) => {
      if (f in DIRECT_ARM_ALLOWED) return false;
      return armsOrganize(readFileSync(path.join(root, f), 'utf8'));
    });

    expect(
      offenders,
      'These files arm the organize slot directly. Open the console with ' +
        'useOpenConsole() (lib/console-door.ts), or add the file to ' +
        'DIRECT_ARM_ALLOWED above with the reason it is safe.'
    ).toEqual([]);
  });

  it('the allow-list has not gone stale', () => {
    // A file that stopped arming the slot should leave the list, or the next
    // reader inherits a rule protecting nothing.
    const root = path.resolve(__dirname, '../..');
        for (const [file, why] of Object.entries(DIRECT_ARM_ALLOWED)) {
      expect(armsOrganize(readFileSync(path.join(root, file), 'utf8')), `${file}: ${why}`).toBe(
        true
      );
    }
  });

  it('ItemDialog goes through the helper', () => {
    /* It is the one component that renders in both a hosted and an unhosted
       tree, so a direct arm here is the bug returning by the door it left. */
    const src = readFileSync(
      path.resolve(__dirname, '../..', 'components/planner/item-dialog.tsx'),
      'utf8'
    );
    expect(src).toContain('useOpenConsole');
  });
});
