import { create } from 'zustand';
import type { Task, HabitItem, Item, KnownItemType, TimeBucket } from './planner-types';
import { isPlannerPreviewing } from './planner-ready';

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
      /**
       * Items the new organizer starts with — "New routine…" in an item's
       * right-click menu opens this with that item (or the selection) inside.
       */
      itemIds?: string[];
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
      /** 'routines' | 'seasons' | 'projects' | 'types' | 'groups' | 'trash'. */
      section?: string;
      /** Select this object on arrival. */
      focusId?: string;
      /** Put the cursor in the create row — the "New routine or season" entry. */
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
export type NewContainerKind = 'goal' | 'routine' | 'season' | 'project';

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
  /**
   * Where focus goes when the confirm closes and the control that opened it
   * is gone (a confirmed delete took it). Run by ConfirmDialog at the real
   * close, after the exit animation, which is the first moment focus is
   * actually lost: anything run on a timer from `onConfirm` finds it still on
   * the closing dialog's button. Without it, focus falls to <body>.
   */
  fallbackFocus?: () => void;
}

interface UIStore {
  activeDialog: ActiveDialog | null;
  /**
   * A data slot (PREVIEW_DEFERRED_SLOTS) asked for while the planner was the
   * look-only preview. Held here instead of opened, last request wins, and
   * opened by useDeferredDialogPromotion (hooks/use-deferred-dialog.ts) once
   * fresh data lands. Never rendered from.
   */
  deferredDialog: ActiveDialog | null;
  /**
   * While previewing, a data slot is deferred rather than opened. Any other
   * slot opens as usual; a data slot opened on real data drops the deferral.
   */
  openDialog: (dialog: ActiveDialog) => void;
  /** Leaves `deferredDialog` alone: the launcher closes itself right after running "Open Organize". */
  closeDialog: () => void;
  /**
   * The item the ⌘K launcher replaced when it opened over the docked item
   * panel, or null. The launcher takes the one slot, so the item closes as it
   * always has; this keeps only its id, so a `?` asked from that launcher can
   * still come back to it ("‹ <item>", lib/open-chat.ts askFromCommandBar).
   * Cleared by the next openDialog or closeDialog. Nothing else reads it.
   */
  displacedItemId: string | null;
  /**
   * True while the open dialog arrived by the "new" surface's type menu
   * swapping `add` ↔ `new-container`. Those are two slots and two Radix
   * dialogs, so the swap is a close plus an open; this flag lets the outgoing
   * one unmount at once and the incoming one skip its enter animation, so the
   * swap reads as the one dialog changing body rather than a re-open.
   */
  dialogHandoff: boolean;

  /** Shared AlertDialog rendered once in the shell. */
  confirmRequest: ConfirmRequest | null;
  /** Refused while previewing on `/`, where every confirm guards a data action. */
  confirm: (request: ConfirmRequest) => void;
  resolveConfirm: (confirmed: boolean) => void;

  /**
   * INERT. The flag for the retired scripted first-run chat Q&A (its component,
   * components/ai/onboarding-chat.tsx, is gone, and AppShell no longer raises
   * this). The plumbing stays so the sign-out reset and the onboarding-watch
   * contract keep compiling and keep their tests; nothing reads it to decide
   * what renders. Raise it again only with a surface that honours it.
   */
  chatOnboardingActive: boolean;
  /**
   * The account the (inert) flag was raised FOR, or null. A "done" answer may
   * only lower another account's flag; see applyChatOnboardingAnswer.
   */
  chatOnboardingUserId: string | null;
  /** Raising takes the owner; lowering always clears it. */
  setChatOnboardingActive: (active: boolean, userId?: string | null) => void;
  /**
   * Applies one onboarding answer for `userId` (lib/onboarding-watch.ts):
   * "needed" raises the flag for that account; "done" lowers it only when it
   * is held by a different account (or by nobody — a no-op then).
   */
  applyChatOnboardingAnswer: (userId: string, needed: boolean) => void;

  /** Bumping the token tells the omnibar to grab focus (⌘K etc.). */
  omnibarFocusToken: number;
  focusOmnibar: () => void;

  /** Same trick for the docked item panel. It deliberately doesn't steal focus
   *  when it opens — it retargets on every row you click — so this is the only
   *  way to reach it from the keyboard without tabbing the whole grid. */
  itemPanelFocusToken: number;
  focusItemPanel: () => void;
}

const NEW_SURFACE_SLOTS: ReadonlySet<ActiveDialog['type']> = new Set(['add', 'new-container']);

/**
 * The slots that seed from, or write to, planner rows. Opened over the
 * look-only preview, the autosaving docked panel and the modal's save would
 * seed from cached rows and write the result after landing; so while
 * previewing they are deferred instead (lib/planner-ready.ts).
 */
