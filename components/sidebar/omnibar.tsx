'use client';

import { useRouter } from 'next/navigation';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Plus, Sparkles, SlashSquare, CheckCircle2, Flame, X,
  Target, Search, CornerDownLeft, Check,
} from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { RelayField } from '@/components/primitives/relay-field';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore, openEditFor, openAddDialog, openBulkAdd } from '@/lib/ui-store';
import { isBulkPaste } from '@/lib/bulk-add';
import { useChatStore } from '@/lib/chat-store';
import { groupResults, searchGoals, searchItems, type SearchGroup } from '@/lib/search';
import { sortGoalsForDisplay } from '@/lib/goals';
import { useGoalsEnabled } from '@/lib/extension-gates';
import { getItemTypeConfig } from '@/lib/item-registry';
import { suppressionReason } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { CategoryIcon } from '@/lib/category-icons';
import { RELAY } from '@/lib/relay-config';
import { cn } from '@/lib/utils';
import {
  formatKeys,
  groupRows,
  isAvailable,
  matchArgOptions,
  matchCommands,
  matchEntityOptions,
  itemContainer,
  itemIcon,
  recentRows,
  resolveLabel,
  RECENT_HEADING,
  type Command as DsulCommand,
  type CommandArgOption,
  type CommandEntityOption,
  type CommandRow,
} from '@/lib/commands';
import { useCommandUsageStore } from '@/lib/command-usage-store';
import { useShortcutBindings } from '@/lib/keyboard-shortcuts-store';
import { useCommandContext } from '@/hooks/use-command-context';

/**
 * The omnibar: search, quick-add, /commands and chat from one input. Prefixes:
 * '+' add, '/' command, '?' chat.
 *
 * ONE COMPONENT, TWO SHELLS (`variant`). The same input logic renders in two
 * chromes: the resting `dock` bar at the bottom of the sidebar, and the
 * summoned `launcher` modal. All four modes work in both — the shells differ
 * only in emphasis, default state, Enter semantics, and copy. Every difference
 * reads off `variant`; everything else is shared, which is the whole reason
 * this is a prop and not two components.
 *
 * Commands AND their keyboard bindings are NOT declared here — they come from
 * lib/commands/registry.ts, so this component only knows how to render and run
 * whatever the registry exposes (and focuses on ui-store's focus token).
 */

/** Mobile has ~320px of panel above a docked input; desktop can scroll. */
const MOBILE_ROW_LIMIT = 8;
const FREE_TEXT_COMMAND_LIMIT = 4;

/** Which shell is hosting the shared input. See the component doc-comment. */
export type OmnibarVariant = 'dock' | 'launcher';

/**
 * How long the capture relay's brightness window stays open, in ms.
 *
 * The field rests at zero intensity, so this — not `burstDecay` — is what makes
 * the strike visible at all: the restarted ripple is multiplied by the settled
 * level, and a field settled at 0 renders nothing however hard it is struck. It
 * outlasts the ring's trip across the bar and then closes, and RelayField's
 * settle lerp fades the last of it over ~300ms more.
 */
const CAPTURE_SWELL_MS = 700;

/**
 * The results panel's outer chrome. Dock: the floating card above the pill,
 * holding the scrolling list AND the multiselect run bar, so the bar stays
 * pinned under the list instead of scrolling with it. Launcher: nothing — the
 * card is the whole Command, and `order` places the list and bar inside it.
 */
function PanelShell({ isLauncher, children }: { isLauncher: boolean; children: ReactNode }) {
  if (isLauncher) return <>{children}</>;
  return (
    <div className="absolute left-0 right-0 bottom-full z-50 mb-2 flex flex-col overflow-hidden rounded-card border border-border bg-popover shadow-soft-lg">
      {children}
    </div>
  );
}

/**
 * @param variant which shell is hosting this instance — 'dock' (sidebar,
 *   default) or 'launcher' (the summoned command modal). Exposed as
 *   `data-omnibar-variant` so tests can target one shell unambiguously when
 *   both are mounted.
 * @param initialQuery seeds the input on mount (launcher only) — e.g. the `/`
 *   binding opens the launcher already in command mode.
 * @param onAskBeacon overrides where "Ask Beacon" opens the chat. Desktop
 *   grows the sidebar dock (default); mobile switches to the Chat tab.
 * @param onFocusChange reports the input's focus state to the parent (the dock
 *   drives its ambient relay from this — a stable signal, unlike container
 *   focus-within which sticks when a menu returns focus or a child unmounts).
 * @param onPulse fires on the INSTANT focus arrives (and on every ⌘K), for a
 *   one-shot flourish. Not derivable from onFocusChange: ⌘K on an already
 *   focused input fires no focus event but should still register.
 * @param captureRelay moves the relay INSIDE the pill and re-strikes it each
 *   time an item files itself. Off by default, which is desktop: there the
 *   field is a halo around the pill and the dock behind it carries the ambient
 *   one, so a second lit surface in the same 48px would be two fields arguing.
 *   The phone's dock has no such slack — the 44px mode card and the bar cover
 *   the well end to end, leaving a 10px picture-frame no ripple can be read in
 *   — so there the bar itself is the surface, and the one thing it lights for
 *   is the app's core verb. See memory/plans/mobile-redesign.md § Motion.
 *
 *   Dock-only, and ignored under variant="launcher": a summoned modal closes on
 *   the add it would be answering, so the field would unmount before the ripple
 *   had crossed the bar. The launcher carries NO relay at all — neither this
 *   in-pill one nor the outer halo — because it renders as a card, not a pill,
 *   and the card's own elevation is what lifts it off the scrim.
 */
