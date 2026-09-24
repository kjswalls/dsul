import {
  Sunrise,
  Contrast,
  MoonStar,
  Sparkles,
  Command,
  Zap,
  Blocks,
  type LucideIcon,
} from 'lucide-react';

import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore, type TypeMode, type ScheduleMarkStyle, type BucketStyle } from '@/lib/view-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMorningStore } from '@/lib/morning-store';
import { useEODStore } from '@/lib/eod-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useAISettingsStore, type AIProvider } from '@/lib/ai-settings-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import {
  EXT_COMPLETION_CONFETTI,
  EXT_GOALS,
  EXT_HABIT_HEATMAP,
  EXT_ORGANIZE,
  EXT_STREAKS,
  OFFICIAL_EXTENSIONS,
  extensionManifest,
} from '@/lib/extension-registry';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useGatewayStore } from '../gateway-store';
import { EXTENSION_SETTINGS } from '@/lib/extension-settings';
import { STAKE_SETTINGS } from '@/lib/stakes/stake-config';
import { usePaletteStore } from '@/lib/palette-store';
import { THEME_PALETTES, isThemePalette } from '@/lib/theme-palettes';
import { saveSettings } from '@/lib/settings-service';
import {
  DEFAULT_SHORTCUTS,
  shortcutKeysFor,
  useKeyboardShortcutsStore,
} from '@/lib/keyboard-shortcuts-store';
import { decodeKeys, encodeKeys, formatKeys, isApplePlatform } from '@/lib/commands/keys';
import type { TimeBucket } from '@/lib/planner-types';

/**
 * Every setting dsul surfaces, as data.
 *
 * ONE declaration feeds the /settings page, its search index, and the
 * `data-setting` e2e handles. The palette's `settings.*` commands are still
 * hand-declared in lib/commands/registry.ts — that group owns keyboard
 * shortcuts and a globally-unique alias namespace guarded by an exhaustive
 * unit test, so folding it in here is a separate change. tests/unit/
 * settings-manifest.test.ts asserts the two can't drift into an alias
 * collision in the meantime.
 *
 * WHAT BELONGS HERE. A durable default you set once and forget — the shape of
 * a day, how the app is drawn, what runs unattended. Working state does NOT
 * belong here even when it persists: scope, layout, typeFilter, groupBy, the
 * filter popovers, week density, collapsed buckets and the sidebar width all
 * live one click from the surface they affect, where you can see the change
 * land. Sending someone to a settings page to change something they'd have to
 * navigate back to evaluate is the loop this page exists to avoid.
 *
 * WHAT DOESN'T. Settings that persist but no view reads (compact mode, chill
 * mode, morning check time, default view, right_sidebar_hover, assistantName).
 * CLAUDE.md keeps their columns and setters as-is; leaving them out of the
 * manifest is what stops search deep-linking to a control that does nothing.
 * See memory/plans/deferred-settings-features.md for the ones that are coming
 * back once the feature behind them exists.
 *
 * PANES ARE TWO LEVELS, and only under Extensions. The rail is the map and it
 * stays at seven entries; an extension gets a pane of its OWN below it, at
 * `extensions/<slug>`. Every one of those is generated from the catalog in
 * lib/extension-registry.ts — there is no hand-written pane per extension and
 * there must never be one, because the whole promise of the extension surface
 * is that adding one is adding config. See EXTENSION_PANES for the rest.
 */

/** The rail. Closed, hand-declared, and the only level that appears in it. */
export type RootPaneId =
  | 'day'
  | 'look'
  | 'rituals'
  | 'beacon'
  | 'keyboard'
  | 'extensions'
  | 'dsul';

/**
 * One extension's own pane.
 *
 * OPEN by construction, because the set of extensions is data — closing it
 * would mean editing this union every time the catalog grows, which is the
 * hand-written pane this design exists to avoid. `isPaneId` is still the
 * runtime gate: the template literal admits `extensions/anything` to the type,
 * and only a slug with a catalog entry survives the route.
 */
export type ExtensionPaneId = `extensions/${string}`;

export type PaneId = RootPaneId | ExtensionPaneId;

/** The pane id an extension's settings live at. Slug in, route segment out. */
export function extensionPaneId(slug: string): ExtensionPaneId {
  return `extensions/${slug}`;
}

export function isExtensionPane(pane: string): pane is ExtensionPaneId {
  return pane.startsWith('extensions/');
}

/** The slug back out of a sub-pane id, or null for anything else. */
export function extensionSlugFromPane(pane: string): string | null {
  return isExtensionPane(pane) ? pane.slice('extensions/'.length) : null;
}

export interface SettingsPane {
  id: PaneId;
  name: string;
  icon: LucideIcon;
  blurb: string;
  /**
   * Set on a sub-pane only: the rail entry it belongs under.
   *
   * The rail renders PANES and nothing else, so this is what lets a sub-pane
   * still light the right rail row, roll its search hits up into that row's
   * count, and name itself "Extensions · Beeminder" in a result group.
   */
  parent?: RootPaneId;
}

export const PANES: SettingsPane[] = [
  {
    id: 'day',
    name: 'Your day',
    icon: Sunrise,
    blurb: 'What a day and a week are shaped like here.',
  },
  {
    id: 'look',
    name: 'Look',
    icon: Contrast,
    blurb: 'Theme, type, and what the canvas draws.',
  },
  {
    id: 'rituals',
    name: 'Rituals',
    icon: MoonStar,
    blurb: 'The moments dsul opens by itself.',
  },
  {
    id: 'beacon',
    name: 'Beacon',
    icon: Sparkles,
    blurb: 'Which assistant answers you, and what it knows.',
  },
  {
    id: 'keyboard',
    name: 'Keyboard',
    icon: Command,
    blurb: 'Every binding, rebindable in place.',
  },
  {
    id: 'extensions',
    name: 'Extensions',
    icon: Blocks,
    // The rail entry is now an INDEX — the blurb says so, because the pane
    // stopped being the place the switches are and became the place they are
    // listed from.
    blurb: 'Optional pieces of dsul — on when you want them. Open one to set it up.',
  },
  {
    id: 'dsul',
    name: 'dsul',
    icon: Zap,
    blurb: 'The account, the tour, and how to reach us.',
  },
];

/**
 * One pane per extension, generated from the catalog.
 *
 * This is the whole answer to "each extension may have a lot of config": an
 * extension's toggle, its config fields and its credential fields are a page of
 * their own at /settings/extensions/<slug>, deep-linkable and searchable like
 * any other pane, and /settings/extensions is the index that lists them.
 *
 * DERIVED, never declared. The catalog is the source of the id, the name, the
 * icon and the blurb, so adding an extension still means adding a manifest
 * entry, a field list and a deliver() — the three things CLAUDE.md says an
 * extension is — and nothing here. A hand-written pane per extension would put
 * a fourth edit in that list and would drift from the catalog the first time
 * someone renamed one.
 *
 * Every entry needs at least one record (its own toggle), or the route is a
 * room with nothing in it. That is asserted in tests/unit/settings-manifest.
 * test.ts rather than papered over by hiding the pane: an extension a user
 * cannot switch on is a bug in the extension, not a pane to quietly drop.
 */
export const EXTENSION_PANES: SettingsPane[] = OFFICIAL_EXTENSIONS.map((extension) => ({
  id: extensionPaneId(extension.slug),
  name: extension.name,
  icon: extension.icon,
  blurb: extension.description,
  parent: 'extensions',
}));