export const PREVIEW_DEFERRED_SLOTS: ReadonlySet<ActiveDialog['type']> = new Set([
  'add',
  'edit-item',
  'new-container',
  'bulk-add',
  'organize',
]);

export const isDataDialog = (dialog: ActiveDialog | null | undefined): boolean =>
  !!dialog && PREVIEW_DEFERRED_SLOTS.has(dialog.type);

/**
 * A data slot is open or waiting to open. The preview is not offered then:
 * /settings arms Organize and pushes '/', and that console must open on fresh
 * data, as it does today.
 */
export const isDataDialogArmed = (): boolean => {
  const { activeDialog, deferredDialog } = useUIStore.getState();
  return isDataDialog(activeDialog) || deferredDialog !== null;
};

const onPlannerRoute = (): boolean =>
  typeof window !== 'undefined' && window.location.pathname === '/';

/** An item's "new" ↔ an organizer's "new": one surface, two slots. */
function isNewSurfaceSwap(prev: ActiveDialog | null, next: ActiveDialog): boolean {
  return (
    prev !== null &&
    prev.type !== next.type &&
    NEW_SURFACE_SLOTS.has(prev.type) &&
    NEW_SURFACE_SLOTS.has(next.type)
  );
}

export const useUIStore = create<UIStore>()((set, get) => ({
  activeDialog: null,
  deferredDialog: null,
  openDialog: (dialog) => {
    const data = isDataDialog(dialog);
    if (data && isPlannerPreviewing()) {
      set({ deferredDialog: dialog });
      return;
    }
    const { activeDialog: prev, displacedItemId } = get();
    let displaced: string | null = null;
    if (dialog.type === 'launcher') {
      // A launcher re-opened over itself (⌘K pressed inside it) is still the
      // one that replaced the item.
      if (prev?.type === 'edit-item') displaced = prev.item.id;
      else if (prev?.type === 'launcher') displaced = displacedItemId;
    }
    set({
      activeDialog: dialog,
      displacedItemId: displaced,
      dialogHandoff: isNewSurfaceSwap(prev, dialog),
      // A data slot opened on real data supersedes whatever was waiting.
      ...(data ? { deferredDialog: null } : {}),
    });
  },
  closeDialog: () => set({ activeDialog: null, displacedItemId: null, dialogHandoff: false }),
  displacedItemId: null,
  dialogHandoff: false,

  confirmRequest: null,
  confirm: (request) => {
    // Decided on cached rows, a confirm accepted after landing would act on
    // them. The planner's route only: the preview outlives a client navigation,
    // and /settings's one confirm (disconnecting the model) touches no row.
    if (isPlannerPreviewing() && onPlannerRoute()) return;
    set({ confirmRequest: request });
  },
  resolveConfirm: (confirmed) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (confirmed) request?.onConfirm();
  },

  chatOnboardingActive: false,
  chatOnboardingUserId: null,
  setChatOnboardingActive: (active, userId = null) =>
    set({ chatOnboardingActive: active, chatOnboardingUserId: active ? userId : null }),
  applyChatOnboardingAnswer: (userId, needed) => {
    if (needed) {
      set({ chatOnboardingActive: true, chatOnboardingUserId: userId });
    } else if (get().chatOnboardingUserId !== userId) {
      set({ chatOnboardingActive: false, chatOnboardingUserId: null });
    }
  },

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

/**
 * The desktop app's quick capture (its global shortcut and the tray's New
 * task): the launcher, already in add mode. `+` is the add prefix, seeded the
 * way the `/` binding seeds command mode.
 *
 * A launcher that is already open is closed and opened again on the next task
 * rather than re-seeded in place. Done in one tick, the close and the open batch
 * into a single render in which the launcher never stops being open, so
 * OmniLauncher keeps the same <Omnibar> mounted, and the omnibar reads its seed
 * only once, into useState. The second press would then leave whatever was
 * typed on screen. A timeout lets the close commit first, which unmounts the
 * omnibar, so the reopen mounts a fresh one that reads `+`.
 *
 * The docked item panel counts as an empty slot. It is `edit-item` in the same
 * slot, open whenever a row was last clicked, so it is where a press usually
 * finds the planner; ⌘K replaces it too, and the panel flushes a queued
 * autosave as it unmounts (components/planner/item-dialog.tsx).
 *
 * Any other dialog is left alone: there is one slot, and taking it would throw
 * away whatever that dialog was holding. So is an open confirm, which has its
 * own slot: the launcher would stack over a destructive prompt the user may not
 * have seen from the other app, and hand focus back into it on close. The
 * window is already in front, so the press still shows the user where they are.
 */
export const openQuickCapture = () => {
  const { activeDialog, confirmRequest, openDialog, closeDialog } = useUIStore.getState();
  if (confirmRequest) return;
  const seed: ActiveDialog = { type: 'launcher', query: '+' };
  if (activeDialog === null || activeDialog.type === 'edit-item') {
    openDialog(seed);
    return;
  }
  if (activeDialog.type !== 'launcher') return;
  closeDialog();
  setTimeout(() => {
    // Only into an empty slot, with no confirm up: if something claimed either
    // in between, it wins, for the same reasons as above.
    const now = useUIStore.getState();
    if (now.activeDialog === null && !now.confirmRequest) now.openDialog(seed);
  }, 0);
};

/** Open the "new" dialog on an organizer, carrying what was already typed. */
export const openNewContainer = (
  kind: NewContainerKind,
  title?: string,
  notes?: string,
  itemIds?: string[]
) => useUIStore.getState().openDialog({ type: 'new-container', kind, title, notes, itemIds });

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
 *
 * The interceptor (below) is asked first: an item opened while the phone's
 * Ask tab is showing is pushed over Ask instead of opening the drawer.
 */
export const openEditFor = (item: Task | HabitItem, itemType: KnownItemType) => {
  const runtime = item as { type?: string };
  const stamped =
    runtime.type === 'custom'
      ? ({ ...item } as unknown as Item)
      : ({ ...item, type: itemType } as Item);
  openStampedEdit(stamped);
};

/**
 * The open after openEditFor's stamp: the interceptor, then the slot. Also
 * how a deferred `edit-item` is promoted (hooks/use-deferred-dialog.ts), so a
 * promoted item still pushes over the phone's Ask tab.
 *
 * Not the interceptor while the planner is the look-only preview: the item
 * Ask pushes autosaves from the row it is handed (components/mobile/ask-tab.tsx
 * PhoneItemView), which would be a cached one. The slot defers the open
 * instead, and promotion comes back here with the fresh row.
 */
export function openStampedEdit(item: Item): void {
  if (!isPlannerPreviewing() && editItemInterceptor?.(item)) return;
  useUIStore.getState().openDialog({ type: 'edit-item', item });
}

/**
 * Asked by every `openEditFor` before the slot: true means the open was taken
 * elsewhere and the slot stays as it is. lib/rail-store.ts installs the one
 * there is, which pushes the item over the phone's Ask tab while that tab is
 * mounted (so Today and Braindump keep the drawer). A module slot with a
 * setter, as the item panel's flush and close are below, so this store
 * imports nothing to learn about Ask.
 */
let editItemInterceptor: ((item: Item) => boolean) | null = null;

export function setEditItemInterceptor(fn: ((item: Item) => boolean) | null): void {
  editItemInterceptor = fn;
}

// ── Closing the item from outside it ─────────────────────────────────────────
//
// Every item close goes through the shell's own close (DesktopShell's
// handlePanelOpenChange: closeDialog, plus letting go of the one-row selection
// a plain row click made), and ItemDialog's exits (Back, ✕, Done, Escape,
// click-away) already do. A close from OUTSIDE the panel (Ctrl+J, `?` in the
// command bar, "Pick things back up") must not be a bare closeDialog(): that
// leaves the row's wash latched with nothing open, and leaves a title typed a
// moment ago to the panel's unmount grace instead of saving it now.
//
// Both halves register themselves, so this store imports neither: the open
// panel registers its synchronous flush, and DesktopShell its close. Each
// register returns its own unregister, which clears the slot only if it still
// holds that function (a StrictMode double effect, or a retarget that mounts
// the next panel before the last one's cleanup, cannot clear the newer one).

let itemPanelFlush: (() => void) | null = null;
let itemPanelClose: (() => void) | null = null;

/** The open panel's flush (ItemDialog): saves a pending edit synchronously. */
export function registerItemPanelFlush(fn: () => void): () => void {
  itemPanelFlush = fn;
  return () => {
    if (itemPanelFlush === fn) itemPanelFlush = null;
  };
}

/** The shell's close for the docked panel (DesktopShell's handlePanelOpenChange(false)). */
export function registerItemPanelClose(fn: () => void): () => void {
  itemPanelClose = fn;
  return () => {
    if (itemPanelClose === fn) itemPanelClose = null;
  };
}

/**
 * Close the open item from outside it: flush first (synchronously, so a
 * caller that reads the planner next, such as the catch-up proposal, sees the
 * edit), then the shell's close; with no shell registered (Zen, the phone),
 * closeDialog. A no-op when no item is open.
 */
export function closeItemPanel(): void {
  if (useUIStore.getState().activeDialog?.type !== 'edit-item') return;
  itemPanelFlush?.();
  if (itemPanelClose) itemPanelClose();
  else useUIStore.getState().closeDialog();
}
