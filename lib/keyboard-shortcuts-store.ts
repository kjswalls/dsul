'use client';

import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STATIC_COMMANDS, SHELL_SHORTCUTS } from './commands/registry';
import { encodeKeys } from './commands/keys';
import { COMMAND_GROUPS } from './commands/types';
// Type-only, so it is erased at compile time and lib/local-state.ts importing
// this store back does not make a runtime cycle.
import type { ClearScope } from './local-state';

export interface ShortcutBinding {
  id: string;
  label: string;
  description: string;
  /** Keys pressed concurrently (up to 3), e.g. ['ctrl', 'shift', 'z'] or ['n']. */
  keys: string[];
  /** Section heading in the shortcuts table. */
  groupHeading: string;
  /**
   * One sentence naming where the binding applies, for the ones that do not
   * apply everywhere. See CommandShortcutSpec.context.
   */
  context?: string;
  /**
   * The owning command's search terms, space separated, or '' for the two
   * shell-owned bindings.
   *
   * Carried here rather than looked up because THIS LIST IS THE SEAM: the
   * settings manifest builds one presentable record per entry and never
   * imports the command registry, so the registry stays the only declaration
   * of what a binding is and the manifest stays the only declaration of how it
   * is presented. A manifest that reached back into STATIC_COMMANDS for one
   * field would be a second derivation of the binding list.
   */
  keywords: string;
}

const GROUP_HEADINGS = new Map(COMMAND_GROUPS.map((g) => [g.id, g.heading]));

/**
 * The default bindings are DERIVED from the command registry — a command owns
 * its shortcut, so this list and the palette can never disagree about what a
 * key does, and the shortcuts modal renders itself.
 *
 * SHELL_SHORTCUTS covers the two bindings the registry can't own, because they
 * act on the item under the mouse and need state that only the shell has.
 *
 * The ids are load-bearing: they are the keys a user's rebinding is stored
 * under. Never rename one — which is also why this reads STATIC_COMMANDS and
 * not resolveCommands(): a dynamically derived command can disappear, and a
 * persisted binding whose owner is gone is an override nothing can reach.
 */
export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  ...STATIC_COMMANDS.filter((command) => command.shortcut).map((command) => ({
    id: command.shortcut!.id,
    label: command.label,
    description: command.description ?? '',
    keys: command.shortcut!.keys,
    groupHeading: GROUP_HEADINGS.get(command.group) ?? 'Other',
    context: command.shortcut!.context,
    keywords: command.keywords ?? '',
  })),
  ...SHELL_SHORTCUTS.map((shortcut) => ({
    id: shortcut.id,
    label: shortcut.label,
    description: shortcut.description,
    keys: [...shortcut.keys],
    groupHeading: 'Item under the cursor',
    context: shortcut.context,
    keywords: '',
  })),
];

interface KeyboardShortcutsStore {
  /**
   * Only the bindings the user has actually changed, id → keys.
   *
   * v2 persisted whole binding objects, which meant a user who had ever opened
   * the modal was frozen on the labels and descriptions from that day, and
   * newly added shortcuts arrived only through a migrate. Storing overrides
   * alone means labels always come from the registry.
   */
  overrides: Record<string, string[]>;
  updateShortcut: (id: string, keys: string[]) => void;
  /**
   * Drop ONE binding's override, so it follows the default again.
   *
   * Not the same as `updateShortcut(id, defaultKeys)`, and the difference only
   * shows up later: writing a copy of today's default PINS the user to it, so
   * the day a release moves ⌘/ somewhere better, everyone who ever pressed the
   * row's reset button silently keeps the old key with no override visible to
   * explain it. Removing the entry is what makes "reset" mean "follow dsul".
   */
  resetShortcut: (id: string) => void;
  resetShortcuts: () => void;
  /**
   * Drop this account's rebindings — see lib/local-state.ts.
   *
   * The same assignment as `resetShortcuts`, kept as its own action because it
   * answers a different question. `resetShortcuts` is a button in the shortcuts
   * modal; this is the registry's entry point, and the registry has to be able
   * to ask every store the same thing by the same name.
   *
   * `dsul-keyboard-shortcuts` is browser-global and never synced, so on a
   * shared browser one person's ⌘K lands somewhere the next person never put
   * it. That is worth clearing on a known change of user.
   *
   * It is INERT in lib/local-state.ts' sense, though, and that decides the
   * unstamped case: the payload is an id→keys map — registry ids on one side,
   * key names on the other — with no free text and nothing drawn from the
   * account's own rows, so it cannot identify or describe whoever set it. Since
   * there is no server copy to restore from, wiping it on a browser whose owner
   * we merely cannot VOUCH for would be permanent loss for no privacy gain. So
   * it clears under scope 'all' only.
   */
  clearUserScopedState: (scope: ClearScope) => void;
}

