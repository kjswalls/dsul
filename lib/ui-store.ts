import { create } from 'zustand';
import type { Task, HabitItem, Item, KnownItemType, TimeBucket } from './planner-types';

/**
 * Ephemeral UI state for the desktop shell: which dialog is open, the shared
 * confirm prompt, and omnibar focus requests. Never persisted.
 *
 * Replaces the pile of useState hooks that lived in app/page.tsx.
 */

export type ActiveDialog =
  /** `tab` is the registry type name ('task', 'habit', or a custom slug). */
  | { type: 'add'; tab: string; bucket?: TimeBucket; date?: Date; title?: string }
  | { type: 'edit-item'; item: Item }
  /**
   * The "new" dialog, making an ORGANIZER rather than an item (2026-09-25).
   *
   * Its own slot, not a `kind` on `add`: everything downstream of `add.tab` —
   * the per-type drafts, getItemTypeConfig, the chip field, the save adapters —
   * is item-shaped, and getItemTypeConfig('goal') would quietly synthesize a
   * custom type. ContainerDialog (components/planner/container-dialog.tsx)
   * renders it in the same shell. `title`/`notes` carry what was typed when
   * the type menu switched over; `notes` becomes a goal's why.
   */
  | {
      type: 'new-container';
      kind: NewContainerKind;
      title?: string;
      notes?: string;
    }
  /**
   * The Organize console — one surface for every container and label. Replaced
   * `manage-categories` and `manage-collections`, which are gone rather than
   * kept as aliases: two variants pointing at one component is how a caller
   * ends up opening the right dialog on the wrong section for a year.
   *
   * `section` is a bare string because it arrives from the palette, the settings
   * manifest and `ActiveDialog` alike; the console validates it and falls back
   * to routines, so a stale value lands somewhere real instead of on an empty
   * plate. See components/planner/organize/console-rail.tsx for the vocabulary.
   */
  | {
      type: 'organize';
      /** 'routines' | 'programs' | 'projects' | 'types' | 'groups' | 'trash'. */
      section?: string;
      /** Select this object on arrival. */
      focusId?: string;
      /** Put the cursor in the create row — the "New routine or program" entry. */
      focusNew?: boolean;
    }
  // Settings is a route (/settings), not a dialog — see
  // app/settings/[[...pane]]/page.tsx. Removed rather than left as a dead
  // variant so nothing can dispatch to a surface no longer mounted anywhere.
  | { type: 'keyboard-shortcuts' }
  | { type: 'bug-report' }
  /**
   * The bulk-add dialog — paste a list (or import a file), get one item per
   * line. `text` seeds its textarea (the raw paste, re-parsed there so the
   * user sees and can edit the split before anything is created). The rest
   * carries context from the surface that handed off: the item dialog's
   * type/project/date must survive the hop or the hand-off silently drops
   * choices the user already made.
   */
  | {
      type: 'bulk-add';
      text?: string;
      /** 'task' or a custom slug — never 'habit'. */
      itemType?: string;
      project?: string;
      /** yyyy-MM-dd */
      date?: string;
      bucket?: TimeBucket;
    }
  /**
   * The ⌘K launcher: the summoned command + search modal. It renders the same
   * <Omnibar> the sidebar dock does, in variant="launcher" — one core, two
   * shells. `query` seeds the input so a caller can open it pre-scoped (the `/`
   * binding opens it already in command mode).
   */
  | { type: 'launcher'; query?: string };

/** The organizers the "new" dialog can make. Item types are console-only. */
export type NewContainerKind = 'goal' | 'routine' | 'program' | 'project';

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  /**
   * Overrides the action button's `data-testid`, for the handful of confirms a
   * spec has to name individually. There is ONE AlertDialog in the app, so
   * without this every prompt answers to `confirm-dialog-confirm` and a test
   * that means "the attach warning" would happily click a delete.
   */
  testId?: string;
  onConfirm: () => void;
}

interface UIStore {
  activeDialog: ActiveDialog | null;
  openDialog: (dialog: ActiveDialog) => void;
  closeDialog: () => void;

