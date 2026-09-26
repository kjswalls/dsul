'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useUIStore, type ActiveDialog } from './ui-store';

/**
 * console-door.ts — how a control opens the Organize console from anywhere.
 *
 * The console is a COMPONENT, not a route: `OrganizeConsole` is mounted exactly
 * once, in AppShell (components/shell/app-shell.tsx), which only `app/page.tsx`
 * renders. Every other route in the app — /item/[id], /goal/[id], /routine/[id],
 * /program/[id], /project/[id], /settings, /ledger — deliberately skips AppShell, so on those routes the console is not
 * merely closed, it does not exist.
 *
 * That makes `openDialog({ type: 'organize' })` on its own WORSE THAN A NO-OP
 * off the planner. `ui-store` is a module singleton and survives client-side
 * navigation, so the armed slot outlives the press: the door does nothing where
 * it was pressed, and the console then springs open unasked on the next trip
 * home. /goal/[id] and /settings each found this the hard way and each answered
 * it privately — arm the slot, then push '/' — and this module is that answer
 * stated once, so the next surface does not have to find it a third time.
 *
 * ── THE CONSOLE DECLARES ITSELF, RATHER THAN THE SHELL DECLARING IT ─────────
 *
 * `ItemDialog` renders in three shells (AppShell, DesktopShell's docked panel,
 * and /item/[id]'s local panel) and only two of them are under a console, so a
 * door cannot answer "is one on screen" from its own code. `usePathname() === '/'`
 * would answer today and lie the moment a second route mounts AppShell.
 *
 * The obvious React answer is a context provider wrapped around the tree that
 * mounts the console — and it was rejected, because it is a line someone can
 * quietly not write. A provider that drifts from the console it describes fails
 * SILENTLY and in the expensive direction: every door inside it starts pushing
 * '/' to reach a console already on screen, remounting the whole planner on each
 * press. So the fact is registered by the one component that cannot be wrong
 * about it — `OrganizeConsole` calls `useConsoleHost()` itself — and there is no
 * second place to keep in sync. A route that mounts the console is hosted; one
 * that doesn't, isn't; nobody has to remember anything.
 *
 * The counter is module state rather than a store because nothing RENDERS off
 * it: `useOpenConsole` reads it inside the click handler, long after any mount
 * has settled, so there is no subscription to keep and no re-render to trigger.
 * It counts rather than flags so that React's StrictMode remount in development
 * (mount → cleanup → mount) cannot leave it stuck at false.
 */

/** Everything `openDialog` needs for an 'organize' slot except the discriminator. */
export type ConsoleDoorTarget = Omit<Extract<ActiveDialog, { type: 'organize' }>, 'type'>;

/**
 * Where the console lives. A door off-shell navigates here, which is the same
 * route /goal/[id]'s Organize button and the settings page's destinations use.
 */
export const CONSOLE_HOME = '/';

/**
 * Live `OrganizeConsole` mounts. Never negative; see `useConsoleHost`.
 *
 * Fast Refresh re-evaluating this module resets it to 0 under a console that is
 * still mounted, so the next door press on the planner takes the navigating
 * branch. The slot is armed either way, so the console still opens on the
 * section asked for — the cost is one redundant transition, in development
 * only. Not worth code; worth knowing before you go hunting for it.
 */
let hosts = 0;

/**
 * Called by `OrganizeConsole`, and by nothing else. Registers "a console exists
 * in this tree" for as long as the component is mounted.
 *
 * Deliberately does NOT clear the dialog slot on unmount, tempting as that is:
 * under StrictMode the cleanup runs once immediately after the first mount, so a
 * console arriving on a slot armed by `useOpenConsole` would wipe the very
 * request that navigated it here — and only in development, which is the worst
 * place for a behaviour to differ. Leaving the console is handled where leaving
 * happens; see the exits in organize/sections/goals.tsx.
 */
export function useConsoleHost(): void {
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
    };
  }, []);
}

/** Whether a console is mounted anywhere right now. */
export function consoleHosted(): boolean {
  return hosts > 0;
}

/**
 * Opens the Organize console at `target`, from anywhere.
 *
 * On the planner that is exactly the old `openDialog` call. Everywhere else it
 * arms the same slot and then goes where the console lives, so the press lands
 * on the section it named instead of ambushing the next navigation.
 *
 * ONE HALF OF THE SETTINGS PRECEDENT IS NOT HERE. That page also redirects to
 * an extension's settings pane when the section it wants rides a switch that is
 * off, rather than opening a console that would close itself on arrival
 * (app/settings/[[...pane]]/page.tsx). Every door that calls this hook is
 * already inside its own `organizeOn` / `goalsOn` gate, so the case cannot
 * arise here — a caller that ISN'T pre-gated wants that redirect too, and
 * should reach for the settings page's `openDestination` rather than this.
 */
export function useOpenConsole(): (target?: ConsoleDoorTarget) => void {
  const router = useRouter();

  return useCallback(
    (target: ConsoleDoorTarget = {}) => {
      // Armed FIRST in both branches. The slot is what the console reads on
      // mount, so on the navigating path it has to be set before the push, and
      // on the hosted path there is nothing to wait for.
      useUIStore.getState().openDialog({ type: 'organize', ...target });
      // Read at CLICK time, not at render time: the answer is about what is
      // mounted now, and a door can outlive the mount that rendered it.
      if (!consoleHosted()) router.push(CONSOLE_HOME);
    },
    [router]
  );
}
