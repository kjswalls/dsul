import type { LucideIcon } from 'lucide-react';

/**
 * The command model. One registry (lib/commands/registry.ts) is the source of
 * truth for BOTH the omnibar palette and the app's keyboard shortcuts, so a
 * capability is described once and every surface that exposes it — palette
 * row, key binding, shortcuts modal — is generated from that description.
 */

export type CommandGroupId =
  | 'recent'
  | 'create'
  | 'items'
  | 'goto'
  | 'view'
  | 'rituals'
  | 'workspace'
  | 'settings'
  | 'history'
  | 'app';

/** Palette render order. Groups with no matching rows are skipped. */
/**
 * Heading for the derived usage group. Not part of COMMAND_GROUPS: it holds no
 * commands of its own, and the omnibar places it by hand — above the palette
 * in /command mode, below the fixed actions at rest.
 */
export const RECENT_HEADING = 'Recently used';

export const COMMAND_GROUPS: { id: CommandGroupId; heading: string }[] = [
  { id: 'create', heading: 'Create' },
  { id: 'items', heading: 'Items' },
  { id: 'goto', heading: 'Go to' },
  { id: 'view', heading: 'View' },
  { id: 'rituals', heading: 'Rituals & Beacon' },
  { id: 'workspace', heading: 'Workspace' },
  { id: 'settings', heading: 'Settings' },
  { id: 'history', heading: 'History' },
  { id: 'app', heading: 'App' },
];

/**
 * Capabilities that are NOT reachable from a plain module via
 * `someStore.getState()`, assembled by the host component and handed to every
 * run(). Everything else a command needs, it reads off a store directly.
 */
export interface CommandContext {
  theme: {
    /** 'system' resolved to what is actually on screen — use this to invert. */
    resolved: 'light' | 'dark';
    /** The stored preference, which may be 'system'. */
    value: string | undefined;
    /** Sets next-themes AND persists to user_settings. */
    set: (theme: 'light' | 'dark' | 'system') => void;
  };
  /** Opens the chat: expands the sidebar dock on desktop, the tab on mobile. */
  openChat: () => void;
  userId: string | null;
  isMobile: boolean;
  /**
   * Client-side navigation, for the commands that now open a route rather than
   * a dialog (`app.settings` → /settings).
   *
   * OPTIONAL on purpose. Commands are plain modules with no React in scope, so
   * this can only be assembled in hooks/use-command-context.ts via useRouter —
   * and tests/unit/commands.test.ts constructs a bare CommandContext literal,
   * which a required field would break at compile time. Callers fall back to a
   * full page load, which is correct-but-slower rather than broken.
   */
  navigate?: (href: string) => void;
}

export interface CommandArgOption {
  value: string;
  label: string;
  icon?: LucideIcon;
  keywords?: string;
  /** See Command.aliases — same contract, for a nested value. */
  aliases?: string[];
  /** Renders a check — this is the value currently in effect. */
  active?: boolean;
}

/**
 * A row in the entity picker — one item from the planner store, resolved for
 * display so the omnibar never has to know how an item is shaped.
 *
 * `value` is the item id, which is what the command's run() receives. It is an
 * id and not the item itself on purpose: the row was painted from a snapshot,
 * and the command re-reads the store when it actually runs.
 */
export interface CommandEntityOption {
  /** The item id. */
  value: string;
  /** The item's title. */
  label: string;
  /** Registry type name ('task', 'habit', 'goal') — for the row's a11y label. */
  typeName: string;
  icon: LucideIcon;
  /** The item's container, with its glyph already resolved. */
  container?: { name: string; glyph: string };
  /** Muted right-hand detail: a date for dated items, a streak for habits. */
  detail?: string;
  /** Renders the title struck through. */
  done?: boolean;
}

export type CommandArgument =
  | {
      /**
       * Pick an ITEM. The selection model round 1 did not have: the argument
       * is resolved against the planner store rather than a fixed option set,
       * which is what lets one command ("Complete") target any of hundreds of
       * items instead of shipping as hundreds of rows.
       *
       * Never flattened, for the same reason a data-derived enum is not: titles
       * are free text and would outrank built-in commands of the same name.
       */
      kind: 'entity';
      placeholder: string;
      /** Shown when the query matches nothing this command can act on. */
      emptyLabel: string;
      /** Candidates for the typed query, already filtered to what is eligible. */
      search: (query: string, ctx: CommandContext) => CommandEntityOption[];
      /**
       * Re-resolve marked ids, in any number (not capped like `search`, since a
       * mark outlives the query that surfaced it). Keeps input order; drops ids
       * that are missing or no longer eligible.
       */
      resolve?: (ids: readonly string[], ctx: CommandContext) => CommandEntityOption[];
      /**
       * Present = the picker is multi-select. Runs the command on every id as
       * ONE undo step, so one ⌘Z takes back the whole selection.
       */
      runMany?: (ctx: CommandContext, ids: readonly string[]) => void;
    }
  | {
      kind: 'enum';
      placeholder: string;
      options: (ctx: CommandContext) => CommandArgOption[];
      /**
       * Surface every option as its own top-level row ("Change layout ▸ List"),
       * so a known value is one keystroke away instead of two.
       *
       * Only for small, FIXED option sets. Never flatten a data-derived list:
       * user-named entities collide with built-in labels (a project called
       * "Today" competing with "Go to today"), and they bloat the list on a
       * surface that has ~320px of vertical room on mobile.
       */
      flatten?: boolean;
    }
  | {
      kind: 'text';
      placeholder: string;
      /** Returns an error message, or null when the value is acceptable. */
      validate?: (value: string) => string | null;
    };