  /** Shared AlertDialog rendered once in the shell. */
  confirmRequest: ConfirmRequest | null;
  confirm: (request: ConfirmRequest) => void;
  resolveConfirm: (confirmed: boolean) => void;

  /**
   * Beacon's first-run Q&A (components/ai/onboarding-chat.tsx) is on screen.
   *
   * It lives here rather than in ChatConversation's own state because the
   * phone's chat input is no longer inside the conversation — it is the dock's
   * bar (components/mobile/mobile-bottom-dock.tsx) — while the onboarding chat
   * brings a field of its own. Two components that must agree on which field is
   * the real one cannot each hold their own answer. AppShell seeds it from the
   * completion check it already runs for the tour, so it is settled before the
   * tour's step 4 (or a swipe) can reach the Beacon tab.
   */
  chatOnboardingActive: boolean;
  setChatOnboardingActive: (active: boolean) => void;

  /** Bumping the token tells the omnibar to grab focus (⌘K etc.). */
  omnibarFocusToken: number;
  focusOmnibar: () => void;

  /** Same trick for the docked item panel. It deliberately doesn't steal focus
   *  when it opens — it retargets on every row you click — so this is the only
   *  way to reach it from the keyboard without tabbing the whole grid. */
  itemPanelFocusToken: number;
  focusItemPanel: () => void;
}

export const useUIStore = create<UIStore>()((set, get) => ({
  activeDialog: null,
  openDialog: (dialog) => set({ activeDialog: dialog }),
  closeDialog: () => set({ activeDialog: null }),

  confirmRequest: null,
  confirm: (request) => set({ confirmRequest: request }),
  resolveConfirm: (confirmed) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (confirmed) request?.onConfirm();
  },

  chatOnboardingActive: false,
  setChatOnboardingActive: (active) => set({ chatOnboardingActive: active }),

  omnibarFocusToken: 0,
  focusOmnibar: () => set((s) => ({ omnibarFocusToken: s.omnibarFocusToken + 1 })),

  itemPanelFocusToken: 0,
  focusItemPanel: () => set((s) => ({ itemPanelFocusToken: s.itemPanelFocusToken + 1 })),
}));

/* Convenience helpers for common dialogs */
export const openAddDialog = (
  tab: string = 'task',
  bucket?: TimeBucket,
  date?: Date,
  title?: string
) => useUIStore.getState().openDialog({ type: 'add', tab, bucket, date, title });

/** Open the "new" dialog on an organizer, carrying what was already typed. */
export const openNewContainer = (kind: NewContainerKind, title?: string, notes?: string) =>
  useUIStore.getState().openDialog({ type: 'new-container', kind, title, notes });

/** Open the bulk-add dialog, optionally seeded with pasted text and hand-off
 *  context (see the ActiveDialog variant for field meanings). */
export const openBulkAdd = (
  seed: Omit<Extract<ActiveDialog, { type: 'bulk-add' }>, 'type'> = {}
) => useUIStore.getState().openDialog({ type: 'bulk-add', ...seed });

/**
 * Callers hold legacy Task/Habit projections (no `type` at the type level), so
 * the discriminator is stamped here. What lands in the slot is a snapshot, but
 * it is only an ADDRESS now: the surface re-resolves it from the store by id
 * every render and re-seeds its draft only when that id changes. Calling this
 * again with a different item is therefore how the docked panel retargets.
 *
 * Custom-type items ride the tasks projection (Phase 6b), so their runtime
 * discriminator must survive: stamping 'task' over a {type:'custom'} object
 * would open it with the wrong config and labels.
 *
 * BOTH branches spread: every open must put a FRESH object in the slot, even
 * for the same item. DesktopShell's narrowed selector and ItemDialog's
 * confirm-disarm latch both key on payload identity, so a by-reference
 * pass-through would make re-opening the same custom item invisible to them.
 */
export const openEditFor = (item: Task | HabitItem, itemType: KnownItemType) => {
  const runtime = item as { type?: string };
  const stamped =
    runtime.type === 'custom'
      ? ({ ...item } as unknown as Item)
      : ({ ...item, type: itemType } as Item);
  useUIStore.getState().openDialog({ type: 'edit-item', item: stamped });
};
