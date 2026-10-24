'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, LayoutGrid, Plus, Search, Sun } from 'lucide-react';
import { AskMarkIcon, AskMarkUnlitIcon } from '@/components/ai/ask-mark';
import { AnswererLabel, BoundComposer } from '@/components/ai/bound-composer';
import { ProposalCard } from '@/components/ai/proposal-card';
import { useNeedsYouCount } from '@/components/ai/needs-you/needs-you-badge';
import { Omnibar } from '@/components/sidebar/omnibar';
import { DockNoticesMobile } from '@/components/sidebar/dock-notices';
import { UndoStrip } from '@/components/notices/undo-strip';
import { useToastAnchor } from '@/hooks/use-toast-anchor';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { inactiveItemIdsOn } from '@/lib/active';
import { useAwayStore } from '@/lib/away-store';
import { braindumpMembers } from '@/lib/braindump-members';
import { useOpenConsole } from '@/lib/console-door';
import { useOrganizeEnabled } from '@/lib/extension-gates';
import {
  chatOffered,
  setupPageShown,
  shownMobileTab,
  useMobileNavStore,
} from '@/lib/mobile-nav-store';
import {
  revealChat,
  useChatCardHomeShown,
  useChatCardSurface,
  useChatHostCard,
  usePhoneComposerBinding,
} from '@/lib/open-chat';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { phoneArrivalFocuses, useRailStore } from '@/lib/rail-store';
import { toDateStr } from '@/lib/recurrence';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { useUIStore } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

/** The raised paper the dock's capsules sit on: the iPhone's floating chrome. */
const RAISED =
  'bg-[var(--paper-3)] shadow-[0_1px_2px_rgb(0_0_0/6%),0_4px_14px_rgb(0_0_0/7%)] dark:shadow-[0_1px_2px_rgb(0_0_0/40%),0_6px_18px_rgb(0_0_0/35%)]';

/** Copy shown when Organize is switched off; the key stays, inert, and says so. */
const ORGANIZE_OFF = 'Organize is off. Switch it on in Settings → Extensions';

/**
 * Mobile bottom dock: the iPhone app's chrome at phone-web width (mobile web
 * round 3, memory/handoffs/mobile-web.md, picked 2026-10-13). Two rows on the
 * paper, no well:
 *
 *   1. The capture bar: the dock's omnibar drawn as the iPhone's capsule, a
 *      lime + in front ("Get it out of your head") and the braindump count
 *      after it, which opens the braindump sheet over Today. On the Ask tab
 *      the bar is Ask's composer instead, with who answers under it.
 *   2. The tab pill (Today · Ask · Organize) and the Search circle, which
 *      opens the ⌘K launcher.
 *
 * Scrolling Today's view folds the two rows into one (`dockMinimized`, set by
 * the shell): a lime circle for the tab you are on, which unfolds the dock,
 * the capture bar as "Capture", and Search. Ask never folds; its composer is
 * the bar. The omnibar keeps one place in the tree across both states, so a
 * fold never drops what is typed in it.
 *
 * The app's notice strip, the undo strip and the catch-up card stay above
 * the capture bar on every tab, the one address they had in the old dock.
 * NOT overflow-hidden: the omnibar's results panel opens upward out of it.
 */