export function Omnibar({
  variant = 'dock',
  initialQuery,
  onAskBeacon,
  onFocusChange,
  onPulse,
  captureRelay = false,
}: {
  variant?: OmnibarVariant;
  initialQuery?: string;
  onAskBeacon?: () => void;
  onFocusChange?: (focused: boolean) => void;
  onPulse?: () => void;
  captureRelay?: boolean;
} = {}) {
  const isLauncher = variant === 'launcher';
  const {
    tasks,
    habits,
    addTask,
    getProjectEmoji,
    userTimezone,
    routines,
    programs,
    goals,
    animationsEnabled,
  } = usePlannerStore();
  const router = useRouter();
  // Today, not selectedDate — the omnibar carries no date of its own.
  const searchTz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const searchTodayStr = toDateStr(new Date(), searchTz);
  const focusToken = useUIStore((s) => s.omnibarFocusToken);

  // The launcher can be summoned pre-seeded (the `/` binding opens it in command
  // mode); the dock always starts empty.
  const [query, setQuery] = useState(initialQuery ?? '');
  // The launcher opens with its resting panel already showing (it's a summoned
  // modal); the dock starts closed and opens on focus. Derived at init rather
  // than set in an effect so no synchronous setState-in-effect is needed.
  const [open, setOpen] = useState(isLauncher);
  const [focused, setFocused] = useState(false);
  /** Set once a command needing an argument is picked — the "chip" state. */
  const [activeCommand, setActiveCommand] = useState<DsulCommand | null>(null);
  /**
   * Multiselect in an entity picker: the ids marked so far, in mark order.
   * Held as raw ids and re-resolved every render (`livePicked`), so an item that
   * stops qualifying mid-selection silently drops out of every count and run.
   */
  const [picked, setPicked] = useState<string[]>([]);
  /** What the sr-only live region says after a keyboard edit to the marks. */
  const [announce, setAnnounce] = useState('');
  // Whether the click now being dispatched on a picker row carried the
  // multiselect modifier. cmdk's onSelect gets no event, so the row's
  // capture-phase click handler (which runs first, in the same dispatch) sets
  // this and onSelect reads it. Read off the click itself, never remembered
  // from an earlier event: a held Ctrl auto-repeats keydown, so any flag a
  // keypress could clear is gone by the time a slow Ctrl-click lands.
  const modClickRef = useRef(false);
  // True from an unmarking Backspace until the key is released, so a HELD key
  // stops after one pick instead of walking the selection and popping the chip.
  const backspaceHoldRef = useRef(false);
  const [isMac, setIsMac] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * The capture relay's two halves (see `captureRelay`), and the switch that
   * decides whether either exists.
   *
   * `filed` is a token, not a count: every change re-strikes the ripple from the
   * middle of the bar. `filing` is the brightness window it travels in — held
   * separately because the field rests dark, so the wave needs something to be
   * multiplied by. The mount is gated on `animationsEnabled`, the store value
   * that stamps `[data-reduce-motion]` on <html>: that attribute only reaches
   * CSS animations and transitions, and this is a canvas running its own RAF
   * loop, so honouring the setting has to be done here.
   *
   * `!isLauncher` is the deliberate half: `captureRelay` is a DOCK affordance,
   * and the launcher would unmount the field on the very add it answers. This
   * is also the switch the halo below reads (inverted), so the launcher always
   * lands on the halo branch rather than on neither.
   */
  const inPillRelay = captureRelay && !isLauncher;
  const relayOnCapture = RELAY.omnibar && inPillRelay && animationsEnabled;
  const [filed, setFiled] = useState(0);
  const [filing, setFiling] = useState(false);
  const filingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only on unmount. Re-running this on every render would cancel the window
  // the render that opened it just started.
  useEffect(
    () => () => {
      if (filingTimer.current) clearTimeout(filingTimer.current);
    },
    []
  );

  const ctx = useCommandContext({ openChat: onAskBeacon });
  const usage = useCommandUsageStore((s) => s.usage);
  const bindings = useShortcutBindings();

  useEffect(() => {
    setIsMac(typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  }, []);

  /** Resolved key hint per shortcut id, for the right-aligned label. */
  const keyHints = useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of bindings) map.set(binding.id, formatKeys(binding.keys, isMac).join(' '));
    return map;
  }, [bindings, isMac]);

  // Held in a ref so it stays OUT of the focusToken effect's deps. That effect
  // fires a pulse on every run, and its `focusToken > 0` guard stays true once
  // tripped — so an unmemoised onPulse in the deps would re-fire the wave on
  // every parent render.
  const onPulseRef = useRef(onPulse);
  useEffect(() => {
    onPulseRef.current = onPulse;
  });

  // ⌘K (and friends) focus request. Pulses unconditionally: when the input is
  // already focused, .focus() fires no focus event, and the shortcut should
  // still register as *something* happening.
  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
      setOpen(true);
      onPulseRef.current?.();
    }
  }, [focusToken]);

  // The launcher is a summoned modal: it must open already focused (its resting
  // panel is shown via the initial `open` state above). The dock instead grabs
  // focus on demand via the focus token; here focus arrives with the mount.
  // Radix autofocus usually lands on the first focusable, but cmdk's combobox
  // input makes that unreliable, so claim it explicitly. `variant` is stable
  // per instance, so this runs once, on mount.
  useEffect(() => {
    if (variant !== 'launcher') return;
    inputRef.current?.focus();
  }, [variant]);

  // Report focus up so the dock can light its relay off a reliable signal.
  useEffect(() => {
    onFocusChange?.(focused);
  }, [focused, onFocusChange]);

  // Click outside closes the panel
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const trimmed = query.trim();
  // Prefixes are suspended while a command is waiting for its argument — a
  // project called "/etc" has to be typeable.
  const isCommandMode = !activeCommand && trimmed.startsWith('/');
  const isAddMode = !activeCommand && trimmed.startsWith('+');
  const isChatMode = !activeCommand && trimmed.startsWith('?');
  const commandQuery = isCommandMode ? trimmed.slice(1).trim() : '';
  const addTitle = isAddMode ? trimmed.slice(1).trim() : trimmed;
  // Every prefix is stripped, not just '?': ⌘Enter sends to Beacon from any
  // mode, and it must not send the literal '+' or '/' along with the text.
  const chatText =
    isChatMode || isAddMode || isCommandMode ? trimmed.slice(1).trim() : trimmed;

  /* ── argument mode ─────────────────────────────────────────────────── */

  const argument = activeCommand?.argument;

  const argOptions = useMemo(() => {
    if (!activeCommand || argument?.kind !== 'enum') return [];
    return matchArgOptions(activeCommand, query, ctx);
  }, [activeCommand, argument, query, ctx]);

  /**
   * Entity picker rows. `tasks`/`habits` are in the deps because the search
   * reads them off the store non-reactively — without them, completing an item
   * would leave it sitting in the list for the next pick.
   */
  const entityOptions = useMemo(() => {
    if (!activeCommand || argument?.kind !== 'entity') return [];
    return matchEntityOptions(activeCommand, query, ctx);
    // tasks/habits look unused to the linter and are not: the search reads the
    // store non-reactively, so these are what re-run it after a mutation.
    // Without them, completing an item leaves it in the list for the next pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCommand, argument, query, ctx, tasks, habits]);

  /**
   * Multiselect is a capability of the ARGUMENT (`runMany` present), never a
   * check on a command id — every itemCommand has it unless its spec opts out.
   */
  const canMulti = !!activeCommand && argument?.kind === 'entity' && !!argument.runMany;

  /**
   * The marks as live options. Resolved through the argument, not looked up in
   * `entityOptions`: the rows are capped and filtered by the query, and a mark
   * has to outlive the query that surfaced it. Same deps (and the same reason
   * for tasks/habits) as `entityOptions`.
   */
  const resolvedPicked = useMemo(() => {
    if (!activeCommand || argument?.kind !== 'entity' || !argument.runMany) return [];
    if (picked.length === 0) return [];
    return argument.resolve
      ? argument.resolve(picked, ctx)
      : entityOptions.filter((o) => picked.includes(o.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCommand, argument, picked, ctx, entityOptions, tasks, habits]);
  /** Every count, row state, key gate and run reads this, never `picked`. */
  const livePicked = useMemo(() => resolvedPicked.map((o) => o.value), [resolvedPicked]);
  /** Marked rows the current query hides — shown under "Also selected". */
  const hiddenPicked = useMemo(
    () => resolvedPicked.filter((o) => !entityOptions.some((e) => e.value === o.value)),
    [resolvedPicked, entityOptions],
  );
  const pickedCount = livePicked.length;

  const setMarks = (next: string[], message = '') => {
    setPicked(next);
    setAnnounce(message);
  };

  /** Marks or unmarks one row, pruning ids that no longer resolve on the way. */
  const toggle = (id: string) => {
    const live = picked.filter((x) => livePicked.includes(x));
    setMarks(live.includes(id) ? live.filter((x) => x !== id) : [...live, id]);
  };

  const argError = useMemo(() => {
    if (argument?.kind !== 'text' || !query.trim()) return null;
    return argument.validate?.(query) ?? null;
  }, [argument, query]);

  /* ── rows ──────────────────────────────────────────────────────────── */

  /**
   * Goals, resolved BESIDE the item sections rather than inside them — a goal
   * is not an Item, needs a navigate action rather than an edit, and the key
   * `goal` would collide with a custom item type of that name. See searchGoals.
   */
  const goalsOn = useGoalsEnabled();
  const goalHits = useMemo(() => {
    // The extension gate comes first. A hit here navigates to /goal/[id], which
    // is an inert page while Goals is off — so a channel that still answered
    // would be offering a door to a room the same switch has shut. The
    // extension stays findable in Settings, which is where "off" belongs.
    if (!goalsOn) return [];
    // Same four-mode gate the item results carry. Without it a `/`, `+` or `?`
    // prefix still ran a substring search — and since a goal's `why` is
    // paragraph-shaped, prose containing a slash meant pressing `/` could
    // render a Goals section above the command palette.
    if (activeCommand || isCommandMode || isAddMode || isChatMode) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Ended goals sort last inside the cap. They stay findable — searching by
    // name is how you reach a record — but four achieved goals must not push
    // the one you are running off the list.
    return sortGoalsForDisplay(searchGoals(trimmed, goals)).slice(0, 4);
  }, [goalsOn, query, goals, activeCommand, isCommandMode, isAddMode, isChatMode]);

  /** Search hits as one section per item type; row caps live in groupResults. */
  const results = useMemo<SearchGroup[]>(() => {
    if (activeCommand || isCommandMode || isAddMode || isChatMode || !trimmed) return [];
    return groupResults(searchItems(trimmed, tasks, habits));
  }, [trimmed, activeCommand, isCommandMode, isAddMode, isChatMode, tasks, habits]);

  /**
   * The "Recently used" rows, kept out of `commandRows` so they render as
   * their own labelled section rather than blending into the actions that are
   * always on offer. Only shown when you have not typed a query — once you are
   * searching, relevance is the only ordering that makes sense.
   *
   * Add task and Ask Beacon are excluded: the inline rows below already are
   * those two commands, so a recent entry for either would render twice.
   */
  const recentCommandRows = useMemo<CommandRow[]>(() => {
    if (activeCommand || isAddMode || isChatMode) return [];
    if (trimmed && !(isCommandMode && !commandQuery)) return [];
    return recentRows(ctx, usage, 6)
      .filter((row) => row.command.id !== 'create.task' && row.command.id !== 'rituals.chat')
      .slice(0, ctx.isMobile ? 3 : 4);
  }, [activeCommand, isAddMode, isChatMode, isCommandMode, commandQuery, trimmed, ctx, usage]);

  const commandRows = useMemo<CommandRow[]>(() => {
    if (activeCommand || isAddMode || isChatMode) return [];

    // Resting state: nothing but the recents section above and the inline
    // add / chat rows below.
    if (!trimmed) return [];

    if (isCommandMode) {
      const rows = matchCommands(commandQuery, ctx, { usage });
      return ctx.isMobile ? rows.slice(0, MOBILE_ROW_LIMIT) : rows;
    }

    // Free text: the inline quick-add and Ask Beacon rows below already ARE
    // those two commands, so drop the duplicates before capping. Per-goal
    // "Open X" commands go the same way and for the same reason — the Goals
    // section above is those rows, with the same destination — and leaving both
    // in also spent one of a capped four slots on a repeat. In COMMAND mode
    // they stay: the goal channel is gated off there, so the command row is the
    // only way to reach a goal by typing.
    return matchCommands(trimmed, ctx, { usage })
      .filter(
        (row) =>
          row.command.id !== 'create.task' &&
          row.command.id !== 'rituals.chat' &&
          !row.command.id.startsWith('goal.open.'),
      )
      .slice(0, ctx.isMobile ? 3 : FREE_TEXT_COMMAND_LIMIT);
  }, [activeCommand, isAddMode, isChatMode, isCommandMode, commandQuery, trimmed, ctx, usage]);

  /**
   * Grouped headings only in the full palette on desktop. On mobile the panel
   * is 320px tall and nine group headings would eat most of it before a row
   * rendered, so it stays a flat ranked list there.
   */
  const grouped = useMemo(
    // commandRows.length matters: groupRows([]) is an empty ARRAY, which is
    // truthy, so `grouped?.map` would render nothing while `!grouped` also
    // skipped the fallback — leaving an empty popover for a query like "/zzz".
    () =>
      isCommandMode && !ctx.isMobile && commandRows.length > 0 ? groupRows(commandRows) : null,
    [isCommandMode, ctx.isMobile, commandRows]
  );

  /* ── actions ───────────────────────────────────────────────────────── */

  const closeAndClear = () => {
    setQuery('');
    setActiveCommand(null);
    setMarks([]);
    setOpen(false);
  };

  const clearArgument = () => {
    setActiveCommand(null);
    setMarks([]);
    setQuery('');
    inputRef.current?.focus();
  };

  // In the launcher, a terminal action closes the modal — UNLESS the action
  // itself opened another dialog (edit item, add, organize, bulk-add), which has
  // already replaced the launcher slot in ui-store; closing then would clobber
  // that new dialog. So only close while the launcher is still the active
  // dialog. No-op for the dock.
  const closeLauncher = () => {
    if (!isLauncher) return;
    const ui = useUIStore.getState();
    if (ui.activeDialog?.type === 'launcher') ui.closeDialog();
  };

  const runCommand = (command: DsulCommand, arg?: string) => {
    if (!isAvailable(command, ctx)) return;

    // Needs a value and doesn't have one yet — chip it and wait.
    if (command.argument && arg === undefined) {
      setActiveCommand(command);
      setMarks([]);
      setQuery('');
      inputRef.current?.focus();
      return;
    }

    command.run(ctx, arg);
    useCommandUsageStore.getState().record(command.id);
    closeAndClear();
    closeLauncher();
  };

  /**
   * Runs the chip's command on every marked id as ONE undo step (the argument's
   * `runMany` owns the batching). Usage is recorded once, not per item, so a
   * batch doesn't inflate the command's ranking. The picker closes even on a
   * throw: a partially applied selection left open invites a retry that would
   * toggle the already-done items straight back.
   */
  const runPicked = (ids: string[]) => {
    if (!activeCommand || argument?.kind !== 'entity' || !argument.runMany) return;
    const unique = [...new Set(ids)];
    if (unique.length === 0 || !isAvailable(activeCommand, ctx)) {
      setMarks([], 'Nothing selected can take this now');
      return;
    }
    let ok = false;
    try {
      argument.runMany(ctx, unique);
      ok = true;
    } finally {
      if (ok) useCommandUsageStore.getState().record(activeCommand.id);
      closeAndClear();
      closeLauncher();
    }
  };

  /** The cmdk-highlighted picker row's id, read off the DOM (cmdk's value is uncontrolled). */
  const highlightedArg = () =>
    containerRef.current
      ?.querySelector('[cmdk-item][data-selected="true"]')
      ?.getAttribute('data-arg') ?? null;

  const quickAdd = () => {
    if (!addTitle) {
      // Nothing has been filed yet — the dialog is where that decision still
      // gets made, so there is nothing for the relay to answer.
      openAddDialog('task');
      useCommandUsageStore.getState().record('create.task');
      closeAndClear();
      // openAddDialog replaced the launcher slot — nothing to close here.
      return;
    }
    addTask({ title: addTitle });
    // The launcher is a one-shot command surface: close after the add. The dock
    // stays open and refocuses for rapid successive capture. Nothing to strike
    // on the way out — `relayOnCapture` is false here by construction (the field
    // is dock-only), and a modal that unmounts on the add has no bar to light.
    if (isLauncher) {
      closeAndClear();
      closeLauncher();
      return;
    }
    // Dock, phone: the bar answers the add it just filed. Desktop leaves this
    // off and keeps the halo instead.
    if (relayOnCapture) {
      setFiled((n) => n + 1);
      setFiling(true);
      if (filingTimer.current) clearTimeout(filingTimer.current);
      filingTimer.current = setTimeout(() => setFiling(false), CAPTURE_SWELL_MS);
    }
    setQuery('');
    inputRef.current?.focus();
  };

  const askBeacon = () => {
    ctx.openChat();
    useCommandUsageStore.getState().record('rituals.chat');
    if (chatText) useChatStore.getState().send(chatText);
    closeAndClear();
    inputRef.current?.blur();
    // Chat opens in the sidebar (not a dialog), so the launcher is still active
    // — close it so the modal doesn't sit over the conversation.
    closeLauncher();
  };

  /* ── rendering ─────────────────────────────────────────────────────── */

  /**
   * Launcher only: a lime "↵ verb" pill previewing what Enter does on the
   * HIGHLIGHTED row. Hidden until the row is cmdk-selected (via group-data on the
   * CommandItem, which carries `group` + `data-selected`), so exactly one is ever
   * lit — the accent spent once, on the active row. Returns null in the dock,
   * which keeps its plain right-aligned key hints. The `ml-auto` right-aligns it;
   * where a row also has a CommandShortcut, the pill sits just left of it.
   * `leading-none` keeps it shorter than the row's 17px line: with the inherited
   * line-height it measured 21px and grew the highlighted row by 4px on hover.
   */
  const enterPill = (verb: string) =>
    isLauncher ? (
      <span
        aria-hidden
        data-testid="omnibar-enter-pill"
        className="ml-auto hidden items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] leading-none font-medium text-primary-foreground group-data-[selected=true]:inline-flex"
      >
        <CornerDownLeft className="size-3" />
        {verb}
      </span>
    ) : null;

  const renderCommandRow = (row: CommandRow) => {
    const Icon = row.arg?.icon ?? row.command.icon;
    const needsArgument = !!row.command.argument && !row.arg;

    // Right-hand hint: the key binding if there is one, otherwise the token you
    // can type to reach the row. The slash form is only truthful in command
    // mode, so the alias hint is confined to it.
    const keyHint =
      row.command.shortcut && !ctx.isMobile ? keyHints.get(row.command.shortcut.id) : undefined;
    const alias = (row.arg?.aliases ?? row.command.aliases)?.[0];
    const hint = keyHint ?? (isCommandMode && alias ? `/${alias}` : undefined);

    return (
      <CommandItem
        key={row.value}
        value={row.value}
        disabled={row.disabled}
        data-testid="omnibar-row"
        className="group"
        // The command id, not the row copy. Row labels collide with their own
        // group headings ('Settings' is both a command and a group), so text
        // matching resolves by scoring accident and becomes a strict-mode
        // violation the moment keywords change.
        data-command-id={row.command.id}
        data-arg={row.arg?.value ?? ''}
        onSelect={() => runCommand(row.command, row.arg?.value)}
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="truncate">
          {row.label}
          {needsArgument && <span className="text-muted-foreground">…</span>}
        </span>
        {enterPill('run')}
        {hint && (
          <CommandShortcut className={cn(!keyHint && 'font-mono tracking-normal')}>
            {hint}
          </CommandShortcut>
        )}
      </CommandItem>
    );
  };

  /**
   * Its own labelled section so a recent command never reads as one of the
   * fixed actions. Position differs by mode on purpose: at rest it sits BELOW
   * the actions, so Enter still means "add a task"; in /command mode it sits on
   * top, where it is the whole point and would otherwise be buried under
   * thirty rows nobody scrolls to.
   */
  const recentGroup =
    recentCommandRows.length > 0 ? (
      <CommandGroup heading={RECENT_HEADING}>
        {recentCommandRows.map(renderCommandRow)}
      </CommandGroup>
    ) : null;

  /**
   * An item row inside the picker. Deliberately shaped like the search results
   * further down — same glyphs, same strikethrough for done, same container
   * icon — so picking "which item" looks the same wherever you are doing it.
   */
  const renderEntityOption = (option: CommandEntityOption) => {
    const Icon = option.icon;
    const id = option.value;
    const checked = canMulti && livePicked.includes(id);
    return (
      <CommandItem
        key={id}
        value={`arg:${id}`}
        className="group"
        data-testid="omnibar-entity-row"
        // Addressable for the same reason renderCommandRow is: an entity row's
        // only other handle is its label, and item titles are user data. The
        // command id rides along so a picker row is unambiguous about which
        // command it would run.
        data-command-id={activeCommand?.id}
        data-arg={id}
        // Its own attribute: data-selected / aria-selected are cmdk's CURSOR, and
        // a mark has to read differently from the highlighted row.
        data-checked={checked || undefined}
        aria-checked={canMulti ? checked : undefined}
        // cmdk overwrites a caller's onClick, but not onClickCapture. No Shift
        // (it reads as a range) and no Ctrl on a Mac (that's the context menu).
        onClickCapture={(e) => {
          modClickRef.current = isMac ? e.metaKey : e.metaKey || e.ctrlKey;
        }}
        onMouseDown={(e) => {
          const mod = isMac ? e.metaKey : e.metaKey || e.ctrlKey;
          // Keep focus (and the phone's keyboard) in the input while toggling.
          if (canMulti && (mod || pickedCount > 0)) e.preventDefault();
        }}
        onSelect={() => {
          if (!activeCommand) return;
          const mod = modClickRef.current;
          modClickRef.current = false;
          // Once anything is marked, a plain click or tap toggles too — nothing
          // marked, and it runs on this one item exactly as it always has.
          if (canMulti && (mod || pickedCount > 0)) toggle(id);
          else runCommand(activeCommand, id);
        }}
      >
        {canMulti && (
          <span
            aria-hidden="true"
            data-testid="omnibar-entity-check"
            // The hit area is the row's full height and wider than the square;
            // 44pt on the phone, where it is the only way into a selection.
            className={cn(
              '-my-1.5 -ml-2 flex shrink-0 cursor-pointer items-center justify-center self-stretch',
              ctx.isMobile ? 'w-11' : 'w-8',
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              modClickRef.current = false;
              toggle(id);
            }}
          >
            {/* A square, so it never reads as the done glyph. Shown and hidden
                with visibility, never opacity — the checked fill is the lime
                accent, which must not fade (CLAUDE.md). */}
            <span
              className={cn(
                'flex size-4 items-center justify-center rounded-sm',
                checked
                  ? 'bg-primary text-primary-foreground'
                  : cn(
                      'border border-border',
                      ctx.isMobile || pickedCount > 0
                        ? 'visible'
                        : 'invisible group-hover:visible group-data-[selected=true]:visible',
                    ),
              )}
            >
              {checked && <Check className="size-3 text-primary-foreground" />}
            </span>
          </span>
        )}
        <Icon
          className={cn('h-4 w-4', option.done ? 'text-success' : 'text-muted-foreground/50')}
        />
        {option.container && (
          <CategoryIcon glyph={option.container.glyph} name={option.container.name} />
        )}
        <span
          className={cn(
            'truncate font-content text-content',
            option.done && 'text-muted-foreground line-through'
          )}
        >
          {option.label}
        </span>
        {option.detail && <CommandShortcut>{option.detail}</CommandShortcut>}
      </CommandItem>
    );
  };

  const renderArgOption = (option: CommandArgOption) => {
    const Icon = option.icon;
    return (
      <CommandItem
        key={option.value}
        value={`arg:${option.value}`}
        onSelect={() => activeCommand && runCommand(activeCommand, option.value)}
      >
        {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : <span className="w-4" />}
        <span className="truncate">{option.label}</span>
        {option.active && <CommandShortcut>current</CommandShortcut>}
      </CommandItem>
    );
  };

  return (
    <div ref={containerRef} className="relative" data-tour="omnibar" data-omnibar-variant={variant}>
      <Command
        shouldFilter={false}
        loop
        className={cn(
          // Launcher: ONE floating card. The input row and the results stack
          // inside it (Command is already flex-col; `order` puts the input on
          // top — see the input wrapper below). The card owns the border +
          // elevation, so its children carry no chrome of their own.
          // Dock: transparent; the pill and its floating panel are the surfaces.
          //
          // The radius/shadow use the bracket form on purpose: --radius-card is
          // an @theme token (so `rounded-card` mints), but the cmdk base Command
          // already carries `rounded-md`, and twMerge doesn't know `rounded-card`
          // is a radius — it would keep BOTH and let source order pick. The
          // arbitrary form IS recognised, so it drops the base rounded-md.
          // --shadow-elev-lg is declared OUTSIDE @theme, so `shadow-elev-lg`
          // mints nothing; the var form is how the rest of the app spends it.
          isLauncher
            ? 'h-auto overflow-hidden rounded-[var(--radius-card)] border border-border bg-popover shadow-[var(--shadow-elev-lg)]'
            : 'overflow-visible bg-transparent',
        )}
      >
        {/* Results panel. Dock: floats above the pill (absolute). Launcher: a
            flush section inside the card, below the input, divided by a hairline. */}
        {open && (
          <PanelShell isLauncher={isLauncher}>
            <CommandList
              data-testid="omnibar-panel"
              className={cn(
                'overflow-y-auto p-1',
                isLauncher ? 'order-2 max-h-[min(20rem,55vh)] border-t border-border' : 'max-h-80',
              )}
            >
              {/* Argument mode owns the whole panel — nothing else is relevant
                  while a command is waiting for its value. */}
              {activeCommand ? (
                <>
                  <CommandGroup heading={argument?.placeholder ?? 'Value'}>
                    {argument?.kind === 'text' ? (
                      <CommandItem
                        value="arg-submit"
                        disabled={!!argError || !query.trim()}
                        onSelect={() => runCommand(activeCommand, query.trim())}
                      >
                        <activeCommand.icon className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">
                          {argError ? (
                            <span className="text-destructive">{argError}</span>
                          ) : query.trim() ? (
                            <>
                              {resolveLabel(activeCommand, ctx)}{' '}
                              <span className="font-content">“{query.trim()}”</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">{argument.placeholder}</span>
                          )}
                        </span>
                      </CommandItem>
                    ) : argument?.kind === 'entity' ? (
                      entityOptions.length > 0 ? (
                        entityOptions.map(renderEntityOption)
                      ) : (
                        // The command's own copy, not "No match": the picker is
                        // pre-filtered to what this command can act on, so an empty
                        // list usually means nothing QUALIFIES, not that the query
                        // was wrong.
                        <div className="px-3 py-2 text-sm text-muted-foreground">
                          {argument.emptyLabel}
                        </div>
                      )
                    ) : argOptions.length > 0 ? (
                      argOptions.map(renderArgOption)
                    ) : (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No match</div>
                    )}
                  </CommandGroup>
                  {/* Marked rows the query now hides, so a mark never vanishes from
                      view. AFTER the results on purpose: cmdk highlights the first
                      item in DOM order on every search, and a marked row up top
                      would take the cursor — Tab would then unmark it. */}
                  {hiddenPicked.length > 0 && (
                    <CommandGroup heading="Also selected">
                      {hiddenPicked.map(renderEntityOption)}
                    </CommandGroup>
                  )}
                  {/* Dock, desktop: the one key worth teaching in the picker. The
                      launcher says it in its footer; the phone teaches by its
                      visible checkboxes and run bar instead. */}
                  {canMulti && !isLauncher && !ctx.isMobile && (
                    <div
                      data-testid="omnibar-multi-hint"
                      className="flex items-center gap-3 px-3 py-1.5 text-2xs text-muted-foreground/70"
                    >
                      {pickedCount > 0 ? `↵ run on ${pickedCount}` : '⇥ select several'}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {isChatMode && (
                    <CommandGroup heading="Chat">
                      <CommandItem value="action-chat" className="group" onSelect={askBeacon}>
                        <Sparkles className="h-4 w-4 text-ai" />
                        <span className="truncate">
                          Ask Beacon
                          {chatText ? (
                            <>
                              {' '}
                              <span className="font-content">“{chatText}”</span>
                            </>
                          ) : (
                            '…'
                          )}
                        </span>
                        {enterPill('ask')}
                      </CommandItem>
                    </CommandGroup>
                  )}

                  {/* Goals first: they are containers, so a hit here reframes
                      every item row beneath it. Four at most — this is a jump,
                      not a browse. */}
                  {goalHits.length > 0 && (
                    <CommandGroup heading="Goals">
                      {goalHits.map((goal) => (
                        <CommandItem
                          key={goal.id}
                          value={`goal-${goal.id}`}
                          data-testid="omnibar-goal-result"
                          className="group"
                          data-goal-id={goal.id}
                          onSelect={() => {
                            closeAndClear();
                            closeLauncher();
                            router.push(`/goal/${goal.id}`);
                          }}
                        >
                          <Target className="size-4 shrink-0" />
                          <span className="truncate">{goal.name}</span>
                          {enterPill('open')}
                          {goal.state !== 'active' && (
                            <span className="text-muted-foreground ml-auto text-[11px]">
                              {goal.state === 'achieved' ? 'Achieved' : 'Set aside'}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* One section per item type, in registry order. A custom type
                      gets its own heading and its own glyph instead of being
                      filed under Tasks because it rides the task pipeline. */}
                  {results.map((group) => (
                    <CommandGroup key={group.type} heading={group.heading}>
                      {group.items.map((item) => {
                        const Icon = itemIcon(item);
                        const container = itemContainer(item);
                        // Task-shaped only. A habit's completion is per-DATE
                        // (completedDates), not the scalar status, and these rows
                        // carry no date — so habits render undone, as before.
                        const done =
                          item.type !== 'habit' &&
                          item.status === getItemTypeConfig(group.type).doneStatus;
                        // Search deliberately keeps finding paused items — looking
                        // something up by name is explicit intent, and this is one
                        // of the few places a set-aside item can still be reached.
                        // It just says so, quietly.
                        const paused = !!suppressionReason(item, searchTodayStr, {
                          userTimezone: searchTz,
                          routines,
                          programs,
                        });
                        return (
                          <CommandItem
                            key={item.id}
                            value={`${group.type}-${item.id}`}
                            data-testid="omnibar-result"
                            className="group"
                            data-item-id={item.id}
                            data-item-type={group.type}
                            data-paused={paused || undefined}
                            onSelect={() => {
                              openEditFor(item, item.type === 'habit' ? 'habit' : 'task');
                              closeAndClear();
                            }}
                          >
                            <Icon
                              className={cn(
                                'h-4 w-4',
                                group.type === 'habit'
                                  ? 'text-warning'
                                  : done
                                    ? 'text-success'
                                    : 'text-muted-foreground/50'
                              )}
                            />
                            {container && (
                              <CategoryIcon glyph={container.glyph} name={container.name} />
                            )}
                            <span
                              className={cn(
                                'truncate font-content text-content',
                                done && 'text-muted-foreground line-through'
                              )}
                            >
                              {item.title}
                            </span>
                            {/* Short on purpose: the panel is ~320px and the
                                title truncates against it. */}
                            {enterPill('open')}
                            {paused && <CommandShortcut>Paused</CommandShortcut>}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}

                  {/* Recents on top when they're the point: /command mode, and
                      the launcher's resting root (command-first — Enter runs the
                      first recent rather than adding a task). */}
                  {(isCommandMode || isLauncher) && recentGroup}

                  {/* Grouped palette — /command mode on desktop */}
                  {grouped?.map((group) => (
                    <CommandGroup key={group.id} heading={group.heading}>
                      {group.rows.map(renderCommandRow)}
                    </CommandGroup>
                  ))}

                  {/* Flat list: mobile, or the free-text slice beside search.
                      Rendered before the recents so Enter at rest still lands on
                      Add task rather than on whatever you last ran. */}
                  {!grouped && !isChatMode && (
                    <CommandGroup heading={isCommandMode ? 'Commands' : 'Actions'}>
                      {!isCommandMode && (
                        <CommandItem value="action-add" data-testid="omnibar-add-row" className="group" onSelect={quickAdd}>
                          <Plus className="h-4 w-4 text-success-text" />
                          <span className="truncate">
                            Add task
                            {addTitle ? (
                              <>
                                {' '}
                                <span className="font-content">“{addTitle}”</span>
                              </>
                            ) : (
                              '…'
                            )}
                          </span>
                          {enterPill('add')}
                        </CommandItem>
                      )}
                      {commandRows.map(renderCommandRow)}
                      {!isCommandMode && !isAddMode && (
                        <CommandItem value="action-chat" className="group" onSelect={askBeacon}>
                          <Sparkles className="h-4 w-4 text-ai" />
                          <span className="truncate">
                            Ask Beacon
                            {chatText ? (
                              <>
                                {' '}
                                <span className="font-content">“{chatText}”</span>
                              </>
                            ) : (
                              '…'
                            )}
                          </span>
                          {enterPill('ask')}
                        </CommandItem>
                      )}
                      {isCommandMode && commandRows.length === 0 && (
                        <div className="px-3 py-2 text-sm text-muted-foreground">
                          No matching command
                        </div>
                      )}
                    </CommandGroup>
                  )}

                  {/* Dock rests capture-first: recents sit BELOW the Add/Ask rows
                      so Enter still adds a task. The launcher puts them on top
                      (above), so this branch is dock-only. */}
                  {!isCommandMode && !isLauncher && recentGroup}

                  {/* Dock-only: the launcher shows the same affordances in its
                      persistent footer bar below the panel (see the card footer). */}
                  {!isChatMode && !isCommandMode && !trimmed && !isLauncher && (
                    <div className="flex items-center gap-3 px-3 py-1.5 text-2xs text-muted-foreground/70">
                      <span className="flex items-center gap-1">
                        <Plus className="h-3 w-3" /> add
                      </span>
                      <span className="flex items-center gap-1">
                        <SlashSquare className="h-3 w-3" /> commands
                      </span>
                      <span className="flex items-center gap-1">
                        <Sparkles className="h-3 w-3" /> ? chat
                      </span>
                    </div>
                  )}
                </>
              )}
            </CommandList>
            {/* Run bar: OUTSIDE the list, because a button inside role="listbox"
                is invalid markup and cmdk's highlight could land on it. In the
                launcher it shares the footer's order-3 and sits above it by DOM
                order; in the dock it is the floating panel's bottom edge. */}
            {canMulti && pickedCount > 0 && activeCommand && (
              <div
                data-testid="omnibar-run-bar"
                className={cn(
                  'flex items-center justify-between gap-2 border-t border-border bg-popover px-3 py-2',
                  isLauncher && 'order-3',
                )}
              >
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {resolveLabel(activeCommand, ctx)} · {pickedCount} {pickedCount === 1 ? 'item' : 'items'}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="omnibar-clear-selection"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setMarks([], 'Selection cleared')}
                    className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    data-testid="omnibar-run-selection"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runPicked(livePicked)}
                    className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    {ctx.isMobile ? 'Run' : 'Run ↵'}
                  </button>
                </div>
              </div>
            )}
          </PanelShell>
        )}

        <div className={cn('relative isolate', isLauncher && 'order-1')}>
          {/* The pill halo is a DOCK affordance: it's a glow around a floating
              pill. In the launcher there is no pill — the card is the surface —
              so it's suppressed, and the card's own elevation does the lifting. */}
          {RELAY.omnibar && !inPillRelay && !isLauncher && (
            <RelayField
              className="absolute -inset-3 z-0"
              focalY={0.5}
              pitch={30}
              period={3.2}
              idleIntensity={0}
              activeIntensity={0.7}
              active={focused}
              mask="radial-gradient(closest-side, black, transparent)"
            />
          )}
          {/* DOCK — a raised pill that presses down into the dock on focus (a
              tactile "key pressed" feel): the drop shadow cross-fades to an inner
              one, the surface darkens a hair toward the well, and it nudges 1px
              lower. This is a dock idiom — the pill sits on a real surface (the
              grey well) to press into.

              LAUNCHER — the input is the flat top row of the card, floating on a
              scrim with nothing beneath it to press into. So it drops the keycap
              entirely: no shadow, no press, no rounded pill; the card is the
              surface, and focus is signalled by the caret and the selected row.

              The states live on this WRAPPER (not the input) because the input
              shares the pill with the argument chip, and they read off the same
              `focused` state the relay uses — NOT :focus-within, which sticks
              when a child unmounts. Two dock details that look minor and are not:
                • Tailwind v4 presses via the standalone `translate` property,
                  NOT `transform` — listing `transform` animates nothing.
                • The shadow uses the --shadow-key-* PAIR rather than
                  elev-sm → inset-sm. A box-shadow list whose layers disagree on
                  `inset` is uninterpolable and hard-swaps mid-transition; the
                  pair is padded so it actually cross-fades. See globals.css. */}
          <div
            // The row LOOKS like the text field, so all of it has to behave like
            // one. The input is a flex item ~20px tall inside a 48–54px row,
            // leaving dead bands above and below it plus the side padding; a
            // click there would otherwise focus nothing. The target check keeps
            // the chip button's own clicks intact — it only redirects hits that
            // landed on this wrapper itself.
            onMouseDown={(e) => {
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              inputRef.current?.focus();
            }}
            className={cn(
              'relative z-10 flex w-full items-center',
              isLauncher
                ? cn('h-[54px] gap-3 bg-transparent', activeCommand ? 'pl-3 pr-4' : 'px-4')
                : cn(
                    'h-[48px] gap-2 rounded-[10px] bg-surface-2',
                    activeCommand ? 'pl-2.5 pr-[22px]' : 'px-[22px]',
                    'translate-y-0 shadow-[var(--shadow-key-rest)]',
                    'transition-[box-shadow,translate,background-color] duration-150 ease-[var(--ease-out-soft)]',
                    // Hover, only while NOT focused (focus keeps its clean pressed
                    // look): a 1px inner hairline traces the pill on top of its
                    // raised rest shadow — parity with the braindump quick-add tray.
                    '[&:hover:not(:focus-within)]:shadow-[var(--shadow-key-rest),inset_0_0_0_1px_var(--border)]',
                    focused &&
                      'translate-y-px bg-[var(--surface-2-pressed)] shadow-[var(--shadow-key-pressed)]',
                    // Only where the field is actually mounted, so the desktop pill
                    // keeps the exact box it has always had. `isolate` is what lets a
                    // -z-10 child sit ABOVE this pill's own fill (it would otherwise
                    // fall through to the dock's stacking context and paint under it),
                    // and the clip is what keeps the ripple inside the radius.
                    relayOnCapture && 'isolate overflow-hidden',
                  ),
            )}
          >
            {/* Launcher only: a dark leading tile with a white glyph — the
                mockup's icon chip, in the input row. Decorative (aria-hidden);
                pointer-events-none lets a click fall through to the wrapper's
                focus handler. Hidden while an argument chip owns the lead slot. */}
            {isLauncher && !activeCommand && (
              <span
                aria-hidden
                data-testid="omnibar-launcher-tile"
                className="pointer-events-none flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--omni-tile)] text-[var(--omni-tile-ink)]"
              >
                <Search className="size-4" />
              </span>
            )}
            {/* The relay, struck by an item filing itself — the app's core verb,
                and the only thing this bar lights for. Rests at zero: between
                strikes the canvas paints nothing, because a bar that shimmers
                while you are reading it is the ambient motion the redesign set
                out to remove.

                `period` is short by the standards of the other five instances.
                A tile fires at 2.4 × period × its normalized distance, so the
                ambient 3.2s would take eight seconds to cross the bar and the
                wave would still be leaving the middle when the window shut. At
                0.5s the ring reaches the ends in ~1.2s, which is the gesture. */}
            {relayOnCapture && (
              <RelayField
                className="absolute inset-0 -z-10"
                focalY={0.5}
                pitch={20}
                period={0.5}
                idleIntensity={0}
                activeIntensity={0.55}
                activeIntensityLight={0.4}
                active={filing}
                burst={filed}
                burstDecay={1.1}
                mask="radial-gradient(70% 190% at 50% 50%, black 35%, transparent 100%)"
              />
            )}
            {activeCommand && (
              <button
                type="button"
                onClick={clearArgument}
                aria-label={
                  pickedCount > 0
                    ? `Cancel ${activeCommand.label}, ${pickedCount} selected`
                    : `Cancel ${activeCommand.label}`
                }
                // A real hit target, not just Escape: phones have no Escape key
                // and backspace-on-empty is not reliable under an IME.
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary/15 pl-2 pr-1.5 text-xs font-medium text-foreground"
              >
                <activeCommand.icon className="h-3.5 w-3.5" />
                {/* On a 320pt phone the column is 184px (see the placeholder's
                    width budget), so with marks up the label yields to the count
                    — the run bar already spells the command out in full. */}
                {!(ctx.isMobile && pickedCount > 0) && (
                  <span className="max-w-[140px] truncate">{resolveLabel(activeCommand, ctx)}</span>
                )}
                {pickedCount > 0 && (
                  <span className="shrink-0 tabular-nums" data-testid="omnibar-chip-count">
                    · {pickedCount}
                  </span>
                )}
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
            <CommandPrimitive.Input
              ref={inputRef}
              value={query}
              onValueChange={(value) => {
                setQuery(value);
                setOpen(true);
              }}
              onFocus={() => {
                setOpen(true);
                setFocused(true);
                onPulseRef.current?.();
              }}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                // Multiselect keys. All local to this input — none is a global
                // binding, so the frozen shortcut ids are untouched. preventDefault
                // is what keeps cmdk's own root handler out of it (its Enter has
                // no modifier check, so Shift/⌘+Enter would otherwise run one).
                if (canMulti && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  const mod = e.metaKey || e.ctrlKey;
                  if (e.key === 'Tab' && open && !mod && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    // Radix FocusScope (the launcher's Dialog) ignores
                    // defaultPrevented and would move focus to the chip or the
                    // run bar, so stop it reaching the dialog at all.
                    e.stopPropagation();
                    const id = highlightedArg();
                    if (id) toggle(id);
                    return;
                  }
                  if (e.key === 'Enter' && e.shiftKey && !mod && open) {
                    e.preventDefault();
                    const id = highlightedArg();
                    if (id) toggle(id);
                    return;
                  }
                  // With marks up, Enter runs exactly what the count says — the
                  // highlighted row is NOT added. ⌘Enter is the one that adds it.
                  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && pickedCount > 0) {
                    e.preventDefault();
                    const ids = mod ? [...livePicked, highlightedArg()] : livePicked;
                    runPicked(ids.filter((x): x is string => !!x));
                    return;
                  }
                  if (e.key === 'Backspace' && query === '') {
                    // A repeat never edits the marks or pops the chip: not after
                    // an unmark, and not when a held key has just emptied the
                    // query (that first repeat set no hold, the key was deleting).
                    if (e.repeat && (backspaceHoldRef.current || pickedCount > 0)) {
                      e.preventDefault();
                      return;
                    }
                    if (!e.repeat && pickedCount > 0) {
                      e.preventDefault();
                      backspaceHoldRef.current = true;
                      setMarks(livePicked.slice(0, -1), `${pickedCount - 1} selected`);
                      return;
                    }
                  }
                  // First Escape drops the marks and keeps the chip; the next
                  // one behaves as it always has.
                  if (e.key === 'Escape' && pickedCount > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    setMarks([], 'Selection cleared');
                    return;
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  // Consumed here, not left to bubble: an enclosing surface
                  // (a dialog, a future host) may have its own Escape handler,
                  // and dismissing search must not also dismiss that.
                  e.stopPropagation();
                  if (activeCommand) {
                    clearArgument();
                    return;
                  }
                  if (isLauncher) {
                    // Raycast-style staging: first Escape clears a typed query,
                    // the next closes the modal. This only works because the
                    // launcher host (omni-launcher.tsx) preventDefaults Radix's
                    // capture-phase Escape — otherwise DismissableLayer would
                    // dismiss on the first press before this bubble-phase handler
                    // ran. We do the closing ourselves via closeLauncher().
                    if (query) {
                      setQuery('');
                      return;
                    }
                    closeLauncher();
                    return;
                  }
                  closeAndClear();
                  inputRef.current?.blur();
                  return;
                }
                // Backspace on an empty value pops the chip, the way a token in
                // a mail "To:" field does.
                if (e.key === 'Backspace' && activeCommand && query === '') {
                  e.preventDefault();
                  clearArgument();
                  return;
                }
                // Not while a chip is pending — ⌘Enter there would abandon the
                // command and send the half-typed argument as a chat message.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !activeCommand) {
                  e.preventDefault();
                  askBeacon();
                  return;
                }
                // Submit a text argument explicitly rather than relying on cmdk
                // having re-selected the row the moment validation flipped it
                // from disabled to enabled.
                if (e.key === 'Enter' && activeCommand && argument?.kind === 'text') {
                  e.preventDefault();
                  const value = query.trim();
                  if (value && !argument.validate?.(value)) runCommand(activeCommand, value);
                  return;
                }
                if (e.key === 'Enter' && isAddMode) {
                  e.preventDefault();
                  quickAdd();
                }
              }}
              // Releasing Backspace ends a hold: see backspaceHoldRef.
              onKeyUp={(e) => {
                if (e.key === 'Backspace') backspaceHoldRef.current = false;
              }}
              // A multi-line paste can't be a search and can't be typed into a
              // single-line input without folding — treat it as a list and hand
              // it to the bulk-add dialog. Chat mode keeps native paste (a
              // pasted paragraph is a legitimate question for Beacon), and so
              // does a pending command chip (its argument is a value, not a
              // list). The typed query survives, as the braindump's draft
              // does: the paste is what's being promoted, not the draft.
              onPaste={(e) => {
                if (isChatMode || activeCommand) return;
                const pasted = e.clipboardData.getData('text/plain');
                if (isBulkPaste(pasted)) {
                  e.preventDefault();
                  openBulkAdd({ text: pasted });
                  setOpen(false);
                  inputRef.current?.blur();
                }
              }}
              placeholder={
                activeCommand
                  ? (activeCommand.argument?.placeholder ?? '')
                  : isLauncher
                    ? 'Search, add a task, run a command, or ask Beacon…'
                    : // Dock leans capture: LEAD with the everyday action, then
                      // name enough of the rest that the bar does not read as a
                      // single-purpose add field. It used to say only "Add a
                      // task…", which undersold three of the four modes at the
                      // one moment the bar is being looked at and not used.
                      //
                      // Deliberately NOT the launcher's line above. The split is
                      // the point: the launcher opens as a command surface and so
                      // leads with search and spells out "run a command"; the dock
                      // rests as a capture bar and only widens from there. Commands
                      // are the omission that pays for the width — they are the
                      // launcher's headline, they live under ⌘K, and the hint row
                      // below still advertises the + / command / ? prefixes the
                      // moment this bar is focused.
                      //
                      // Width is the other constraint. Measure with the app's OWN
                      // ramp, not Tailwind's: this input is `text-sm`, and
                      // app/globals.css redefines --text-sm to 12px (not 16, not
                      // 14). At 12px Inter this string is ~162px.
                      //
                      // Desktop: SIDEBAR_MIN_WIDTH is 280px, less the dock's
                      // px-[10px] well and the pill's px-[22px] = 216px of text
                      // column. Phone: the row pays px-[10px] outside, p-[10px]
                      // inside, the 44px mode card and its gap-2, then the pill's
                      // own px-[22px] — viewport − 136, so 254px on a 390pt phone
                      // and 184px at 320pt. 320pt is the tightest case and still
                      // leaves ~22px. Fits everywhere without a fallback. A
                      // longer line does not break the layout (a placeholder clips
                      // rather than overflows) but it does get truncated mid-word,
                      // which is worse copy than a shorter honest one. Measure
                      // before lengthening.
                      'Add a task, search, or chat…'
              }
              // The phone keyboard's return key reads "go" while marks are up,
              // since it runs the selection rather than picking a row.
              enterKeyHint={pickedCount > 0 ? 'go' : undefined}
              aria-label="Omnibar"
              // cmdk gives this input role="combobox", and Playwright's
              // getByLabel does not resolve aria-label on it (verified: 0
              // matches while [aria-label="Omnibar"] matches 1). A testid is
              // the one handle that cannot silently stop matching.
              data-testid="omnibar-input"
              // Identifiers typed as an argument (a project name is the key
              // every task references) must not be autocapitalised, and neither
              // should an item title you are searching for.
              //
              // Only autoCapitalize is set here: cmdk's Input spreads its own
              // autoComplete/autoCorrect/spellCheck AFTER the caller's props,
              // so passing those would look like it worked and do nothing.
              // cmdk already pins autoCorrect and spellCheck off for us.
              autoCapitalize={argument && argument.kind !== 'enum' ? 'off' : 'sentences'}
              // self-stretch, not the flex row's default centring: it makes the
              // input as tall as the pill so a click anywhere down its column
              // lands in the text and places the caret, rather than hitting the
              // wrapper. An input centres its own text, so this costs nothing
              // visually. See the wrapper's onMouseDown for the side padding.
              className="-mx-1 min-w-0 flex-1 self-stretch bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
        </div>
        {/* Launcher footer: a persistent hint bar pinned to the card bottom
            (order-3, so it sits BELOW the order-2 panel and outside its scroll).
            The left mirrors the dock's in-panel prefix hint; the right spells out
            the Enter / Beacon / Escape keys. Dock renders no footer — its hint
            lives inside the panel. */}
        {isLauncher && (
          <div
            data-testid="omnibar-launcher-footer"
            className="order-3 flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-2xs text-muted-foreground/70"
          >
            {activeCommand ? (
              // Chip state: the prefixes are suspended and ⌘↵ no longer asks
              // Beacon, so the resting copy would be wrong on both sides.
              <div
                data-testid="omnibar-picker-hint"
                className="flex min-w-0 items-center gap-2 truncate font-mono tracking-normal"
              >
                {(canMulti && pickedCount > 0
                  ? [
                      `↵ run on ${pickedCount}`,
                      `${isMac ? '⌘' : 'Ctrl'}↵ include highlighted`,
                      '⇥ toggle',
                      '⌫ unselect',
                      'esc clear',
                    ]
                  : canMulti
                    ? ['↵ pick', '⇥ select several', 'esc back']
                    : ['↵ pick', 'esc back']
                ).map((hint, i) => (
                  <span key={hint} className="flex items-center gap-2 whitespace-nowrap">
                    {i > 0 && <span aria-hidden>·</span>}
                    {hint}
                  </span>
                ))}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Plus className="h-3 w-3" /> add
                  </span>
                  <span className="flex items-center gap-1">
                    <SlashSquare className="h-3 w-3" /> commands
                  </span>
                  <span className="flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> chat
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono tracking-normal">
                  <span>↵ open</span>
                  <span aria-hidden>·</span>
                  <span>{isMac ? '⌘' : 'Ctrl'}↵ Beacon</span>
                  <span aria-hidden>·</span>
                  <span>esc</span>
                </div>
              </>
            )}
          </div>
        )}
      </Command>
      {/* Outside the listbox, so it is never read as one of the options. */}
      <div className="sr-only" aria-live="polite" data-testid="omnibar-live">
        {announce || (pickedCount > 0 ? `${pickedCount} selected` : '')}
      </div>
    </div>
  );
}
