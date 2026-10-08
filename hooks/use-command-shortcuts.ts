'use client';

import { useEffect, useRef } from 'react';
import { getShortcutBindings, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { MOD, STATIC_COMMANDS, heldByPreview, isAvailable, matchesBinding, pressedKeys } from '@/lib/commands';
import { useCommandUsageStore } from '@/lib/command-usage-store';
import type { CommandContext } from '@/lib/commands';

/**
 * The app's ONE keydown dispatcher.
 *
 * It replaces two that disagreed: a configurable one driven by the shortcuts
 * store which was only ever handed four handlers, and a hardcoded listener in
 * AppShell that owned the other seven ids and never read the store — so
 * rebinding undo, redo, either sidebar, settings, shortcuts or search silently
 * did nothing. The hardcoded one also skipped the focused-input guard, which
 * is why ⌘Z while typing in the omnibar undid a *task* instead of a keystroke.
 *
 * Bindings come from the registry (a command owns its shortcut); the two
 * hovered-item shortcuts are passed in because they need shell state.
 */

type ShellHandlers = Partial<Record<string, () => void>>;

function isFocusedOnInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable
  );
}

/**
 * Real modifiers only. Shift alone does NOT qualify, and that is the point:
 * `?` reaches us as the bare key ['?'] (see isShiftProducedSymbol in keys.ts),
 * so treating shift as a modifier would let the shortcuts modal open from a
 * surface that has claimed the keyboard, while `⌘⇧,` still passes on its 'mod'.
 */
const REAL_MODIFIERS = new Set([MOD, 'ctrl', 'alt']);

/**
 * A mounted surface can claim the bare-key space by putting
 * `data-keys-local="true"` on its root.
 *
 * `isFocusedOnInput` is not enough on its own, and the gap is not theoretical.
 * A surface whose rows are <button>s — the Organize console's list, for one —
 * is not "typing" by that test, so every single-letter global still fires from
 * a focused row: `n` opens the add dialog and REPLACES the console in the
 * single ActiveDialog slot, `v` switches the planner view behind it, `?` opens
 * the shortcuts modal, and `⌫` matches `delete_hovered`, which preventDefaults
 * before any local handler runs while lib/hovered-item.ts may still be pointing
 * at a task on the canvas. Typing a routine's name would destroy the surface
 * being typed into.
 *
 * Only bare bindings are withheld. Every mod-combo (⌘K, ⌘Z, ⌘,, ⌘\) keeps
 * working, so the app's chrome is never trapped behind a local surface.
 *
 * Queried lazily — only once a bare binding has actually matched — so the
 * common keystroke costs an array scan and no DOM work.
 */
function bareKeysAreClaimed(): boolean {
  return !!document.querySelector('[data-keys-local="true"]');
}

export function useCommandShortcuts(ctx: CommandContext, shellHandlers: ShellHandlers = {}) {
  // Subscribing keeps the effect in sync with rebindings; the keys themselves
  // are read non-reactively at keypress time.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const activeHandledRef = useRef<string | null>(null);

  // Latest-value refs so the listener never has to be torn down and rebuilt on
  // every context change (the context is rebuilt whenever the theme, the user,
  // or the viewport changes).
  const ctxRef = useRef(ctx);
  const handlersRef = useRef(shellHandlers);
  useEffect(() => {
    ctxRef.current = ctx;
    handlersRef.current = shellHandlers;
  });

  useEffect(() => {
    // Static only, and complete: a shortcut can only belong to a command that
    // always exists (see keyboard-shortcuts-store), so there is nothing a
    // dynamic command could contribute to this map.
    const commandByShortcutId = new Map(
      STATIC_COMMANDS.filter((c) => c.shortcut).map((c) => [c.shortcut!.id, c])
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      const pressed = pressedKeys(event);
      if (pressed.length === 0) return;

      const typing = isFocusedOnInput();
      const bare = !pressed.some((key) => REAL_MODIFIERS.has(key));

      for (const binding of getShortcutBindings()) {
        if (!matchesBinding(pressed, binding.keys)) continue;

        // A surface that has claimed the bare-key space wins over every
        // single-letter global. Checked on the matched binding rather than up
        // front so the DOM is only touched when a shortcut would have fired.
        if (bare && bareKeysAreClaimed()) return;

        const command = commandByShortcutId.get(binding.id);

        // Key auto-repeat is suppressed unless the command opts in — holding a
        // key should not reopen a dialog 30 times, but holding ⌘Z should keep
        // rewinding.
        if (activeHandledRef.current === binding.id && !command?.shortcut?.repeatable) return;

        // Chrome-level bindings (⌘K, ⌘,) still fire while typing. Anything
        // that touches data must not, or it steals the browser's own editing
        // shortcuts out from under a text field.
        if (typing && !command?.shortcut?.allowInInput) return;

        if (command) {
          if (!isAvailable(command, ctxRef.current)) {
            // An unavailable command does not run, but what happens to the key
            // depends on whose key it is.
            //
            // A chrome-level binding (allowInInput) belongs to the app on every
            // surface, so it stays consumed while its command has nothing to
            // do. Several of these chords already mean something to the
            // browser: ⌘[ is Back in Chrome, Safari and Firefox, and Ctrl+J is
            // Downloads in Chrome, Edge and Firefox. Ctrl+J (⌘J on a Mac) is
            // gated on the AI (workspace.toggleChat). If the key got through
            // whenever nothing could answer, or before the status read lands
            // on every page load, the same key would open Ask one moment and
            // the browser's downloads the next.
            //
            // Every other binding is handed back. ⌘= / ⌘- / ⌘0 are the
            // browser's page zoom everywhere except the week views that scale
            // columns (lib/commands/registry.ts), and that handback is the only
            // reason those bindings have an `availableWhen`.
            //
            // Except one greyed only by the look-only preview (heldByPreview):
            // it is the app's key, refused for a moment, and handing ⌘A back
            // would select the whole page in the browser's blue.
            if (command.shortcut?.allowInInput || heldByPreview(command, ctxRef.current)) {
              event.preventDefault();
            }
            return;
          }
          event.preventDefault();
          activeHandledRef.current = binding.id;
          (command.runFromShortcut ?? command.run)(ctxRef.current);
          useCommandUsageStore.getState().record(command.id);
          return;
        }

        const handler = handlersRef.current[binding.id];
        if (handler) {
          event.preventDefault();
          activeHandledRef.current = binding.id;
          handler();
        }
        return;
      }
    };

    // Cleared on release so holding a key can't fire a command repeatedly.
    const handleKeyUp = () => {
      activeHandledRef.current = null;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [overrides]);
}