export function MobileBottomDock() {
  const storedTab = useMobileNavStore((s) => s.activeTab);
  const minimizedState = useMobileNavStore((s) => s.dockMinimized);
  const dockRef = useRef<HTMLDivElement>(null);

  const caps = useAICapabilities();
  const { canChat } = caps;
  const offered = chatOffered(caps);
  const activeTab = shownMobileTab(storedTab, offered);
  /**
   * The chat tab, and only while something can answer. The shell shows the
   * setup page there while the gate offers it, or Today for a chat tab that
   * is not offered at all (components/shell/mobile-shell.tsx), so a composer
   * here would be a field that sends nowhere.
   */
  const chatBar = activeTab === 'chat' && canChat;
  const minimized = minimizedState && activeTab === 'today';
  // The setup page (or the fix home) is what the chat tab shows: read by the
  // arrival rule below, which must tell arriving on Ask from Ask arriving.
  const onSetupPage = activeTab === 'chat' && setupPageShown(caps);
  /**
   * The catch-up host. "Pick things back up" is local and needs no model
   * (lib/commands/registry.ts), and its card answers on the chat surface — so
   * when there is no chat tab to show it, it shows here, above the bar. No
   * `known` term: the gate is closed while its read is pending or failed, and
   * catch-up is the feature that must still work on that day. Mounted only
   * while the card has something to show, so a resting dock is unchanged.
   */
  const hostCard = useChatHostCard();
  // The catch-up card's surface, or the chat tab's conversation's plan.
  const hostSurface = useChatCardSurface();
  // Whether that card's own home, the chat tab, is on screen to carry it.
  const homeShown = useChatCardHomeShown('phone');
  /**
   * Latched once it shows, as on the desktop (components/sidebar/sidebar-dock.tsx
   * says why): when the gate opens mid-review, the card's new home would be a
   * chat tab the user is not on, so unlatched it would vanish from Today. It
   * stays until it is done or the user goes to the chat tab, which then
   * carries it (`!homeShown`, so it never renders twice), dropped lines and
   * all: those are the proposal store's, not the card's.
   */
  const [hosting, setHosting] = useState(false);
  const catchUpHost = hostCard && !homeShown && (!canChat || hosting);
  if (catchUpHost !== hosting) setHosting(catchUpHost);

  // Arriving on the Ask tab puts the caret in the composer only where typing
  // is the point: a conversation or an item on top. Ask home and History are
  // tap targets, and a keyboard raised over them hides what was to be tapped
  // (rail-store's phoneArrivalFocuses). A request the box consumes, as every
  // Ask focus is; an explicit open (revealChat, `?`, "+") makes its own at
  // any view.
  //
  // Not when the setup page or the fix home turns into Ask under the person
  // (a connect, a fix landing): nobody arrived. The gate lights before the
  // connect that lit it pops the phone's stack home, so this effect would read
  // a conversation left there from before and raise the keyboard over "It
  // works."; and a conversation a fix gives back is to be read before it is
  // typed into.
  const wasOnSetupPage = useRef(onSetupPage);
  useEffect(() => {
    const inPlace = wasOnSetupPage.current;
    wasOnSetupPage.current = onSetupPage;
    if (!chatBar || inPlace) return;
    const rail = useRailStore.getState();
    if (phoneArrivalFocuses(rail.stacks.phone)) rail.focusComposer();
  }, [chatBar, onSetupPage]);

  // Measured, not estimated: app/globals.css pins the mobile toast at
  // `--toast-bottom`, and this dock's height moves with the notice stack, the
  // safe-area inset, the fold and the chat composer's wrapping. The ref sits
  // on the OUTERMOST box so every one of those is inside what the
  // ResizeObserver watches.
  useToastAnchor(dockRef);

  const openSearch = () => useUIStore.getState().openDialog({ type: 'launcher' });

  return (
    <div
      ref={dockRef}
      data-testid="mobile-dock"
      data-minimized={minimized ? 'true' : 'false'}
      // `max(12px, inset)` rather than `pb-safe`: a bare
      // `env(safe-area-inset-bottom)` resolves to 0 on every device that
      // reports no inset (Android, iPhone SE, devtools, the @mobile Playwright
      // project), and the capsules' shadows would be clipped at the edge.
      className="px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom,0px))]"
    >
      {/* The notice and undo strips, above the bar on every tab, chat
          included: one voice with one address, so going quiet on the tab
          where the user is talking to the AI would put the two halves of the
          same conversation on different screens. */}
      <DockNoticesMobile />
      <UndoStrip className="mb-1.5" />

      {/* A plain overflow box, not ScrollArea: the Radix wrapper drops max-h.
          The margin lives on the box, which exists only while the card shows. */}
      {catchUpHost && (
        <div className="mb-1.5 max-h-[50vh] overflow-y-auto" data-testid="mobile-catch-up-host">
          <ProposalCard surface={hostSurface} />
        </div>
      )}

      <div
        // Focus handoff target for a self-dismissing notice — see
        // useDismissWithFocus in components/ai/morning-check.tsx.
        data-dock-surface
        className={cn('flex gap-2.5', chatBar ? 'items-end' : 'items-center')}
      >
        {minimized && <FoldedTabKey tab={activeTab} setupShown={onSetupPage} />}
        <div className="min-w-0 flex-1">
          {chatBar ? (
            <AskDockComposer />
          ) : (
            // variant="dock" is explicit because the launcher (Search) mounts
            // the same component as variant="launcher", and the e2e helpers
            // select a shell by data-omnibar-variant. captureRelay: the relay
            // lives inside the capsule and is struck once, when an item files
            // itself (components/primitives/relay-field.tsx).
            <Omnibar
              variant="dock"
              captureRelay
              onAskBeacon={() => revealChat(true)}
              placeholder={minimized ? 'Capture' : 'Get it out of your head'}
              capsule={{ leading: <CaptureDisc />, trailing: <BraindumpCount compact={minimized} /> }}
            />
          )}
        </div>
        {minimized && <SearchKey onClick={openSearch} size="sm" />}
      </div>
      {/* Who answers, under the bar on the Ask tab at every view: the
          capsule says "Ask" and a conversation's box says "Reply…", so this
          is the phone's one sign of it. */}
      {chatBar && <AnswererLabel className="mt-1 pl-[22px]" />}

      {!minimized && (
        <div className="mt-2 flex items-center gap-2.5">
          <TabPill activeTab={activeTab} offered={offered} setupShown={setupPageShown(caps)} askFix={caps.askFix} />
          <SearchKey onClick={openSearch} size="lg" />
        </div>
      )}
    </div>
  );
}