/**
 * Every pane, rail order first and each sub-pane immediately under its parent.
 *
 * Search results group by walking this, so the order here IS the order a
 * multi-pane result list reads in — "Extensions" then its extensions, not the
 * extensions scattered after dsul.
 */
export const ALL_PANES: SettingsPane[] = PANES.flatMap((pane) => [
  pane,
  ...EXTENSION_PANES.filter((sub) => sub.parent === pane.id),
]);

/** Sub-panes of a rail entry, in catalog order. */
export function subPanesOf(parent: RootPaneId): SettingsPane[] {
  return ALL_PANES.filter((pane) => pane.parent === parent);
}

/**
 * The rail row a pane lights up — itself, or its parent when it's a sub-pane.
 * The rail never grows an entry per extension; it just stays lit while you're
 * inside one.
 */
export function railPaneFor(pane: PaneId): RootPaneId {
  return paneById(pane)?.parent ?? (pane as RootPaneId);
}

/**
 * The capabilities a record can't reach through a store singleton.
 *
 * `theme` is the only setting in the app whose setter does not persist itself
 * — next-themes writes localStorage and nothing else, so the Supabase write is
 * paired here. Getting this wrong reverts the user's theme on next sign-in,
 * when supabase-provider re-applies the stored value.
 */
export interface SettingCtx {
  theme: string | undefined;
  setTheme: (value: string) => void;
  userId: string | null;
  /** Push is browser state, not a stored boolean — the Rituals pane supplies it. */
  push?: {
    isSupported: boolean;
    isSubscribed: boolean;
    permissionState: NotificationPermission | 'unknown';
    subscribe: () => Promise<void>;
    unsubscribe: () => Promise<void>;
  };
  /** Actions the page owns because they need a router or a locally-mounted modal. */
  actions?: {
    openBugReport: () => void;
    replayTour: () => void;
    signOut: () => void;
    openLedger: () => void;
  };
}

/**
 * `keys` is a key BINDING, recorded rather than chosen: the control listens for
 * one chord and stores it. Its value travels as an encoded string (see
 * encodeKeys in lib/commands/keys.ts) so it fits `read`/`write` like every
 * other record, which is what lets one binding be searched, deep-linked,
 * marked modified and reset by exactly the machinery every other setting uses.
 */
export type ControlKind = 'switch' | 'enum' | 'time' | 'text' | 'action' | 'info' | 'keys';

/**
 * Which shape a `text` control takes.
 *
 * Replaces a hardcoded `record.id === 'beacon.apiKey'` in setting-row: that
 * test was fine while exactly one record needed a single-line input, and became
 * a growing list of ids the moment the channel credentials arrived. A record
 * says what it IS; the row decides how to draw it.
 *
 *   line      — one-line input.
 *   secret    — one-line password input that never renders its stored value.
 *               `read` returns '' by contract; the placeholder says whether
 *               something is saved.
 *   multiline — a textarea, and the only variant that takes the full width.
 */
export type TextVariant = 'line' | 'secret' | 'multiline';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingRecord {
  /** Dotted and PERMANENT — the join key for search, the deep link, and the e2e handle. */
  id: string;
  pane: PaneId;
  label: string;
  description?: string;
  control: ControlKind;
  /**
   * The words you use when you're annoyed, not the words in the code.
   * Hand-authored; deriving these from the label is what makes search feel broken.
   */
  keywords: string[];
  /** Exact-hit tokens that outrank everything. Lowercase, single word. */
  aliases?: string[];
  options?: SettingOption[];
  /** `text` controls only. Defaults to 'multiline' for backwards compatibility. */
  textVariant?: TextVariant;
  /**
   * Input placeholder. A function when it has to reflect state the value
   * cannot — a write-only credential renders empty whether or not one is
   * stored, so "Saved — type to replace" is the only place that fact fits.
   */
  placeholder?: string | ((ctx: SettingCtx) => string);
  /** Behind the per-pane Advanced disclosure, and excluded from search unless opted in. */
  advanced?: boolean;
  /** Renders indented under its parent and is disabled while the parent is off. */
  dependsOn?: string;
  /**
   * The user_settings column, mirrored to `data-setting` on the control.
   * `show_completed_tasks` is already an e2e selector — see tests/e2e/settings.spec.ts.
   */
  dbColumn?: string;
  /** Absent rather than greyed — platform, not state. Search names the reason. */
  desktopOnly?: boolean;
  /** Present but not actionable, with the reason shown inline. */
  unavailable?: (ctx: SettingCtx) => string | null;
  /**
   * The store behind this row cannot answer for it YET — a fetch is still in
   * flight for the signed-in account.
   *
   * Distinct from `unavailable`, and the difference is the whole point.
   * Unavailable is a fact about the deployment and reads as "you can't have
   * this"; pending is a fact about this second, and a row that renders its
   * `read()` during it is not showing a value — it is showing a DEFAULT while
   * claiming to show the user's setting. SettingRow answers a pending row with
   * a placeholder in the control slot and disables the write path, so the row
   * reads as loading instead of as off.
   */
  pending?: (ctx: SettingCtx) => boolean;
  read: (ctx: SettingCtx) => string | boolean;
  write: (value: string | boolean, ctx: SettingCtx) => void;
  defaultValue: string | boolean;
  /** Label for the current value — what the chip shows and what search echoes. */
  display?: (value: string | boolean) => string;
}

/* ---------------------------------------------------------------- helpers */

const planner = () => usePlannerStore.getState();
const view = () => useViewStore.getState();
const sidebar = () => useSidebarStore.getState();
const morning = () => useMorningStore.getState();
const eod = () => useEODStore.getState();
const reminders = () => useReminderStore.getState();
const ai = () => useAISettingsStore.getState();
const ext = () => useExtensionsStore.getState();
const channelSecrets = () => useChannelSecretsStore.getState();
const gateway = () => useGatewayStore.getState();
const palette = () => usePaletteStore.getState();

/** Shared by every extension toggle: rows stay visible, with the reason inline. */
const extUnavailable = () =>
  ext().available ? null : 'Needs a database update that has not landed here yet.';

/**
 * The extensions store has not answered for this account yet.
 *
 * `available` is not this question — it is false only once a fetch PROVED the
 * table isn't deployed, and starts true. In the window before the store's two
 * queries resolve, `isEnabled()` falls through to `resolveEnabled`'s manifest
 * default and `configs` is empty, so every row here would render a value no
 * account ever chose: a Beeminder toggle the server has ON draws as OFF, and a
 * click on it writes that OFF into the user's row and silently takes a live
 * stakes integration down. The config fields fail the other way — the store's
 * own `configsLoaded` guard drops the keystroke with nothing but a console
 * line, because the write is whole-object and would replace a four-key server
 * row with the one key in memory.
 *
 * This used to be unreachable by accident: the settings page gated its entire
 * render on planner-store's `isLoading`, the seven-table item load, which the
 * extensions fetch always won. That gate is now the single-row settings read
 * (lib/settings/hydration.ts) and the extensions fetch races it, so the window
 * is real and each row states its own readiness.
 *
 * `available &&` so a missing table stays UNAVAILABLE rather than becoming a
 * spinner that never resolves — hydrate leaves `configsLoaded` false in that
 * case too, and "needs a database update" is the truer of the two answers.
 */