/** toggle_right_sidebar's binding before Ctrl+J was re-defaulted onto it (v4). */
const OLD_RIGHT_SIDEBAR_KEYS = ['meta', ']'];

/**
 * v3 → v4: Ctrl+J became toggle_right_sidebar's default when Ask moved to the
 * right rail (AI step 2a). Before v4 it was unbound, so a user may already
 * have recorded it for another command;
 * the dispatcher takes the FIRST matching binding, and toggle_right_sidebar
 * comes before most commands, so that binding would silently stop working
 * (with no AI the key is consumed and does nothing). Their chord keeps its
 * meaning, and Ask keeps its old key instead. A user who already moved
 * toggle_right_sidebar themselves chose its key, so nothing changes.
 */
function keepRecordedCtrlJ(overrides: Record<string, string[]>): Record<string, string[]> {
  if (overrides.toggle_right_sidebar) return overrides;
  const ctrlJ = encodeKeys(['mod', 'j']);
  const taken = Object.entries(overrides).some(
    ([id, keys]) => id !== 'toggle_right_sidebar' && Array.isArray(keys) && encodeKeys(keys) === ctrlJ
  );
  return taken ? { ...overrides, toggle_right_sidebar: OLD_RIGHT_SIDEBAR_KEYS } : overrides;
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsStore>()(
  persist(
    (set) => ({
      overrides: {},

      updateShortcut: (id, keys) =>
        set((state) => ({ overrides: { ...state.overrides, [id]: keys } })),

      resetShortcut: (id) =>
        set((state) => {
          if (!(id in state.overrides)) return state;
          const next = { ...state.overrides };
          delete next[id];
          return { overrides: next };
        }),

      resetShortcuts: () => set({ overrides: {} }),

      clearUserScopedState: (scope) => {
        if (scope !== 'all') return;
        set({ overrides: {} });
      },
    }),
    {
      name: 'dsul-keyboard-shortcuts',
      version: 4,
      migrate: (persistedState: unknown, version: number) => {
        let state = persistedState as KeyboardShortcutsStore;
        if (version < 3) {
          // v1/v2 → v3: keep only the bindings that differ from their default.
          const legacy = persistedState as { shortcuts?: ShortcutBinding[] } | null;
          const overrides: Record<string, string[]> = {};
          for (const binding of legacy?.shortcuts ?? []) {
            const fallback = DEFAULT_SHORTCUTS.find((d) => d.id === binding.id);
            if (!fallback) continue;
            const same =
              fallback.keys.length === binding.keys.length &&
              fallback.keys.every((key, i) => key === binding.keys[i]);
            if (!same) overrides[binding.id] = binding.keys;
          }
          state = { overrides } as KeyboardShortcutsStore;
        }
        if (version < 4) state = { ...state, overrides: keepRecordedCtrlJ(state?.overrides ?? {}) };
        return state;
      },
    }
  )
);

/** Defaults with the user's rebindings applied. */
export function useShortcutBindings(): ShortcutBinding[] {
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  return useMemo(
    () =>
      DEFAULT_SHORTCUTS.map((binding) =>
        overrides[binding.id] ? { ...binding, keys: overrides[binding.id] } : binding
      ),
    [overrides]
  );
}

/** Non-reactive read for the keydown dispatcher. */
export function getShortcutBindings(): ShortcutBinding[] {
  const { overrides } = useKeyboardShortcutsStore.getState();
  return DEFAULT_SHORTCUTS.map((binding) =>
    overrides[binding.id] ? { ...binding, keys: overrides[binding.id] } : binding
  );
}

/**
 * What ONE id is currently bound to — the default, with this user's override
 * applied. Empty for an id no binding owns, which is the honest answer for a
 * surface that hardcoded the wrong name.
 */
export function shortcutKeysFor(id: string): string[] {
  return getShortcutBindings().find((binding) => binding.id === id)?.keys ?? [];
}

/**
 * Reactive `shortcutKeysFor`, for a surface that PRINTS one binding.
 *
 * There is exactly one today — the resting shortcuts button in AppShell, whose
 * hint was the literal string '⌘ + /'. Every shortcut is rebindable, so a
 * hardcoded hint starts lying the moment someone moves that one, on the single
 * control whose entire job is to say what the key is.
 */
export function useShortcutKeys(id: string): string[] {
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  return useMemo(
    () => overrides[id] ?? DEFAULT_SHORTCUTS.find((binding) => binding.id === id)?.keys ?? [],
    [overrides, id]
  );
}