/** The lime + in front of the capture bar's text. Decorative: the bar is the field. */
function CaptureDisc() {
  return (
    <span
      aria-hidden
      className="pointer-events-none flex size-6 flex-none items-center justify-center rounded-full bg-[var(--lime-solid)] text-[var(--lime-ink)]"
    >
      <Plus className="size-[15px]" strokeWidth={2.5} />
    </span>
  );
}

/**
 * How many braindump items are still open, the number the braindump's own
 * header says ("23 undated"): its members at today, less the finished ones.
 * Null until the planner has loaded, for the reason the header gives: "0"
 * over a list about to fill is a small lie on every launch.
 */
function useBraindumpOpenCount(): number | null {
  const tasks = usePlannerStore((s) => s.tasks);
  const habits = usePlannerStore((s) => s.habits);
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const loaded = usePlannerStore((s) => selectPlannerSettled(s) && !s.error);
  const away = useAwayStore((s) => s.periods);
  return useMemo(() => {
    if (!loaded) return null;
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const suppressed = inactiveItemIdsOn(items, toDateStr(new Date(), tz), {
      userTimezone: tz,
      routines,
      seasons,
      away,
    });
    return braindumpMembers(tasks, habits, suppressed).filter((r) => !isRowCompletedOn(r, null)).length;
  }, [loaded, tasks, habits, items, routines, seasons, away, userTimezone]);
}

/** The braindump count at the end of the capture bar; opens the braindump sheet. */
function BraindumpCount({ compact }: { compact: boolean }) {
  const count = useBraindumpOpenCount();
  const open = useMobileNavStore((s) => s.braindumpOpen);
  return (
    <button
      type="button"
      data-testid="mobile-braindump-count"
      aria-label={count === null ? 'Braindump' : `Braindump, ${count} ${count === 1 ? 'item' : 'items'}`}
      aria-expanded={open}
      onClick={() => useMobileNavStore.getState().setBraindumpOpen(!open)}
      className={cn(
        'flex flex-none items-center gap-1.5 rounded-full bg-surface-3 font-semibold tabular-nums text-foreground transition-colors hover:bg-accent',
        compact ? 'h-[34px] px-2.5 text-[14px]' : 'h-[38px] px-3 text-[15px]'
      )}
    >
      <Inbox className="size-[15px]" strokeWidth={1.75} />
      {count !== null && <span className="font-num">{count}</span>}
    </button>
  );
}

/** The Search circle: the ⌘K launcher, summoned. */
function SearchKey({ onClick, size }: { onClick: () => void; size: 'sm' | 'lg' }) {
  return (
    <button
      type="button"
      data-testid="mobile-search"
      aria-label="Search and commands"
      onClick={onClick}
      className={cn(
        'flex flex-none items-center justify-center rounded-full text-foreground',
        RAISED,
        size === 'lg' ? 'size-[62px]' : 'size-[50px]'
      )}
    >
      <Search className="size-[19px]" strokeWidth={1.75} />
    </button>
  );
}

/** The Ask key's name: Ask while something answers, else the page it holds. */
function askLabel(setupShown: boolean, askFix: boolean): string {
  return !setupShown ? 'Ask' : askFix ? 'Fix AI' : 'Set up AI';
}

/**
 * Today · Ask · Organize, the iPhone's floating tab bar. The tab you are on
 * wears the lime fill. Ask is there while the AI gate offers it (Ask, or the
 * setup page or the fix home in its place); a device that turned chat off, or
 * an account that said No AI, has no Ask key. Organize opens the Organize
 * console; while its extension is off the key stays, inert, and says why.
 *
 * `data-tour="mode-card"` is the onboarding tour's phone spotlight, kept from
 * the old dock's mode card so the tour's selector did not have to move.
 */