const extPending = () => ext().available && !ext().configsLoaded;

/**
 * The master switch a delivery channel or stake adapter actually rides on.
 *
 * Both live in Rituals, and `dependsOn` cannot express this — the settings
 * manifest requires a parent and child to share a pane. Without saying it
 * somewhere, an extension can be switched on and fully credentialed while the
 * switch that governs it is off, which makes the toggle and its four config
 * fields a control that silently does nothing. `unavailable` is the right
 * mechanism: the row stays visible, with the reason inline, rather than
 * vanishing or lying.
 */
const masterSwitchFor = (slug: string): { label: string; on: () => boolean } =>
  STAKE_SLUGS.has(slug)
    ? { label: 'Settle the day', on: () => reminders().stakesEnabled }
    : { label: 'Habit reminders', on: () => reminders().remindersEnabled };

const STAKE_SLUGS = new Set(STAKE_SETTINGS.map((spec) => spec.slug));

function labelFor(options: SettingOption[] | undefined, value: string | boolean): string {
  const hit = options?.find((o) => o.value === String(value));
  return hit ? hit.label : String(value);
}

/**
 * The reminder delivery channels, as settings records.
 *
 * GENERATED rather than hand-written, which is the one place this manifest
 * bends its own rule that every setting is declared here explicitly. The reason
 * is that these records are not independent settings — they are the fields a
 * channel declares in lib/reminders/channel-config.ts, and that declaration
 * already has to be exact because the API validates writes against it. Two
 * hand-maintained copies of the same field list would drift, and the failure
 * mode of drifting is silent: a field the settings page offers and the API
 * rejects, or a credential the page never asks for and the channel then waits
 * for forever.
 *
 * Ids are `extensions.<slug>` for the toggle and `extensions.<slug>.<key>` for
 * each field, and they are PERMANENT — they are the deep links and the e2e
 * handles, exactly like a hand-written record's.
 *
 * The secret fields are the unusual ones: `read` returns '' unconditionally,
 * because the server will not tell us the value and a store that held one would
 * defeat the point of keeping it in user_secrets. The placeholder carries the
 * only state there is — saved, or not.
 */
function channelRecords(): SettingRecord[] {
  const records: SettingRecord[] = [];

  /**
   * Keywords minus anything that merely restates the label.
   *
   * A channel's terms are written for the CHANNEL ("beeminder", "twilio"), and
   * they are exactly right on its credential fields — nobody finds "Auth token"
   * by typing "Auth token". On the extension's own toggle, though, one of them
   * usually IS the label, which adds nothing (search indexes labels already) and
   * trips the manifest's own "never just the label" rule. Filtering per record
   * lets each spec keep one natural keyword list instead of two hand-pruned
   * ones that drift.
   */
  const usable = (label: string, keywords: string[]) =>
    keywords.filter((k) => k !== label.toLowerCase());

  for (const spec of EXTENSION_SETTINGS) {
    const manifest = extensionManifest(spec.slug);
    if (!manifest) continue;
    const toggleId = `extensions.${spec.slug}`;
    const pane = extensionPaneId(spec.slug);
    const master = masterSwitchFor(spec.slug);
    const gated = () =>
      extUnavailable() ?? (master.on() ? null : `needs ${master.label}, in Rituals`);

    records.push({
      id: toggleId,
      pane,
      label: manifest.name,
      description: manifest.description,
      control: 'switch',
      keywords: usable(manifest.name, [...spec.keywords, 'remind', 'nudge', 'notification']),
      unavailable: gated,
      pending: extPending,
      read: () => ext().isEnabled(spec.slug),
      write: (v, ctx) => {
        if (ctx.userId) ext().setEnabled(ctx.userId, spec.slug, Boolean(v));
      },
      defaultValue: false,
    });

    for (const field of spec.config) {
      records.push({
        id: `${toggleId}.${field.key}`,
        pane,
        label: field.label,
        description: field.description,
        control: 'text',
        textVariant: 'line',
        placeholder: field.placeholder,
        dependsOn: toggleId,
        // The channel's hand-authored terms, plus any the field declares. NOT
        // derived from the label: search already indexes labels, and a keyword
        // that merely restates one is what the manifest's own rule forbids.
        keywords: usable(field.label, [...spec.keywords, ...(field.keywords ?? [])]),
        unavailable: gated,
        pending: extPending,
        read: () => String(ext().configs[spec.slug]?.[field.key] ?? ''),
        write: (v, ctx) => {
          if (ctx.userId) ext().setConfigValue(ctx.userId, spec.slug, field.key, String(v).trim());
        },
        defaultValue: '',
      });
    }

    for (const field of spec.secrets) {
      records.push({
        id: `${toggleId}.${field.key}`,
        pane,
        label: field.label,
        description: field.description,
        control: 'text',
        textVariant: 'secret',
        placeholder: () =>
          channelSecrets().isSet(spec.slug, field.key) ? 'Saved — type to replace' : 'Not set',
        dependsOn: toggleId,
        keywords: usable(field.label, [
          ...spec.keywords,
          'token', 'secret', 'credential', 'key', 'password',
        ]),
        unavailable: () =>
          !channelSecrets().available
            ? 'Needs a database update that has not landed here yet.'
            : master.on()
              ? null
              : `needs ${master.label}, in Rituals`,
        // Write-only: there is nothing to read back, by design.
        read: () => '',
        write: (v) => channelSecrets().setSecret(spec.slug, field.key, String(v).trim()),
        defaultValue: '',
      });
    }
  }

  return records;
}

/* ------------------------------------------------------------- shortcuts */

/**
 * A keyboard binding, as a settings record.
 *
 * THE SEAM, stated once. lib/commands/registry.ts declares what a command IS,
 * including the binding it owns; lib/keyboard-shortcuts-store.ts folds those
 * plus the two shell-owned bindings into DEFAULT_SHORTCUTS, which is the list
 * the keydown dispatcher reads and the list a user's rebinding is keyed
 * against. This maps 1:1 over THAT list and adds nothing to it — no keys, no
 * ids, no labels of its own. There is a test that the two lists have the same
 * ids in the same order, because a second hand-maintained copy of the binding
 * table is exactly the failure this arrangement exists to prevent.
 *
 * Why records at all, rather than a bespoke table: everything the settings
 * surface already does for a record it now does for a binding — search across
 * label, description and keywords; `?focus=keys.undo` scrolling to the row and
 * ringing it; the lime modified bar; per-row reset. None of that was reachable
 * while the whole pane was one button that opened a dialog.
 *
 * The VALUE is the encoded chord ("mod k"), normalized on both sides, so
 * `isModified` — a plain `read() !== defaultValue` — is true exactly when the
 * user has actually moved the binding somewhere else. Rebinding ⌘K to ⌃K on
 * Windows encodes to the same string and correctly reads as unmodified.
 */
export interface ShortcutSettingRecord extends SettingRecord {
  /** The id the binding is persisted under. Frozen — see commands.test.ts. */
  shortcutId: string;
  /** Section heading, shared by both shells that render these records. */
  section: string;
}

/**
 * The words someone reaches for when they want to change a key, on every row.
 *
 * The manifest's rule is that keywords are hand-authored, and these are — once,
 * for a set that is generated. A per-binding list would be nineteen hand-written
 * lists that all say "hotkey", and the binding's own vocabulary already arrives
 * from the command it belongs to.
 */
