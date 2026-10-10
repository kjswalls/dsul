'use client';

import { useState } from 'react';
import { AlignLeft, Check, Sun } from 'lucide-react';

import { AskMarkIcon, AskMarkUnlitIcon } from '@/components/ai/ask-mark';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { getAICapabilities, useAICapabilities } from '@/lib/ai-connection-store';
import { phoneArrivalFocuses, useRailStore } from '@/lib/rail-store';
import {
  chatOffered,
  mobileTabOrder,
  setupPageShown,
  shownMobileTab,
  useMobileNavStore,
  type MobileTab,
} from '@/lib/mobile-nav-store';
import { cn } from '@/lib/utils';

/**
 * One glyph per surface, and they are the whole readout.
 *
 * Round 6 of the redesign took the lime tint off the mode card: with no colour
 * left to say "active", the glyph alone has to say which surface you are on, so
 * these three have to stay maximally unlike each other. Anything that reads as a
 * generic "list" or a generic "star" belongs in another slot.
 */
const GLYPHS: Record<MobileTab, typeof Sun> = {
  braindump: AlignLeft,
  today: Sun,
  chat: AskMarkIcon,
};

/**
 * The chat surface's glyph while it holds the setup page or the fix home: the
 * unlit mark, as on the desktop's "Set up AI" and "Fix AI" key. Its neutral
 * tiles say "not connected yet" and carry no accent, so the card stays
 * colourless. Once something answers it is Ask's one-ink mark again, not the
 * lit aurora mark: that would put the accent back on the card round 6 took it
 * off.
 */
const SETUP_GLYPHS: Record<MobileTab, typeof Sun> = { ...GLYPHS, chat: AskMarkUnlitIcon };

/**
 * Lucide's default stroke of 2 is thinned to 1.5 app-wide (the
 * `.lucide[stroke-width='2']` rule in globals.css). These glyphs opt out: at
 * 18px inside a 44px card they are the only thing distinguishing three
 * surfaces, and the artboard draws them at 2.25. Ask's is the AI's mark in one
 * ink (components/ai/ask-mark.tsx), filled tiles with no stroke to set, so it
 * ignores this and stays the colourless foreground the card asks for.
 */
const GLYPH_STROKE = 2.25;

/**
 * The dock's mode card and the sheet it opens — the replacement for the
 * three-tab bar that used to sit under the omnibar.
 *
 * Card and sheet ship together because they are one control: the card shows the
 * surface you are on and the sheet is how you leave it, and splitting them would
 * mean two components deriving the same `activeTab` and agreeing by luck.
 *
 * `[data-tour="tab-*"]` rides the sheet's ENTRIES. It used to be on the tab
 * bar's buttons, where it was also how two @mobile specs changed tab in one
 * click; those go through `switchMobileTab` in tests/e2e/helpers/app.ts now,
 * which opens the sheet first. The onboarding tour points at the card instead
 * (`data-tour="mode-card"`) — spotlighting an entry inside a closed sheet would
 * be a hole cut in the overlay around nothing.
 *
 * NO RELAY ON THE CARD. mobile-redesign.md § Motion names the card's tap as the
 * second place to earn the radial field, and the tap point genuinely is a good
 * origin for one — but the tap's own consequence is this sheet, which is fixed
 * to the bottom of the screen over a full-bleed `backdrop-blur-[7px]` scrim and
 * so covers the dock within a frame or two of the press. A burst plays out over
 * the best part of a second; behind frosted glass, none of it is seen. Moving it
 * to the sheet's CLOSE would clear the occlusion and lose the point: the origin
 * would no longer be the thing that was touched, just a flash on a card. The
 * capture strike in the bar beside this one is the placement that survives, and
 * the spec ranks it first for its own reasons.
 */
