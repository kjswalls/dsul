'use client';

import { useState } from 'react';
import { AlignLeft, Check, Sparkles, Sun } from 'lucide-react';

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { phoneArrivalFocuses, useRailStore } from '@/lib/rail-store';
import {
  mobileTabOrder,
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
  chat: Sparkles,
};

/**
 * Lucide's default stroke of 2 is thinned to 1.5 app-wide (the
 * `.lucide[stroke-width='2']` rule in globals.css). These glyphs opt out: at
 * 18px inside a 44px card they are the only thing distinguishing three
 * surfaces, and the artboard draws them at 2.25.
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
  const { canChat } = useAICapabilities();
  // What the shell is SHOWING: a chat tab that can no longer answer renders as
  // Today (components/shell/mobile-shell.tsx), and the card has to say so too.
  const activeTab = shownMobileTab(storedTab, canChat);
  const [open, setOpen] = useState(false);
  /**
   * The surface the last tap sent us to, remembered only long enough for the
   * close-autofocus handler below to read it. Cleared on every open so a sheet
   * dismissed by the scrim or a swipe restores focus normally.
   */
  const [pendingTab, setPendingTab] = useState<MobileTab | null>(null);

  // The chat surface is Ask, whoever answers: the model label under its box
  // says who (components/mobile/mobile-bottom-dock.tsx). It is only listed
  // while something can answer (mobileTabOrder), so the name is never a
  // promise.
  const labels: Record<MobileTab, string> = {
    braindump: 'Braindump',
    today: 'Today',
    chat: 'Ask',
  };
  const ActiveGlyph = GLYPHS[activeTab];

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPendingTab(null);
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
        // back rather than leave it on <body>.
        onCloseAutoFocus={(event) => {
          if (pendingTab === 'chat' && phoneArrivalFocuses(useRailStore.getState().stacks.phone)) {
            event.preventDefault();
          }
        }}
      >
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-left text-base">Go to</DrawerTitle>
          <DrawerDescription className="sr-only">
            {canChat
              ? `Switch between the Braindump, Today and ${labels.chat} surfaces.`
              : 'Switch between the Braindump and Today surfaces.'}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-1 px-4 pb-4">
          {mobileTabOrder(canChat).map((id) => {
            const Glyph = GLYPHS[id];
            const current = id === activeTab;
            return (
              <button
                key={id}
                type="button"
                data-tour={`tab-${id}`}
                data-testid={`mode-option-${id}`}
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  setPendingTab(id);
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