const SHORTCUT_KEYWORDS = ['shortcut', 'keybinding', 'hotkey', 'binding', 'rebind', 'remap'];

const shortcuts = () => useKeyboardShortcutsStore.getState();

export const SHORTCUT_RECORDS: ShortcutSettingRecord[] = DEFAULT_SHORTCUTS.map((binding) => {
  const label = binding.label;
  const keywords = [
    ...new Set(
      [...SHORTCUT_KEYWORDS, ...binding.keywords.split(/\s+/)]
        .map((word) => word.toLowerCase())
        .filter(Boolean)
    ),
    // The manifest's own rule: a keyword that merely restates the label adds
    // nothing (labels are indexed already) and trips the structural test.
  ].filter((word) => word !== label.toLowerCase());

  return {
    // `keys.<shortcutId>`, verbatim. The shortcut id is already permanent —
    // it is the key a rebinding is stored under and commands.test.ts freezes
    // the list — so reusing it means the deep link and the persisted binding
    // cannot drift. A camel-cased variant would be a SECOND name for the same
    // thing, derived by a transform that can collide (`new_task` / `newTask`).
    id: `keys.${binding.id}`,
    shortcutId: binding.id,
    pane: 'keyboard' as const,
    section: binding.groupHeading,
    label,
    // The context sentence is appended rather than rendered apart, because a
    // flat table's lie is one of OMISSION — the row says nothing about where
    // it works — and one sentence in the place people already read fixes it.
    // It is indexed too, which is what makes "week" find the column bindings.
    description: [binding.description, binding.context].filter(Boolean).join(' ') || undefined,
    control: 'keys' as const,
    // NOT desktopOnly. The pane would be empty on every phone, and the rail
    // would still advertise it — a dead room, which the manifest test forbids.
    // An iPad with a keyboard makes the table useful anyway.
    keywords,
    read: () => encodeKeys(shortcutKeysFor(binding.id)),
    write: (value) => {
      const keys = decodeKeys(String(value));
      // Reset writes the DEFAULT back through this path. Storing it would pin
      // the user to today's default forever — see resetShortcut's note.
      if (encodeKeys(keys) === encodeKeys(binding.keys)) shortcuts().resetShortcut(binding.id);
      else if (keys.length) shortcuts().updateShortcut(binding.id, keys);
    },
    defaultValue: encodeKeys(binding.keys),
    display: (value) =>
      formatKeys(decodeKeys(String(value)), isApplePlatform()).join(' ') || 'No shortcut',
  };
});

/**
 * The records grouped for display, in first-appearance order — which is
 * registry order, which is the order the palette lists the same commands in.
 *
 * Shared by both shells so the settings pane and the ⌘/ overlay cannot group
 * or order the same set differently.
 */
export const SHORTCUT_SECTIONS: { heading: string; records: ShortcutSettingRecord[] }[] = (() => {
  const sections: { heading: string; records: ShortcutSettingRecord[] }[] = [];
  for (const record of SHORTCUT_RECORDS) {
    const existing = sections.find((section) => section.heading === record.section);
    if (existing) existing.records.push(record);
    else sections.push({ heading: record.section, records: [record] });
  }
  return sections;
})();

/**
 * A SettingCtx for a surface that renders ONLY shortcut records.
 *
 * Every `keys` record reads and writes through the keyboard-shortcuts store
 * alone — it never touches ctx, and there is a test that proves it by handing
 * each one a ctx that throws on any property access. That is what lets the ⌘/
 * overlay render the very same records from anywhere in the app, with none of
 * the theme, push-subscription and router plumbing the settings ROUTE assembles
 * for the rest of the manifest.
 */
export const SHORTCUT_ONLY_CTX: SettingCtx = {
  theme: undefined,
  setTheme: () => {},
  userId: null,
};

/* ---------------------------------------------------------------- records */