function TabPill({
  activeTab,
  offered,
  setupShown,
  askFix,
}: {
  activeTab: 'today' | 'chat';
  offered: boolean;
  setupShown: boolean;
  askFix: boolean;
}) {
  const setActiveTab = useMobileNavStore((s) => s.setActiveTab);
  const organizeOn = useOrganizeEnabled();
  const organizeOpen = useUIStore((s) => s.activeDialog?.type === 'organize');
  const openConsole = useOpenConsole();
  // What the pill reports as the surface on screen: the braindump sheet
  // counts, since it covers Today's view while it is open.
  const braindumpOpen = useMobileNavStore((s) => s.braindumpOpen);
  const AskGlyph = setupShown ? AskMarkUnlitIcon : AskMarkIcon;
  // What is waiting on the user, on the Ask tab as on the desktop's Ask key;
  // Ask home lists it all.
  const { canChat } = useAICapabilities();
  const { open: waiting } = useNeedsYouCount();

  return (
    <nav
      aria-label="Surfaces"
      data-tour="mode-card"
      data-testid="mobile-tab-pill"
      data-surface={braindumpOpen && activeTab === 'today' ? 'braindump' : activeTab}
      className={cn('flex h-[62px] min-w-0 flex-1 rounded-full p-[5px]', RAISED)}
    >
      <TabKey
        id="today"
        label="Today"
        icon={<Sun className="size-[19px]" strokeWidth={1.75} />}
        selected={activeTab === 'today' && !organizeOpen}
        onClick={() => setActiveTab('today')}
      />
      {offered && (
        <TabKey
          id="chat"
          label={askLabel(setupShown, askFix)}
          icon={<AskGlyph className="size-[19px]" />}
          count={canChat ? waiting : 0}
          selected={activeTab === 'chat' && !organizeOpen}
          onClick={() => setActiveTab('chat')}
        />
      )}
      <TabKey
        id="organize"
        label="Organize"
        icon={<LayoutGrid className="size-[19px]" strokeWidth={1.75} />}
        selected={organizeOpen}
        disabled={!organizeOn}
        description={organizeOn ? undefined : ORGANIZE_OFF}
        onClick={() => openConsole({ section: 'projects' })}
      />
    </nav>
  );
}

function TabKey({
  id,
  label,
  icon,
  selected,
  disabled = false,
  description,
  count = 0,
  onClick,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  disabled?: boolean;
  description?: string;
  /** What is waiting on the user, on the icon's corner (the Ask tab's). */
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`mobile-tab-${id}`}
      data-tour={`tab-${id}`}
      aria-current={selected ? 'page' : undefined}
      aria-description={description}
      title={description}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11.5px] font-medium transition-colors',
        selected
          ? 'bg-[var(--lime-solid)] font-semibold text-[var(--lime-ink)]'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'opacity-50'
      )}
    >
      <span className="relative">
        {icon}
        {count > 0 && (
          <span
            data-ask-count=""
            data-testid={`mobile-tab-${id}-count`}
            className="absolute -top-2 -right-3 grid place-items-center"
          >
            <span className="ask-count-disc grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums">
              {count > 9 ? '9+' : count}
            </span>
            <span className="sr-only">{` waiting on you`}</span>
          </span>
        )}
      </span>
      <span className="max-w-full truncate px-1">{label}</span>
    </button>
  );
}

/**
 * The folded dock's first key: the tab you are on, in lime, as the iPhone's
 * minimized tab bar draws it. A tap unfolds the dock; it does not change tab.
 */
function FoldedTabKey({ tab, setupShown }: { tab: 'today' | 'chat'; setupShown: boolean }) {
  const Glyph = tab === 'chat' ? (setupShown ? AskMarkUnlitIcon : AskMarkIcon) : Sun;
  return (
    <button
      type="button"
      data-testid="mobile-dock-unfold"
      aria-label="Show tabs"
      onClick={() => useMobileNavStore.getState().setDockMinimized(false)}
      className="flex size-[50px] flex-none items-center justify-center rounded-full bg-[var(--lime-solid)] text-[var(--lime-ink)] shadow-[0_1px_2px_rgb(0_0_0/6%),0_4px_14px_rgb(0_0_0/7%)]"
    >
      <Glyph className="size-5" strokeWidth={1.75} />
    </button>
  );
}

/**
 * The Ask tab's box: the dock pill, bound to the top of the phone's Ask stack
 * (usePhoneComposerBinding), its text kept per binding and its focus taken
 * only on request (BoundComposer). The label is the dock's own row.
 */
function AskDockComposer() {
  const { binding, placeholder } = usePhoneComposerBinding();
  return <BoundComposer variant="dock" surface="phone" binding={binding} placeholder={placeholder} label={false} />;
}