export interface CommandShortcutSpec {
  /**
   * Stable id, persisted in the keyboard-shortcuts store as the key for a
   * user's rebinding. Never rename one — the store's migrate merges by id.
   */
  id: string;
  keys: string[];
  /**
   * Fire even while a text input has focus. Chrome-level bindings (⌘K, ⌘,)
   * want this; anything that mutates data must not have it, or ⌘Z inside a
   * text field undoes a task instead of a keystroke.
   */
  allowInInput?: boolean;
  /**
   * Allow key auto-repeat to fire the command again while held. Off by default
   * — repeat-firing a dialog or a toggle is nonsense — but undo and redo are
   * expected to rewind continuously when you hold the key down.
   */
  repeatable?: boolean;
  /**
   * One sentence naming WHERE this binding does anything, for the bindings
   * that do not work everywhere.
   *
   * The shortcuts table lists every binding in one flat set, which reads as a
   * promise that each of them works from wherever you are. Six of them do not:
   * three are week-view-only, two are desktop-only shells, one needs an item
   * panel open. `availableWhen` and `hidden` already encode that, but they are
   * PREDICATES over live state — they can grey a palette row and they cannot
   * be rendered as prose. This is the prose, declared beside the binding it
   * describes so the two cannot drift.
   *
   * Absent means "works anywhere", which is the honest default and the common
   * case. Written as a full sentence: it is appended to the command's own
   * description on the settings row.
   */
  context?: string;
}

export interface Command {
  id: string;
  /**
   * Canonical label. This is what the matcher scores against and what the
   * shortcuts modal shows, so it must be meaningful without app state.
   */
  label: string;
  /** Display override when the label depends on state ("Undo ‹action›"). */
  dynamicLabel?: (ctx: CommandContext) => string;
  description?: string;
  group: CommandGroupId;
  icon: LucideIcon;
  /** Extra search terms, space separated. */
  keywords?: string;
  /**
   * Short tokens you can type verbatim to reach this command — "/dark",
   * "/today". An exact alias outranks everything, including another command's
   * exact label, so an alias is a promise: typing it lands here and nowhere
   * else. Keep them single words, lowercase, and unique across the registry
   * (there is a test).
   *
   * The first alias is what the palette advertises in the row's right-hand
   * hint, so put the canonical one first.
   */
  aliases?: string[];
  argument?: CommandArgument;
  shortcut?: CommandShortcutSpec;
  /** Greys the row and blocks execution when false. */
  availableWhen?: (ctx: CommandContext) => boolean;
  /**
   * Never rendered as a palette row, but still bindable and still listed in
   * the shortcuts modal. For commands that are meaningless from inside the
   * palette (focusing the omnibar you are already typing in) or that would
   * destroy the surface they were run from (collapsing the sidebar takes the
   * omnibar with it — see components/sidebar/sidebar.tsx, the collapsed state
   * is `w-0` on an `overflow-hidden` container).
   */
  hidden?: boolean | ((ctx: CommandContext) => boolean);
  /**
   * `arg` is the enum option's value, the typed text, or — for an entity
   * argument — the chosen item's id.
   */
  run: (ctx: CommandContext, arg?: string) => void;
}

/**
 * Commands derived from live app data rather than authored by hand: one
 * "Add ‹type›" per hydrated custom item type, appearing and disappearing as
 * types are created and deleted.
 *
 * A provider must be cheap and synchronous — it runs on every keystroke — and
 * it must never emit a `shortcut`. Bindings are persisted by id
 * (lib/keyboard-shortcuts-store.ts), so a binding owned by a command that can
 * vanish would leave an unreachable override behind.
 */
export type CommandProvider = (ctx: CommandContext) => Command[];

export function resolveLabel(command: Command, ctx: CommandContext): string {
  return command.dynamicLabel?.(ctx) ?? command.label;
}

export function isHidden(command: Command, ctx: CommandContext): boolean {
  return typeof command.hidden === 'function' ? command.hidden(ctx) : !!command.hidden;
}

export function isAvailable(command: Command, ctx: CommandContext): boolean {
  return command.availableWhen ? command.availableWhen(ctx) : true;
}