export const SETTINGS: SettingRecord[] = [
  /* ── Your day ─────────────────────────────────────────────────────────── */
  {
    id: 'day.weekStart',
    pane: 'day',
    label: 'Week starts on',
    description: 'Which day the week views open with.',
    control: 'enum',
    dbColumn: 'week_start_day',
    options: [
      { value: 'sunday', label: 'Sunday' },
      { value: 'monday', label: 'Monday' },
      { value: 'saturday', label: 'Saturday' },
    ],
    keywords: ['first day', 'calendar', 'week', 'begins', 'starts'],
    read: () => planner().weekStartDay,
    // setWeekStartDay persists itself (user_settings.week_start_day). Adding a
    // saveSettings() here would double-write the same column.
    write: (v) => planner().setWeekStartDay(v as 'sunday' | 'monday' | 'saturday'),
    defaultValue: 'sunday',
  },
  {
    id: 'day.timeFormat',
    pane: 'day',
    label: 'Time format',
    description: 'How every time in dsul reads.',
    control: 'enum',
    dbColumn: 'time_format',
    options: [
      { value: '12h', label: '12-hour' },
      { value: '24h', label: '24-hour' },
    ],
    keywords: ['clock', 'am pm', 'hours', 'military', '24 hour'],
    read: () => planner().timeFormat,
    write: (v) => planner().setTimeFormat(v as '12h' | '24h'),
    defaultValue: '12h',
  },
  {
    id: 'day.defaultBucket',
    pane: 'day',
    label: 'New items land in',
    description: 'Where capture puts something you gave no time to.',
    control: 'enum',
    advanced: true,
    dbColumn: 'default_time_bucket',
    options: [
      { value: 'anytime', label: 'Anytime' },
      { value: 'morning', label: 'Morning' },
      { value: 'afternoon', label: 'Afternoon' },
      { value: 'evening', label: 'Evening' },
    ],
    keywords: ['capture', 'default', 'bucket', 'quick add', 'new task'],
    read: () => planner().defaultTimeBucket,
    write: (v) => planner().setDefaultTimeBucket(v as TimeBucket),
    defaultValue: 'anytime',
  },
  {
    id: 'day.timezone',
    pane: 'day',
    label: 'Time zone',
    description: 'Detected from this device and synced automatically.',
    control: 'info',
    advanced: true,
    keywords: ['tz', 'utc', 'travel', 'offset', 'region', 'locale'],
    read: () =>
      planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Unknown',
    write: () => {},
    defaultValue: '',
  },

  /* ── Look ─────────────────────────────────────────────────────────────── */
  {
    id: 'look.theme',
    pane: 'look',
    label: 'Theme',
    control: 'enum',
    dbColumn: 'theme',
    options: [
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
      { value: 'system', label: 'System' },
    ],
    keywords: ['appearance', 'night', 'colour scheme', 'color scheme', 'contrast'],
    read: (ctx) => ctx.theme ?? 'system',
    // The one setter in the app that does NOT persist itself.
    write: (v, ctx) => {
      ctx.setTheme(String(v));
      if (ctx.userId) saveSettings(ctx.userId, { theme: String(v) });
    },
    defaultValue: 'system',
  },
  {
    id: 'look.palette',
    pane: 'look',
    label: 'Palette',
    description: 'The ground the app sits on. The lime accent stays.',
    control: 'enum',
    dbColumn: 'theme_palette',
    options: THEME_PALETTES.map((p) => ({ value: p.value, label: p.label })),
    keywords: ['color', 'colour', 'ground', 'background', 'tint', 'paper', 'slate', 'dune', 'iris'],
    read: () => palette().palette,
    // Palette pairs with theme, not the planner stores: the store setter is
    // localStorage + DOM only (via supabase-provider's sync effect), so the
    // Supabase write is paired here — same rule and same reason as look.theme.
    write: (v, ctx) => {
      if (!isThemePalette(v)) return;
      palette().setPalette(v, { eased: true });
      if (ctx.userId) saveSettings(ctx.userId, { theme_palette: v });
    },
    defaultValue: 'default',
  },
  {
    id: 'look.typeface',
    pane: 'look',
    label: 'Typeface',
    description: 'Item titles only — the chrome stays Inter.',
    control: 'enum',
    options: [
      { value: 'sans', label: 'Sans' },
      { value: 'serif', label: 'Serif' },
    ],
    keywords: ['font', 'type', 'source serif', 'inter', 'titles'],
    // Device-local: view-store has no user_settings columns, and inventing one
    // would fail the whole debounced upsert with PGRST204.
    read: () => view().typeMode,
    write: (v) => view().setTypeMode(v as TypeMode),
    defaultValue: 'sans',
  },
  {
    id: 'look.buckets',
    pane: 'look',
    label: 'Buckets',
    description: 'How a time-of-day bucket is drawn.',
    control: 'enum',
    options: [
      // The stored values stay 'spine'/'tray'. They're persisted in the
      // dsul-view blob, and renaming one to match its label would reset
      // every user's choice for a piece of copy.
      { value: 'spine', label: 'Floating card' },
      { value: 'tray', label: 'Head & tray' },
    ],
    keywords: ['bucket style', 'spine', 'card', 'tray', 'morning card'],
    read: () => view().bucketStyle,
    write: (v) => view().setBucketStyle(v as BucketStyle),
    defaultValue: 'spine',
  },
  {
    id: 'look.showCompleted',
    pane: 'look',
    label: 'Completed items on the canvas',
    // Names its scope, because the braindump and the canvas filter popovers
    // each keep their own hideCompleted and all three answer for a different
    // surface. Search returns them together; they are not merged.
    description: 'Keep finished work on the grid instead of clearing it. Tasks only — habits always stay.',
    control: 'switch',
    dbColumn: 'show_completed_tasks',
    keywords: ['done', 'finished', 'checked', 'hide', 'tick', 'complete'],
    read: () => planner().showCompletedTasks,
    write: (v) => planner().setShowCompletedTasks(Boolean(v)),
    defaultValue: true,
  },
  {
    id: 'look.animations',
    pane: 'look',
    // Named for the store's own polarity rather than inverted to "Reduce
    // motion": animationsEnabled=false is what stamps data-reduce-motion, and
    // an inverted control is one refactor away from a silent polarity bug.
    label: 'Animations',
    description: 'Turn off to reduce motion across dsul.',
    control: 'switch',
    dbColumn: 'animations_enabled',
    keywords: ['motion', 'transitions', 'jumpy', 'still', 'reduce motion', 'animate'],
    read: () => planner().animationsEnabled,
    write: (v) => planner().setAnimationsEnabled(Boolean(v)),
    defaultValue: true,
  },
  {
    id: 'look.timeIndicator',
    pane: 'look',
    label: 'Current time line',
    description: 'A line across today at the current hour, in Day and Week.',
    control: 'switch',
    advanced: true,
    dbColumn: 'show_time_indicator',
    keywords: ['now line', 'red line', 'glowing line', 'marker', 'current time'],
    read: () => planner().showCurrentTimeIndicator,
    write: (v) => planner().setShowCurrentTimeIndicator(Boolean(v)),
    defaultValue: true,
  },
  {
    id: 'look.showPaused',
    pane: 'look',
    label: 'Paused items on the grid',
    description: 'Show them greyed in place rather than hiding them.',
    control: 'switch',
    advanced: true,
    keywords: ['pause', 'snooze', 'greyed', 'hold', 'hidden'],
    // Local-only by design — no user_settings column exists, and adding one to
    // the saveSettings patch would PGRST204 the entire debounced flush.
    read: () => planner().showPausedOnGrid,
    write: (v) => planner().setShowPausedOnGrid(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'look.markStyle',
    pane: 'look',
    label: 'Schedule handles',
    description: 'The corner and resize marks on a schedule block.',
    control: 'enum',
    advanced: true,
    options: [
      { value: 'nodes', label: 'Nodes' },
      { value: 'target', label: 'Target' },
      { value: 'trim', label: 'Trim marks' },
    ],
    keywords: ['resize', 'corner', 'grips', 'drag', 'block'],
    read: () => view().scheduleMarkStyle,
    write: (v) => view().setScheduleMarkStyle(v as ScheduleMarkStyle),
    defaultValue: 'nodes',
  },
  {
    id: 'look.sidebarHover',
    pane: 'look',
    label: 'Reveal the sidebar on hover',
    description: 'Only applies while the sidebar is collapsed.',
    control: 'switch',
    advanced: true,
    desktopOnly: true,
    dbColumn: 'left_sidebar_hover',
    keywords: ['sidebar', 'edge', 'peek', 'braindump', 'slide out'],
    read: () => sidebar().leftSidebarHoverEnabled,
    write: (v) => sidebar().setLeftSidebarHoverEnabled(Boolean(v)),
    defaultValue: false,
  },

  /* ── Rituals ──────────────────────────────────────────────────────────── */
  {
    id: 'rituals.morningCheck',
    pane: 'rituals',
    label: 'Morning past-due check',
    description: 'A single quiet line above your day when items are still waiting from earlier.',
    control: 'switch',
    dbColumn: 'morning_check_enabled',
    keywords: ['overdue', 'past due', 'waiting', 'yesterday', 'sunrise', 'stale', 'backlog'],
    read: () => morning().morningCheckEnabled,
    write: (v) => morning().setMorningCheckEnabled(Boolean(v)),
    defaultValue: true,
  },
  {
    id: 'rituals.autoAge',
    pane: 'rituals',
    label: 'Auto-clear stale items',
    description:
      'Moves items past due by more than the chosen number of days to your Braindump, once a day, without asking.',
    control: 'switch',
    dependsOn: 'rituals.morningCheck',
    dbColumn: 'morning_auto_age_enabled',
    keywords: ['old', 'past due', 'stale', 'pile up', 'backlog', 'cleanup', 'unschedule', 'decay'],
    read: () => morning().morningAutoAgeEnabled,
    write: (v) => morning().setMorningAutoAgeEnabled(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'rituals.autoAgeDays',
    pane: 'rituals',
    label: 'Clear after',
    description: 'How long an item can sit past due before it is cleared.',
    control: 'enum',
    dependsOn: 'rituals.autoAge',
    dbColumn: 'morning_auto_age_days',
    options: [
      { value: '7', label: '7 days' },
      { value: '14', label: '14 days' },
      { value: '30', label: '30 days' },
      { value: '60', label: '60 days' },
      { value: '90', label: '90 days' },
    ],
    keywords: ['age', 'threshold', 'how long', 'days'],
    read: () => String(morning().morningAutoAgeDays),
    write: (v) => morning().setMorningAutoAgeDays(Number(v)),
    defaultValue: '30',
  },
  {
    id: 'rituals.eod',
    pane: 'rituals',
    label: 'End-of-day review',
    description: 'Review what you got through before the day closes.',
    control: 'switch',
    dbColumn: 'eod_review_enabled',
    // 'eod' is a KEYWORD, not an alias: the palette already claims /eod, and
    // aliases are a single global namespace the moment these two surfaces are
    // generated from one declaration. A keyword still finds it here.
    keywords: ['evening', 'reflect', 'wrap up', 'review', 'night', 'shutdown', 'eod'],
    read: () => eod().eodReviewEnabled,
    write: (v) => eod().setEodReviewEnabled(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'rituals.eodTime',
    pane: 'rituals',
    label: 'Review at',
    control: 'time',
    dependsOn: 'rituals.eod',
    dbColumn: 'eod_review_time',
    keywords: ['when', 'hour', 'evening', 'schedule'],
    read: () => eod().eodReviewTime,
    write: (v) => eod().setEodReviewTime(String(v)),
    defaultValue: '21:00',
  },
  {
    id: 'rituals.reminders',
    pane: 'rituals',
    label: 'Habit reminders',
    description:
      'A nudge at the time you set on each habit. Set the time on the habit itself — this is the switch that lets any of them through.',
    control: 'switch',
    dbColumn: 'habit_reminders_enabled',
    keywords: ['remind', 'nudge', 'alarm', 'prompt', 'cue', 'notify', 'ping', 'alert'],
    read: () => reminders().remindersEnabled,
    write: (v) => reminders().setRemindersEnabled(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'rituals.lastCall',
    pane: 'rituals',
    label: 'Last call',
    // Names the mechanism honestly. It is not a second copy of the reminder —
    // a repeat of the same prompt is what people stop reading — it is a
    // different message, once, that says what the day still owes.
    description: 'One message in the evening naming what is still open, and the streak riding on it.',
    control: 'switch',
    dependsOn: 'rituals.reminders',
    dbColumn: 'habit_last_call_enabled',
    keywords: ['streak', 'evening', 'risk', 'final', 'nudge', 'lose', 'before bed'],
    read: () => reminders().lastCallEnabled,
    write: (v) => reminders().setLastCallEnabled(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'rituals.lastCallTime',
    pane: 'rituals',
    label: 'Last call at',
    description: 'Late enough that the day has had its chance; early enough to still act on it.',
    control: 'time',
    dependsOn: 'rituals.lastCall',
    dbColumn: 'habit_last_call_time',
    keywords: ['when', 'hour', 'evening', 'schedule', 'time'],
    read: () => reminders().lastCallTime,
    write: (v) => reminders().setLastCallTime(String(v)),
    defaultValue: '20:30',
  },
  {
    id: 'rituals.stakes',
    pane: 'rituals',
    label: 'Settle the day',
    // Says what it does and what it does NOT do, because the extensions behind
    // it can cost money and "settle" alone does not warn anyone.
    description:
      'Once a night, work out what yesterday came to and report it to whatever you have attached — a Beeminder goal, a pledge, a person. Nothing happens until you turn one of those on.',
    control: 'switch',
    dbColumn: 'stakes_enabled',
    keywords: ['stakes', 'settle', 'ledger', 'accountability', 'beeminder', 'pledge', 'consequence', 'money'],
    read: () => reminders().stakesEnabled,
    write: (v) => reminders().setStakesEnabled(Boolean(v)),
    defaultValue: false,
  },
  {
    id: 'rituals.stakesTime',
    pane: 'rituals',
    label: 'Settle at',
    description:
      'Settles the day before. Late enough that nothing is still in flight — an end-of-day review can credit yesterday after midnight.',
    control: 'time',
    dependsOn: 'rituals.stakes',
    dbColumn: 'stakes_settle_time',
    keywords: ['when', 'hour', 'overnight', 'night', 'schedule'],
    read: () => reminders().stakesSettleTime,
    write: (v) => reminders().setStakesSettleTime(String(v)),
    defaultValue: '03:00',
  },
  {
    id: 'rituals.ledger',
    pane: 'rituals',
    label: 'Ledger',
    // The reader for what settling produces, one row below the switch that
    // produces it. The pledge tier's whole claim is that "you owe £30" is
    // backed by rows a person can look at, and a record with no reader is a
    // number the app made up.
    description: 'Every settled day, and what it came to. Read-only — dsul keeps the record, it cannot take payment.',
    control: 'action',
    dependsOn: 'rituals.stakes',
    keywords: ['owe', 'owed', 'debt', 'pledge', 'history', 'record', 'money', 'settled', 'stakes'],
    read: () => 'Open',
    write: (_v, ctx) => ctx.actions?.openLedger(),
    defaultValue: 'Open',
  },
  {
    id: 'rituals.push',
    pane: 'rituals',
    label: 'Push notifications',
    description: 'Let dsul reach this device when a ritual fires.',
    control: 'switch',
    keywords: ['notify', 'alerts', 'phone', 'reminders', 'badge', 'notification'],
    unavailable: (ctx) => {
      if (!ctx.push) return null;
      if (!ctx.push.isSupported) return 'not supported in this browser';
      if (ctx.push.permissionState === 'denied')
        return 'blocked in your browser settings — allow notifications, then reload';
      return null;
    },
    // Reflects the real PushSubscription, not a stored boolean.
    read: (ctx) => ctx.push?.isSubscribed ?? false,
    write: (v, ctx) => {
      if (!ctx.push) return;
      void (v ? ctx.push.subscribe() : ctx.push.unsubscribe()).catch((err) => {
        console.error('[settings] push toggle failed:', err);
      });
    },
    defaultValue: false,
  },

  /* ── Beacon ───────────────────────────────────────────────────────────── */
  {
    id: 'beacon.provider',
    pane: 'beacon',
    label: 'Assistant',
    description: 'Which agent answers you in the sidebar.',
    control: 'enum',
    options: [
      { value: 'openclaw', label: 'OpenClaw' },
      { value: 'openai', label: 'Beacon (OpenAI)' },
      { value: 'none', label: 'Off' },
    ],
    keywords: ['ai', 'agent', 'chat', 'llm', 'openclaw', 'beacon'],
    read: () => ai().provider,
    write: (v) => ai().setProvider(v as AIProvider),
    defaultValue: 'openclaw',
  },
  {
    id: 'beacon.instructions',
    pane: 'beacon',
    label: 'Custom instructions',
    description: 'What Beacon should know about how you work. Sent with every message.',
    control: 'text',
    textVariant: 'multiline',
    placeholder: "I plan in two-hour blocks and I'd rather you were blunt…",
    keywords: ['system prompt', 'personality', 'context', 'about me', 'profile', 'memory'],
    read: () => ai().systemPrompt,
    write: (v) => ai().setSystemPrompt(String(v)),
    defaultValue: '',
  },
  {
    id: 'beacon.gatewayUrl',
    pane: 'beacon',
    label: 'Gateway URL',
    description:
      'Talk to your gateway directly instead of through the plugin. Conversations keep their memory between sessions.',
    control: 'text',
    textVariant: 'line',
    placeholder: 'https://gateway.example.ts.net:8787',
    advanced: true,
    keywords: ['gateway', 'openclaw', 'url', 'host', 'tailscale', 'endpoint', 'transport'],
    unavailable: () =>
      !gateway().available
        ? 'Needs a database update that has not landed here yet.'
        : ai().provider === 'openclaw'
          ? null
          : 'only used by OpenClaw',
    read: () => gateway().gatewayUrl,
    write: (v) => gateway().setGatewayUrl(String(v)),
    defaultValue: '',
  },
  {
    id: 'beacon.gatewayToken',
    pane: 'beacon',
    label: 'Gateway token',
    description: 'Full operator access to your gateway — kept server-side and never sent back.',
    control: 'text',
    // Write-only: there is nothing to read back, by design.
    textVariant: 'secret',
    placeholder: () => (gateway().hasToken ? 'Saved — type to replace' : 'Not set'),
    advanced: true,
    // Not dependsOn: both gateway rows are advanced, so the disclosure already
    // groups them and a second level of hiding is what the redesign removed.
    keywords: ['gateway', 'openclaw', 'token', 'secret', 'credential', 'auth', 'bearer'],
    unavailable: () =>
      !gateway().available
        ? 'Needs a database update that has not landed here yet.'
        : ai().provider === 'openclaw'
          ? null
          : 'only used by OpenClaw',
    read: () => '',
    write: (v) => gateway().setToken(String(v)),
    defaultValue: '',
  },
  {
    id: 'beacon.apiKey',
    pane: 'beacon',
    label: 'OpenAI key',
    description: 'Stored on this device only, never synced.',
    control: 'text',
    // Was selected by `record.id === 'beacon.apiKey'` inside setting-row.
    textVariant: 'secret',
    placeholder: 'sk-…',
    advanced: true,
    keywords: ['api key', 'token', 'credential', 'openai', 'sk'],
    unavailable: () => (ai().provider === 'openai' ? null : 'only used by Beacon (OpenAI)'),
    read: () => ai().apiKey,
    write: (v) => ai().setApiKey(String(v)),
    defaultValue: '',
  },
  {
    id: 'beacon.model',
    pane: 'beacon',
    label: 'Model',
    control: 'enum',
    advanced: true,
    options: [
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { value: 'gpt-4o', label: 'gpt-4o' },
      { value: 'gpt-4-turbo', label: 'gpt-4-turbo' },
    ],
    keywords: ['openai', 'gpt', 'engine'],
    unavailable: () => (ai().provider === 'openai' ? null : 'only used by Beacon (OpenAI)'),
    read: () => ai().model,
    write: (v) => ai().setModel(String(v)),
    defaultValue: 'gpt-4o-mini',
  },

  /* ── Keyboard ─────────────────────────────────────────────────────────────
     Generated, one record per binding — see SHORTCUT_RECORDS below. The pane
     used to hold a single `action` row whose whole job was to open a modal,
     which meant the bindings themselves were unsearchable, undeep-linkable and
     visible only from inside a dialog. */
  ...SHORTCUT_RECORDS,

  /* ── dsul ───────────────────────────────────────────────────────────── */
  {
    id: 'dsul.tour',
    pane: 'dsul',
    label: 'Replay the tour',
    description: 'Walks you back through the shell. Takes you to the planner.',
    control: 'action',
    keywords: ['onboarding', 'tutorial', 'walkthrough', 'intro', 'guide'],
    read: () => 'Replay',
    write: (_v, ctx) => ctx.actions?.replayTour(),
    defaultValue: 'Replay',
  },
  {
    id: 'dsul.feedback',
    pane: 'dsul',
    label: 'Send feedback',
    description: 'Goes straight to the person who can fix it.',
    control: 'action',
    keywords: ['bug', 'report', 'issue', 'broken', 'support', 'feedback'],
    read: () => 'Write',
    write: (_v, ctx) => ctx.actions?.openBugReport(),
    defaultValue: 'Write',
  },
  {
    id: 'dsul.signOut',
    pane: 'dsul',
    label: 'Sign out',
    control: 'action',
    keywords: ['log out', 'logout', 'account', 'leave', 'switch account'],
    read: () => 'Sign out',
    write: (_v, ctx) => ctx.actions?.signOut(),
    defaultValue: 'Sign out',
  },

  /* ── Extensions ───────────────────────────────────────────────────────── */
  // One switch per manifest entry in lib/extension-registry.ts, each in the
  // extension's OWN pane (see EXTENSION_PANES) rather than in a shared list.
  // Persistence is the user_extensions table (migration 026), NOT a
  // user_settings column — per-extension columns are the missing-column reset
  // footgun. No dbColumn, so data-setting falls back to the record id.
  //
  // These two are hand-written where the channels and stakes below are
  // generated, and they stay that way: their ids predate the slug convention
  // (`extensions.habitHeatmap`, not `extensions.habit-heatmap`) and an id is a
  // permanent deep link. `pane` is derived from the slug all the same, so the
  // pane and the catalog entry cannot drift apart.
  //
  // Goals and the Organize console are hand-written for a different reason than
  // the two below: they have no ChannelSettingsSpec, because they are not
  // channels — there is nothing to credential and nothing to configure. One
  // switch each is the whole surface, which is exactly what the extension index
  // renders a row from.
  {
    id: 'extensions.goals',
    pane: extensionPaneId(EXT_GOALS),
    label: 'Goals',
    description:
      'Long-term goals with milestones and check-ins, a Goal filter and a Goal grouping. Switching it off hides the goal layer and keeps every goal, every item and every membership.',
    control: 'switch',
    keywords: ['goal', 'milestone', 'check-in', 'checkin', 'ambition', 'target', 'long term'],
    unavailable: extUnavailable,
    pending: extPending,
    read: () => ext().isEnabled(EXT_GOALS),
    write: (v, ctx) => {
      if (ctx.userId) ext().setEnabled(ctx.userId, EXT_GOALS, Boolean(v));
    },
    defaultValue: false,
  },
  {
    id: 'extensions.organize',
    pane: extensionPaneId(EXT_ORGANIZE),
    label: 'Organize console',
    description:
      'The console for routines, programs, projects, item types, habit groups and recently deleted. Switching it off closes the console; nothing in it is deleted.',
    control: 'switch',
    keywords: ['organize', 'organise', 'console', 'manage', 'containers', 'trash', 'bulk'],
    unavailable: extUnavailable,
    pending: extPending,
    read: () => ext().isEnabled(EXT_ORGANIZE),
    write: (v, ctx) => {
      if (ctx.userId) ext().setEnabled(ctx.userId, EXT_ORGANIZE, Boolean(v));
    },
    // ON by default (see extension-registry). Must track the manifest default, or
    // a fresh account draws the "modified" bar and a per-row reset would write
    // OFF into the user's row — isModified is read() !== defaultValue.
    defaultValue: true,
  },
  {
    id: 'extensions.streaks',
    pane: extensionPaneId(EXT_STREAKS),
    label: 'Streaks',
    description:
      'Flame badges and streak counts across the app. Off hides them everywhere; nothing stops counting — reminders and stakes still read your streak.',
    control: 'switch',
    keywords: ['streak', 'flame', 'fire', 'chain', 'consecutive', 'momentum', 'habits'],
    unavailable: extUnavailable,
    // extPending matters MORE here than for the off-by-default rows: the switch
    // defaults ON, so without it the pre-hydration window would draw it on and a
    // stray click could write OFF over a server row that is actually on.
    pending: extPending,
    read: () => ext().isEnabled(EXT_STREAKS),
    write: (v, ctx) => {
      if (ctx.userId) ext().setEnabled(ctx.userId, EXT_STREAKS, Boolean(v));
    },
    defaultValue: true,
  },
  {
    id: 'extensions.habitHeatmap',
    pane: extensionPaneId(EXT_HABIT_HEATMAP),
    label: 'Habit heatmap',
    description: 'A six-month completion grid in the item panel, for anything with a streak.',
    control: 'switch',
    keywords: ['heatmap', 'history', 'streak', 'grid', 'completion', 'habits'],
    unavailable: extUnavailable,
    pending: extPending,
    read: () => ext().isEnabled(EXT_HABIT_HEATMAP),
    write: (v, ctx) => {
      if (ctx.userId) ext().setEnabled(ctx.userId, EXT_HABIT_HEATMAP, Boolean(v));
    },
    defaultValue: false,
  },
  {
    id: 'extensions.confetti',
    pane: extensionPaneId(EXT_COMPLETION_CONFETTI),
    label: 'Completion confetti',
    description: 'A small burst when you complete something. Purely celebratory.',
    control: 'switch',
    keywords: ['celebrate', 'party', 'fun', 'burst', 'reward', 'dopamine'],
    unavailable: extUnavailable,
    pending: extPending,
    read: () => ext().isEnabled(EXT_COMPLETION_CONFETTI),
    write: (v, ctx) => {
      if (ctx.userId) ext().setEnabled(ctx.userId, EXT_COMPLETION_CONFETTI, Boolean(v));
    },
    defaultValue: false,
  },

  // The delivery channels and their fields — see channelRecords().
  ...channelRecords(),
];

/**
 * Configuration that deliberately does NOT live in settings, indexed so search
 * can still answer for it.
 *
 * This is what keeps the rail small. The next class of configuration earns a
 * destination record and a manager surface rather than a new pane — the budget
 * is a mechanism, not a promise someone has to keep defending. (Extensions
 * spent the budget once, deliberately: its rows are durable opt-in switches
 * with no manager surface to point a destination at. It has since grown a
 * level BELOW itself, one pane per extension — which costs the rail nothing,
 * because the rail still shows one Extensions entry and always will.)
 */
export interface DestinationRecord {
  id: string;
  label: string;
  /** Where it actually lives, shown on the result row. */
  where: string;
  keywords: string[];
  /**
   * Dispatched on click. The page supplies the implementation.
   *
   * `manage-categories` and `manage-collections` collapsed into one `organize`
   * when the two dialogs became one console — the split was never about what
   * the user wanted, only about which dialog happened to own the row.
   */
  action: 'organize' | 'connect-openclaw' | 'openclaw-docs' | 'ledger';
  /** For `organize`: which section to land on. */
  section?: string;
}

export const DESTINATIONS: DestinationRecord[] = [
  {
    id: 'dest.projects',
    label: 'Projects',
    // Names the real surface. "Planner" was true of a dialog reachable from two
    // unrelated places; these five now live in one console with a name.
    where: 'Organize',
    // ONE DESTINATION since migration 039. `dest.groups` pointed at a
    // 'groups' console section that no longer exists — and a destination
    // naming a dead section does not fail, it falls through `sectionMeta` to
    // the FIRST section, so searching "habit group" would have opened Routines.
    // Its keywords are folded in here so the search still answers, which is the
    // whole point of a destination record.
    keywords: [
      'project', 'folder', 'colour', 'color', 'container', 'manage',
      'group', 'habit', 'category', 'wellness', 'work',
    ],
    action: 'organize',
    section: 'projects',
  },
  {
    id: 'dest.types',
    label: 'Item types',
    where: 'Organize',
    keywords: ['custom type', 'registry', 'task type', 'habit type', 'kind'],
    action: 'organize',
    section: 'types',
  },
  {
    id: 'dest.routines',
    label: 'Routines',
    where: 'Organize',
    keywords: ['routine', 'recurring', 'template', 'stack'],
    action: 'organize',
    section: 'routines',
  },
  {
    id: 'dest.programs',
    label: 'Programs',
    where: 'Organize',
    keywords: ['program', 'plan', 'course', 'block', 'season'],
    action: 'organize',
    section: 'programs',
  },
  {
    id: 'dest.goals',
    label: 'Goals',
    where: 'Organize',
    // The nouns someone reaches for when the thing they want is long-horizon:
    // the container's own word, the two roles it grants, and the shapes people
    // describe them as before they know the feature exists.
    keywords: ['goal', 'milestone', 'check-in', 'checkin', 'ambition', 'target', 'long term'],
    action: 'organize',
    section: 'goals',
  },
  {
    id: 'dest.trash',
    label: 'Recently deleted',
    where: 'Organize',
    // Labelled by what someone in trouble would type, which is rarely "trash".
    // The other five records name a thing you are looking for; this one is
    // searched from a different emotional place and needs the vocabulary of
    // that moment — "restore", "undelete", "recover", "gone".
    keywords: ['trash', 'deleted', 'restore', 'undelete', 'recover', 'bin', 'gone', 'lost'],
    action: 'organize',
    section: 'trash',
  },
  {
    id: 'dest.openclaw',
    label: 'Connect OpenClaw',
    where: '/connect',
    keywords: ['openclaw', 'agent', 'connect', 'pair', 'device', 'cli'],
    action: 'connect-openclaw',
  },
  {
    id: 'dest.ledger',
    label: 'Ledger',
    where: '/ledger',
    // "How much do I owe" is what someone types, and none of those words are in
    // the label. The stake settings are a few rows away in Extensions, so this
    // record's whole job is catching the search that is about the NUMBER rather
    // than about configuring anything.
    keywords: ['owe', 'owed', 'debt', 'pledge', 'stake', 'money', 'charity', 'history', 'record', 'settled'],
    action: 'ledger',
  },
];

/* ---------------------------------------------------------------- lookups */

export function settingById(id: string): SettingRecord | undefined {
  return SETTINGS.find((s) => s.id === id);
}

export function settingsForPane(pane: PaneId): SettingRecord[] {
  return SETTINGS.filter((s) => s.pane === pane);
}

export function paneById(id: string): SettingsPane | undefined {
  return ALL_PANES.find((p) => p.id === id);
}

/**
 * The route's gate, and the reason ExtensionPaneId can afford to be an open
 * template literal type: `extensions/beeminder` is a pane because the catalog
 * has that slug, and `extensions/anything-else` is not a pane at all.
 */
export function isPaneId(value: string): value is PaneId {
  return ALL_PANES.some((p) => p.id === value);
}

/** The value as the user sees it — chip copy, and what search echoes back. */
export function displayValue(record: SettingRecord, value: string | boolean): string {
  if (record.display) return record.display(value);
  if (record.control === 'switch') return value ? 'On' : 'Off';
  return labelFor(record.options, value);
}

/** Every value label, for the index. "Sunday" must find Week starts on. */
export function valueLabels(record: SettingRecord): string[] {
  return (record.options ?? []).map((o) => o.label);
}

export function isModified(record: SettingRecord, ctx: SettingCtx): boolean {
  // Actions and read-only info rows have no default to differ from.
  if (record.control === 'action' || record.control === 'info') return false;
  try {
    return record.read(ctx) !== record.defaultValue;
  } catch {
    return false;
  }
}
