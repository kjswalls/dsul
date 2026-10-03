import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import type { CommandContext } from '@/lib/commands';
import { useViewStore } from '@/lib/view-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useRailStore } from '@/lib/rail-store';
import { CONNECTED_MODEL, seedAI } from './helpers/ai-fixtures';

/**
 * The bare-key claim (memory/plans/organize-console.md, Phase 1).
 *
 * `hooks/use-command-shortcuts.ts` is the app's ONE window keydown dispatcher and
 * its only guard was `isFocusedOnInput()` — input / textarea / select /
 * contentEditable. That is the right guard for a text field and the wrong one for
 * a surface built out of <button>s.
 *
 * The Organize console's list rows are buttons, so by that test a focused row is
 * "not typing" and every single-letter global still fires from it: `n` opens the
 * add dialog and REPLACES the console in the single ActiveDialog slot, `v`
 * switches the planner view behind the plate, `?` opens the shortcuts modal, and
 * `backspace` matches `delete_hovered`, which preventDefaults before any local
 * handler runs while lib/hovered-item.ts may still be pointing at a task on the
 * canvas. Typing a routine's name would destroy the surface being typed into.
 *
 * Any surface can now opt out by carrying `data-keys-local="true"` on its root.
 * What must stay true in BOTH directions: bare keys are withheld while a claim is
 * mounted, and mod-combos are NOT — trapping ⌘K or ⌘Z behind a local surface
 * would be a worse bug than the one being fixed.
 */

/**
 * Mounts the dispatcher with a stub for `edit_hovered` — one of the only two
 * shell-owned bindings (SHELL_SHORTCUTS in the registry), and bare (`e`), which
 * makes it the exact shape of binding this guard exists to withhold.
 */
function Harness({ onEdit }: { onEdit: () => void }) {
  useCommandShortcuts({} as CommandContext, { edit_hovered: onEdit });
  return null;
}

/** Dispatches a keydown and reports whether the dispatcher claimed it. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...init,
  });
  window.dispatchEvent(event);
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  return event.defaultPrevented;
}

/** The console root, as it will actually be rendered. */
function claimBareKeys(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-keys-local', 'true');
  document.body.appendChild(root);
  return root;
}

describe('the bare-key claim', () => {
  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-keys-local]').forEach((el) => el.remove());
  });

  it('lets a bare key through when nothing has claimed it', () => {
    render(<Harness onEdit={() => {}} />);
    expect(press('n')).toBe(true);
  });

  it('withholds a bare key while a surface has claimed it', () => {
    render(<Harness onEdit={() => {}} />);
    claimBareKeys();
    expect(press('n')).toBe(false);
  });

  it('withholds bare shell-handler bindings too, without running the handler', () => {
    const runs: string[] = [];
    render(<Harness onEdit={() => runs.push('edit')} />);

    expect(press('e')).toBe(true);
    expect(runs).toEqual(['edit']);

    claimBareKeys();
    expect(press('e')).toBe(false);
    expect(runs).toEqual(['edit']); // unchanged — the handler never ran again
  });

  it('still delivers mod-combos while a surface has claimed bare keys', () => {
    render(<Harness onEdit={() => {}} />);
    // ⌘K (system_search) is chrome, not data: it must survive a local claim, or
    // the console would trap the user's own command palette behind itself.
    expect(press('k', { metaKey: true })).toBe(true);
    claimBareKeys();
    expect(press('k', { metaKey: true })).toBe(true);
  });

  it('does not treat shift alone as a modifier — `?` stays withheld', () => {
    render(<Harness onEdit={() => {}} />);
    claimBareKeys();
    // `?` arrives as the bare key ['?'] (isShiftProducedSymbol in keys.ts), never
    // ['shift','?'], so a guard that counted shift as a modifier would let the
    // bug-report shortcut fire from a surface that has claimed the keyboard.
    expect(press('?', { shiftKey: true })).toBe(false);
  });

  it('goes back to normal the moment the claiming surface unmounts', () => {
    render(<Harness onEdit={() => {}} />);
    const root = claimBareKeys();
    expect(press('n')).toBe(false);

    root.remove();
    expect(press('n')).toBe(true);
  });
});

/**
 * A matched binding whose command cannot run right now (`availableWhen` false).
 * It never runs. Whether the browser gets the key depends on whose key it is.
 */
describe('a binding whose command cannot run right now', () => {
  afterEach(() => {
    cleanup();
    useViewStore.setState({ scope: 'day', layout: 'buckets' });
  });

  it('hands a page-level key back to the browser', () => {
    // ⌘= is page zoom everywhere except a week view with columns to scale.
    useViewStore.setState({ scope: 'day', layout: 'buckets' });
    render(<Harness onEdit={() => {}} />);
    expect(press('=', { metaKey: true })).toBe(false);

    // The control: the same key, where the command can run, is claimed.
    useViewStore.setState({ scope: 'week', layout: 'schedule' });
    expect(press('=', { metaKey: true })).toBe(true);
  });

  it('keeps a chrome-level key from the browser, without running its command', () => {
    // Ctrl+J (open or close Ask) waits on the AI gate, which starts closed.
    // The key is Downloads in Chrome, Edge and Firefox, and the app claims it
    // on every surface, so it is consumed and does nothing rather than opening
    // the browser's downloads.
    useSidebarStore.setState({ askOpen: false, leftSidebarOpen: false });
    render(<Harness onEdit={() => {}} />);
    expect(press('j', { ctrlKey: true })).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
  });

  it('runs it once something can answer: Ctrl+J opens Ask, and again closes it', () => {
    const unseed = seedAI(CONNECTED_MODEL);
    try {
      useSidebarStore.setState({ askOpen: false });
      render(<Harness onEdit={() => {}} />);
      expect(press('j', { ctrlKey: true })).toBe(true);
      expect(useSidebarStore.getState().askOpen).toBe(true);
      expect(press('j', { ctrlKey: true })).toBe(true);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      // ⌘] belongs to the browser again (Forward).
      expect(press(']', { metaKey: true })).toBe(false);
    } finally {
      unseed();
      useRailStore.getState().reset();
    }
  });
});