export function ModeSwitcherSheet() {
  const storedTab = useMobileNavStore((s) => s.activeTab);
  const setActiveTab = useMobileNavStore((s) => s.setActiveTab);
  const caps = useAICapabilities();
  const offered = chatOffered(caps);
  const setupShown = setupPageShown(caps);
  // What the shell is SHOWING: a chat tab that is no longer offered renders as
  // Today (components/shell/mobile-shell.tsx), and the card has to say so too.
  const activeTab = shownMobileTab(storedTab, offered);
  const [open, setOpen] = useState(false);
  /**
   * Whether the last tap was an arrival on Ask, remembered only long enough
   * for the close-autofocus handler below to read it: the chat row tapped
   * from another surface while something answered, the one tap the dock's
   * arrival rule (mobile-bottom-dock.tsx) gives the box focus for. Cleared on
   * every open so a sheet dismissed by the scrim or a swipe restores focus
   * normally.
   */
  const [pendingAsk, setPendingAsk] = useState(false);

  // The chat surface is Ask, whoever answers: the model label under its box
  // says who (components/mobile/mobile-bottom-dock.tsx). While nothing answers
  // it is named for the page it holds instead, in the words the desktop's key
  // wears, so the name is never a promise. It is only listed while the gate
  // offers it (mobileTabOrder).
  const labels: Record<MobileTab, string> = {
    braindump: 'Braindump',
    today: 'Today',
    chat: !setupShown ? 'Ask' : caps.askFix ? 'Fix AI' : 'Set up AI',
  };
  // The setup page's row says how much it matters: setting AI up is a choice,
  // a saved model that stopped answering is a problem. Its own span, never
  // part of the name the card and the sheet's description read.
  const chatNote = !setupShown ? null : caps.askFix ? 'Needs attention' : 'Optional';
  const glyphs = setupShown ? SETUP_GLYPHS : GLYPHS;
  const ActiveGlyph = glyphs[activeTab];

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPendingAsk(false);
      }}
      // vaul defaults autoFocus to false, which it implements by
      // preventDefault-ing Radix's open-autofocus — so focus stayed on the mode
      // card while DialogContentModal's hideOthers() marked the app root
      // aria-hidden around it. A screen reader landed on a hidden node with
      // nothing announced, and Tab went to the omnibar BEHIND the scrim
      // (FocusScope's recovery focuses its last-focused-inside ref, which is
      // still null when nothing inside was ever focused). This sheet is the only
      // route between surfaces that is not a swipe, which is the gesture those
      // users do not have.
      autoFocus
    >
      <DrawerTrigger asChild>
        <button
          type="button"
          data-tour="mode-card"
          data-testid="mobile-mode-card"
          // The surface as a machine-readable value, so a test can assert where
          // it landed without reading a label (the chat tab's id stays `chat`,
          // stored and keyed by tests, while its name is Ask).
          data-surface={activeTab}
          // The glyph is the entire visible name of this control, so the
          // accessible name has to carry both halves of what it says: which
          // surface you are on, and that pressing it changes that.
          aria-label={`Surface: ${labels[activeTab]}. Change surface.`}
          className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-foreground shadow-[var(--shadow-elev-sm)]"
        >
          <ActiveGlyph className="size-[18px]" strokeWidth={GLYPH_STROKE} />
        </button>
      </DrawerTrigger>

      <DrawerContent
        data-testid="mode-switcher-sheet"
        // The Ask tab's box takes focus on arrival when a conversation or an
        // item is on top (the arrival request in mobile-bottom-dock.tsx), and
        // that lands while this drawer is still playing its 500ms slide-out.
        // Radix keeps the content mounted for the whole animation and then
        // restores focus to the trigger, so the caret appeared in the composer
        // and was yanked back to the mode card half a second later — and only
        // with motion ON, since a reduced-motion unmount beats the composer to
        // it. Stand down for exactly that arrival, by the same rule: at Ask
        // home or History nothing takes focus, and the mode card should get it
        // back rather than leave it on <body>. Only for a tap the dock answers,
        // and only while Ask is still what the tab shows: the stack outlives
        // the gate, and a conversation left on it under the setup page or the
        // fix home is neither on screen nor given a box. The setup page that
        // turns into Ask during the close, or the row already current, moves
        // nothing in the dock, so the card gets focus back then too.
        onCloseAutoFocus={(event) => {
          if (
            pendingAsk &&
            getAICapabilities().canChat &&
            phoneArrivalFocuses(useRailStore.getState().stacks.phone)
          ) {
            event.preventDefault();
          }
        }}
      >
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-left text-base">Go to</DrawerTitle>
          <DrawerDescription className="sr-only">
            {offered
              ? `Switch between the Braindump, Today and ${labels.chat} surfaces.`
              : 'Switch between the Braindump and Today surfaces.'}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-1 px-4 pb-4">
          {mobileTabOrder(offered).map((id) => {
            const Glyph = glyphs[id];
            const note = id === 'chat' ? chatNote : null;
            const current = id === activeTab;
            return (
              <button
                key={id}
                type="button"
                data-tour={`tab-${id}`}
                data-testid={`mode-option-${id}`}
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  // Read before the tap moves the tab: only one from another
                  // surface onto Ask is an arrival.
                  setPendingAsk(
                    id === 'chat' && useMobileNavStore.getState().activeTab !== 'chat' && getAICapabilities().canChat
                  );
                  setActiveTab(id);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-12 items-center gap-3 rounded-[10px] px-3 text-left',
                  // --row-selected, not bg-surface-3, and the reason is dark
                  // mode. The sheet is --modal, which resolves to the canvas in
                  // both themes: in light that is 0.996 against a 0.945 well, a
                  // clear step; in dark it is 0.21 against 0.245, and the hover
                  // wash (white 6%) lands ABOVE that — so the row you are
                  // passing over read stronger than the row you are on. This
                  // token exists for exactly that ordering ("a latched
                  // selection a touch above a passing hover") and is the same
                  // one every multi-selected row in the app carries.
                  current ? 'bg-[var(--row-selected)]' : 'hover-wash'
                )}
              >
                <Glyph
                  className="size-[18px] shrink-0 text-foreground"
                  strokeWidth={GLYPH_STROKE}
                />
                <span className="flex-1 truncate text-sm font-medium text-foreground">
                  {labels[id]}
                  {/* After a space, not a gap: the row's name is read off
                      its text, and two spans with nothing between them run
                      together ("Set up AIOptional"). Muted ink, never the
                      accent: a quiet aside on a row the sheet keeps
                      colourless. */}
                  {note && (
                    <>
                      {' '}
                      <span data-mode-note="" className="ml-1 text-xs font-normal text-muted-foreground">
                        {note}
                      </span>
                    </>
                  )}
                </span>
                {/* A mark, not a tint: the card this sheet belongs to gave up
                    its lime highlight in round 6, and a lime row here would put
                    the colour back one tap away from where it was removed. */}
                {current && <Check className="size-4 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
