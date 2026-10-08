'use client';

import { useState, useEffect, useRef, useCallback, useId, useMemo, type CSSProperties } from 'react';
import { X, ArrowRight, ChevronLeft, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OPENER_ICONS } from '@/components/ai/ask/it-works-card';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { useOpenerContext } from '@/hooks/use-opener-context';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { buildTourOpenerPreviews } from '@/lib/ai-openers';
import type { AICapabilities } from '@/lib/ai-registry';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chooseNoAI } from '@/lib/no-ai';
import { openSetup } from '@/lib/open-chat';
import { setOnboardingComplete } from '@/lib/user-profile';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
import Image from 'next/image';

const SPOTLIGHT_PADDING = 8;

/**
 * @param revision re-measures when the selector has NOT changed but the target
 *   may have moved. All three mobile steps spotlight the same mode card while
 *   switching the tab underneath it, and the dock the card rides is only as tall
 *   as its notice stack: one notice arriving or clearing between steps slides
 *   the card without the selector changing a character, and the cutout would sit
 *   a few px off the control it is pointing at. Step 4 adds its AI variant, so a
 *   key that comes back after the gate flapped is found and measured again.
 *
 * A target that measures 0x0 is no target: the header key's slot is `hidden`
 * when the header has no room for it, in Zen, or while a column shows, and a
 * cutout round nothing would sit in the top left corner. The step then draws
 * the plain scrim and its card falls back to a static place.
 *
 * A ResizeObserver on the element found re-measures as it changes size (the
 * key steps between its forms as the header row's room changes), and moves to
 * a new element when the selector finds a different one.
 */
function useSpotlightRect(selector: string | null, revision?: string) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selector) { setRect(null); return; }

    let observed: Element | null = null;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const el = document.querySelector(selector);
      if (el !== observed) {
        if (observed) observer?.unobserve(observed);
        if (el) observer?.observe(el);
        observed = el;
      }
      const r = el?.getBoundingClientRect();
      setRect(r && (r.width > 0 || r.height > 0) ? r : null);
    };
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(() => measure());

    measure(); // immediate pass
    // Re-measure after CSS animations settle (sidebar open, tab switch, etc.)
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [selector, revision]);

  return rect;
}

const EDGE_BLUR = 24; // blur radius for soft edge fade

/**
 * Where a mobile coach-mark card sits: just above the bottom dock.
 *
 * It used to be a flat `bottom-20`, chosen when the mobile steps spotlighted the
 * tab bar and the card only had to not cover the tab bar's LABELS. The spotlight
 * target is now the dock's mode card, so a card overlapping the dock would cover
 * the cutout the step exists to point at.
 *
 * `--toast-bottom` is the dock's own measured top edge plus 8px
 * (hooks/use-toast-anchor.ts), the same number the undo toast floats above, and
 * it already tracks the safe-area inset and the notice stack. The fallback only
 * covers the frame before the dock's first measurement lands.
 */
const MOBILE_CARD_ABOVE_DOCK = { bottom: 'var(--toast-bottom, 96px)' } as const;

/**
 * The tallest the phone's AI card may be: from just above the dock to 16px
 * under the top of the screen, past the notch (`.pt-safe`'s rule, so the
 * desktop app's drag band counts too when a narrow window shows the phone
 * shell). A landscape phone or large text gives it less than it wants, and
 * then its words scroll while its buttons stay put.
 */
const PHONE_CARD_CAP =
  'calc(100dvh - var(--toast-bottom, 96px) - max(env(safe-area-inset-top, 0px), env(titlebar-area-height, 0px)) - 16px)';

/** The desktop AI card's cap while the key has not been measured, under its static `top-20`. */
const DESKTOP_CARD_CAP = 'calc(100vh - 6rem)';

export const TOUR_DONE_TITLE = "You're all set. One thing at a time.";
export const TOUR_REPLAY_TIP = 'Tip: replay this tour anytime from Settings.';
/** Not now's toast: where the invitation waits. The desktop's key, the phone's switcher row. */
export const TOUR_LATER_DESKTOP = 'Set up AI waits at the top right whenever you want it.';
export const TOUR_LATER_PHONE = 'Set up AI waits under the mode button whenever you want it.';
export const TOUR_AI_TITLE = 'AI, if you want it';
export const TOUR_AI_BODY =
  'AI can plan the day with you, break big tasks into steps, and answer questions about your plan. You always decide.';
export const TOUR_AI_PREVIEWS_HEADING = 'What you could ask now';
export const TOUR_AI_CAPTION = 'Built from your planner. Each becomes one click once AI is connected.';
export const TOUR_AI_PHONE_LINE = 'Later, it waits under the mode button.';
export const TOUR_AI_OFF_TITLE = 'AI stays off';
export const TOUR_AI_OFF_BODY = 'You turned AI off, so dsul won’t bring it up. You can turn it back on in Settings → AI.';

/**
 * What the tour's step 4 is about, read once from the AI gate and never
 * re-derived anywhere else in the tour:
 *  - 'ready': something answers. The card says how to ask, beside Ask's
 *    column on the desktop, on the Ask tab on the phone.
 *  - 'invite': nothing answers and the gate offers setup (`askInvite`). The
 *    spotlight is on the unlit key (the mode card on the phone, whose switcher
 *    holds the setup row), and the card says what AI could do, previews two
 *    things to ask, and offers Set up AI, Not now and No AI, thanks.
 *  - 'off': a replay on an account that said "No AI, thanks". A quiet card
 *    that says AI stays off, and how to turn it back on.
 *  - null: anything else. The gate has not answered or failed, AI is not
 *    available, chat is Off on this device, an OpenClaw agent key answers no
 *    chat, a saved key needs fixing, or the account's answer is unread. There
 *    is no step 4 then: step 3's last card reads "Got it →" and ends the tour.
 *    No invitation while the gate cannot say one is right.
 */
export type AIStep = 'ready' | 'invite' | 'off' | null;

export function tourAIStep(c: Pick<AICapabilities, 'canChat' | 'askInvite' | 'aiHidden'>): AIStep {
  return c.canChat ? 'ready' : c.askInvite ? 'invite' : c.aiHidden ? 'off' : null;
}

type Step = 1 | 2 | 3 | 4;

/**
 * What each step spotlights. Pure, so a test can pin the targets: jsdom draws
 * no cutout.
 *
 * Every mobile step spotlights the DOCK'S MODE CARD, not a per-surface
 * target. The three-tab bar these steps used to point at is gone; its `tab-*`
 * handles moved onto the switcher sheet's entries, which are only in the DOM
 * while that sheet is open, so a spotlight there would cut a hole in the
 * overlay around nothing. The card is on screen for every step, and it is
 * what the tab effects have just moved. It is also a Drawer trigger, which is
 * why the mobile steps seal the cutout with `blockTarget` (see
 * SpotlightOverlay). At step 4 it is also where the invitation waits: the
 * switcher's "Set up AI" row.
 *
 * On the desktop, step 3's last card lights Ask's column while something
 * answers and the dock otherwise; step 4 lights the column for 'ready', the
 * unlit key in the header for 'invite', and the dock for 'off'.
 */
export function tourSpotlightSelector(s: {
  step: Step;
  desktopSubStep: 'A' | 'B' | 'C';
  mobileSubStep: 'A' | 'B';
  isMobile: boolean;
  canChat: boolean;
  aiStep: AIStep;
}): string | null {
  if (s.step === 3) {
    if (s.isMobile) return '[data-tour="mode-card"]';
    if (s.desktopSubStep === 'A') return '[data-tour="left-sidebar"]';
    if (s.desktopSubStep === 'B') return '[data-tour="timeline"]';
    return s.canChat ? '[data-tour="right-sidebar"]' : '[data-tour="dock"]';
  }
  if (s.step === 4) {
    if (s.isMobile) return '[data-tour="mode-card"]';
    if (s.aiStep === 'ready') return '[data-tour="right-sidebar"]';
    if (s.aiStep === 'invite') return '[data-tour="ask-key"]';
    return '[data-tour="dock"]';
  }
  return null;
}

// Hook to detect dark mode
function useIsDarkMode() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

/**
 * Spotlight overlay: single element with a massive box-shadow that covers
 * the entire screen except the cutout, with soft blurred edges.
 *
 * @param blockTarget covers the cutout with the click catcher instead of
 *   clipping a hole in it, so the spotlit control cannot be operated while the
 *   tour is up. The hole is click-through by default because the desktop steps
 *   spotlight panels, and the retired mobile tab bar was idempotent: a tap fell
 *   through to `setActiveTab(<the tab the step had just switched to>)`. The
 *   mobile steps now spotlight the dock's mode card, which is a Drawer trigger:
 *   the sheet portals to body at z-50, this overlay is z-[100], so a tap through
 *   the hole opens a modal UNDER a scrim the user cannot dismiss, and its rows
 *   land on the catcher rather than the sheet. Step 4 seals it on the desktop
 *   too: a click through to the key would open setup under the tour. The step's
 *   own buttons are the only controls while the tour owns the screen.
 */
function SpotlightOverlay({
  rect,
  onClick,
  blockTarget = false,
}: {
  rect: DOMRect | null;
  onClick?: () => void;
  blockTarget?: boolean;
}) {
  const isDark = useIsDarkMode();
  const overlayColor = isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.55)';

  if (!rect) {
    return (
      <div
        className="absolute inset-0 pointer-events-auto bg-black/55 dark:bg-black/70"
        onClick={onClick}
      />
    );
  }

  const t = Math.max(0, rect.top - SPOTLIGHT_PADDING);
  const l = Math.max(0, rect.left - SPOTLIGHT_PADDING);
  const w = rect.width + SPOTLIGHT_PADDING * 2;
  const h = rect.height + SPOTLIGHT_PADDING * 2;

  return (
    <>
      {/* Single spotlight element with massive blurred box-shadow */}
      <div
        className="absolute rounded-lg pointer-events-none"
        style={{
          top: t,
          left: l,
          width: w,
          height: h,
          boxShadow: `0 0 ${EDGE_BLUR}px 9999px ${overlayColor}`
        }}
      />
      {/* Invisible click catcher for the overlay area */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={onClick}
        style={{
          clipPath: blockTarget
            ? undefined
            : `polygon(
            0% 0%, 0% 100%,
            ${l}px 100%, ${l}px ${t}px,
            ${l + w}px ${t}px, ${l + w}px ${t + h}px,
            ${l}px ${t + h}px, ${l}px 100%,
            100% 100%, 100% 0%
          )`
        }}
      />
    </>
  );
}

interface OnboardingTourProps {
  userId: string;
  onComplete: () => void;
  onExpandChat?: () => void;
  onCollapseChat?: () => void;
  onSetActiveTab?: (tab: string) => void;
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5 items-center">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'rounded-full transition-all duration-300',
            i + 1 === current
              ? 'w-4 h-1.5 bg-primary'
              : 'w-1.5 h-1.5 bg-muted-foreground/30'
          )}
        />
      ))}
    </div>
  );
}

function SkipButton({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      onClick={onSkip}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <X className="h-3.5 w-3.5" />
      Skip tour
    </button>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ChevronLeft className="h-3.5 w-3.5" />
      Back
    </button>
  );
}

export function OnboardingTour({ userId, onComplete, onExpandChat, onCollapseChat, onSetActiveTab }: OnboardingTourProps) {
  const [step, setStep] = useState<Step>(1);
  const [taskInput, setTaskInput] = useState('');
  // The task step 2 added, by id: the AI card's example. Never `taskInput`,
  // which Skip leaves filled with nothing added.
  const [firstTaskId, setFirstTaskId] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [desktopSubStep, setDesktopSubStep] = useState<'A' | 'B' | 'C'>('A');
  const [mobileSubStep, setMobileSubStep] = useState<'A' | 'B'>('A');
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  /**
   * Whether anything can answer in chat, and what step 4 is about (`AIStep`).
   * The tour never walks someone to a chat surface that is not there: without
   * chat, sub-step C is the dock. The spotlight is Ask's column
   * (`right-sidebar`, which exists only while something answers) with chat,
   * and the capture dock (`dock`) without.
   */
  const { canChat, askInvite, aiHidden } = useAICapabilities();
  const aiStep = tourAIStep({ canChat, askInvite, aiHidden });
  // Step 4 keeps the variant it arrived with while the gate reads unknown for
  // a moment (a re-read in flight), so a flap neither swaps the card for
  // nothing nor ends the tour unasked. A real answer re-renders the card it
  // calls for; each exit asks the gate again as it acts (openSetup returns
  // false when nothing is offered).
  const [heldAIStep, setHeldAIStep] = useState<AIStep>(null);
  if (step === 4 && aiStep !== null && aiStep !== heldAIStep) setHeldAIStep(aiStep);
  const shownAIStep: AIStep = step === 4 ? (aiStep ?? heldAIStep ?? 'off') : aiStep;
  // Keys as the user has them bound, never typed: Ask's (Ctrl+J by default)
  // for step 4's copy, the launcher's (Ctrl+K) for the no-AI dock card.
  const askKeys = useShortcutKeys('toggle_right_sidebar');
  const launcherBinding = useShortcutKeys('system_search');
  const spotlightSelector = tourSpotlightSelector({
    step,
    desktopSubStep,
    mobileSubStep,
    isMobile,
    canChat,
    aiStep: shownAIStep,
  });

  const spotlightRect = useSpotlightRect(
    spotlightSelector,
    `${step}-${desktopSubStep}-${mobileSubStep}-${shownAIStep}-${aiStep}`
  );

  // Anchor a card just outside the spotlight target, computed from its live
  // rect. It replaces hardcoded left/right offsets that broke when the sidebar
  // width changed. Falls back to undefined (callers keep a static class) if no
  // rect. The card sits beside its target on the preferred side, flips when
  // that side has no room for it, and goes above a target too wide for either,
  // since a layout (lib/layout-themes.ts) can put the braindump at the right
  // edge or lay the dock across the whole foot of the screen.
  //
  // 'below' is the AI invitation's, under the key: its right edge on the
  // cutout's (F01), below the key while there is room for the card and above
  // it otherwise. It is anchored by its right edge rather than a left worked
  // out from a width, because the card is `w-80` in rem and a larger browser
  // font widens it; the card's own `max-w` keeps its left edge on screen. It
  // alone returns a `maxHeight`, the room it has, which the card itself takes
  // so its words scroll and its buttons stay; the wrapper takes the rest.
  const cardAnchor = (side: 'left' | 'right' | 'below'): CSSProperties | undefined => {
    if (!spotlightRect) return undefined;
    const CARD_W = 288 + 16;
    const iw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const ih = typeof window !== 'undefined' ? window.innerHeight : 0;
    if (side === 'below') {
      const right = Math.max(16, iw - (spotlightRect.right + SPOTLIGHT_PADDING));
      const gap = SPOTLIGHT_PADDING + 12;
      const roomBelow = ih - (spotlightRect.bottom + gap) - 16;
      const roomAbove = spotlightRect.top - gap - 16;
      return roomBelow >= 360 || roomBelow >= roomAbove
        ? { right, top: spotlightRect.bottom + gap, maxHeight: roomBelow }
        : { right, bottom: ih - spotlightRect.top + gap, maxHeight: roomAbove };
    }
    const roomRight = iw - spotlightRect.right - 16;
    const roomLeft = spotlightRect.left - 16;
    let place: 'left' | 'right' | 'above' = side;
    if (place === 'right' && roomRight < CARD_W) place = roomLeft >= CARD_W ? 'left' : 'above';
    else if (place === 'left' && roomLeft < CARD_W) place = roomRight >= CARD_W ? 'right' : 'above';
    if (place === 'above') {
      return { left: '50%', bottom: ih - spotlightRect.top + 16, transform: 'translateX(-50%)' };
    }
    const top = spotlightRect.top + spotlightRect.height / 2;
    return place === 'right'
      ? { left: spotlightRect.right + 16, top, transform: 'translateY(-50%)' }
      : { right: iw - spotlightRect.left + 16, top, transform: 'translateY(-50%)' };
  };

  // The AI card's previews: Ask home's first two offers, from the real planner
  // and hour, naming the task step 2 added (lib/ai-openers.ts).
  const { ctx: openerCtx, minutesNow } = useOpenerContext();
  const previews = useMemo(
    () =>
      openerCtx && minutesNow !== null
        ? buildTourOpenerPreviews(openerCtx, { minutesNow, exampleId: firstTaskId })
        : [],
    [openerCtx, minutesNow, firstTaskId]
  );
  const idBase = useId();
  const titleId = `${idBase}-ai-title`;
  const bodyId = `${idBase}-ai-body`;
  const previewsId = `${idBase}-ai-previews`;
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const onExpandChatRef = useRef(onExpandChat);
  const onCollapseChatRef = useRef(onCollapseChat);
  const onSetActiveTabRef = useRef(onSetActiveTab);
  useEffect(() => { onExpandChatRef.current = onExpandChat; }, [onExpandChat]);
  useEffect(() => { onCollapseChatRef.current = onCollapseChat; }, [onCollapseChat]);
  useEffect(() => { onSetActiveTabRef.current = onSetActiveTab; }, [onSetActiveTab]);
  const { addTask } = usePlannerStore();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Auto-focus input in step 2
  useEffect(() => {
    if (step === 2) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [step]);

  // Step 4 is a dialog: arriving puts focus on its title, so a screen reader
  // reads the card from the top and a Tab starts at its first button. Enter on
  // the title does nothing; only the card's own buttons act.
  useEffect(() => {
    if (step === 4) titleRef.current?.focus({ preventScroll: true });
  }, [step, isMobile, shownAIStep]);

  // Show Ask for desktop sub-step C, and put it back after. Only when chat
  // exists: otherwise C is about the dock. The shell wires these to a summon
  // that never persists and a park (app-shell.tsx), so the tour never writes
  // the user's `askOpen`, and nothing is left armed to spring open later.
  // Never once the tour has ended: it stays mounted through the completion
  // write, and a gate answer landing then must not open Ask after it.
  useEffect(() => {
    if (!isVisible) return;
    if (step === 3 && !isMobile) {
      if (desktopSubStep === 'C' && canChat) {
        onExpandChatRef.current?.();
      } else {
        onCollapseChatRef.current?.();
      }
    }
  }, [isVisible, step, isMobile, desktopSubStep, canChat]);

  // Switch to tasks tab when reaching mobile sub-step A (step 3)
  useEffect(() => {
    if (!isVisible) return;
    if (step === 3 && isMobile) {
      if (mobileSubStep === 'A') {
        onSetActiveTabRef.current?.('braindump');
      } else if (mobileSubStep === 'B') {
        onSetActiveTabRef.current?.('today');
      }
    }
  }, [isVisible, step, isMobile, mobileSubStep]);

  // Switch to the Ask tab (id 'chat') when reaching step 4 on mobile while
  // something answers, where the card says to type in the bar below. Otherwise
  // the step stays on Today, pointing at the mode card it already lit, since
  // that is where the card says setup waits.
  useEffect(() => {
    if (isVisible && step === 4 && isMobile && canChat) {
      onSetActiveTabRef.current?.('chat');
    }
  }, [isVisible, step, isMobile, canChat]);

  const advanceWithExit = useCallback((fn: () => void) => {
    setIsExiting(true);
    setTimeout(() => {
      setIsExiting(false);
      fn();
    }, 280);
  }, []);

  /**
   * Every way the tour ends but Set up AI and No AI: Ask put back, Braindump
   * on the phone, the tour gone, then the completion toast when there is
   * something to say (Skip has nothing). All of it happens before the one
   * await, so nothing lands a round trip late.
   */
  const finish = useCallback(async (description: string | null) => {
    onCollapseChatRef.current?.();
    onSetActiveTabRef.current?.('braindump');
    setIsVisible(false);
    if (description) toast.success(TOUR_DONE_TITLE, { description, duration: 5000 });
    await setOnboardingComplete(userId);
    onComplete();
  }, [userId, onComplete]);

  const handleComplete = useCallback(() => finish(TOUR_REPLAY_TIP), [finish]);

  /**
   * Set up AI: the tour goes and setup opens where it lives, the column on
   * the desktop and the Ask tab's setup page on the phone, with no toast.
   * Ask is put back first, since setup's summon must come after it, and setup
   * opens before the await, so it never shows a round trip late. If the gate
   * stopped offering setup meanwhile, nothing opens and the tour ends quietly
   * on Braindump: neither toast would be true then.
   */
  const handleSetUpAI = useCallback(async () => {
    onCollapseChatRef.current?.();
    setIsVisible(false);
    const opened = openSetup(isMobile);
    if (!opened) onSetActiveTabRef.current?.('braindump');
    await setOnboardingComplete(userId);
    onComplete();
  }, [isMobile, userId, onComplete]);

  /**
   * No AI, thanks: the account's answer (lib/no-ai.ts), said in the undo strip
   * with focus on its Undo, and no toast. It is said before the await: after
   * it, the still-visible card would first redraw as "AI stays off" and Undo
   * would take focus under the scrim. `chooseNoAI` puts Ask back itself.
   */
  const handleNoAI = useCallback(async () => {
    onSetActiveTabRef.current?.('braindump');
    setIsVisible(false);
    void chooseNoAI(isMobile ? { phone: true } : {});
    await setOnboardingComplete(userId);
    onComplete();
  }, [isMobile, userId, onComplete]);

  const handleNext = useCallback(() => {
    if (step === 3 && !isMobile) {
      if (desktopSubStep === 'A') { setDesktopSubStep('B'); return; }
      if (desktopSubStep === 'B') { setDesktopSubStep('C'); return; }
    }
    if (step === 3 && isMobile) {
      if (mobileSubStep === 'A') { setMobileSubStep('B'); return; }
    }
    // Step 3's last card is the tour's last when there is no step 4.
    if (step === 3 && aiStep === null) {
      handleComplete();
      return;
    }
    if (step < 4) setStep((s) => (s + 1) as Step);
  }, [step, isMobile, desktopSubStep, mobileSubStep, aiStep, handleComplete]);

  const handleBack = useCallback(() => {
    if (step === 2) {
      setStep(1);
    } else if (step === 3) {
      if (!isMobile) {
        if (desktopSubStep === 'A') {
          setStep(2);
        } else if (desktopSubStep === 'B') {
          setDesktopSubStep('A');
        } else if (desktopSubStep === 'C') {
          setDesktopSubStep('B');
        }
      } else {
        if (mobileSubStep === 'A') {
          setStep(2);
        } else {
          setMobileSubStep('A');
        }
      }
    } else if (step === 4) {
      setDesktopSubStep('C');
      setMobileSubStep('B');
      setStep(3);
    }
  }, [step, isMobile, desktopSubStep, mobileSubStep]);

  // Tab is the tour's "Next" on steps 1 and 3 (step 2 has a text box). Step 4
  // is a choice, never a default, so Tab there moves between the card's own
  // buttons, wrapping at both ends, and never into the page behind the scrim.
  // Once the tour has gone (an exit waits on one round trip before the shell
  // unmounts it) Tab belongs to the page again.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isVisible) return;
      if (step === 2) return;
      if (e.key !== 'Tab') return;
      if (step === 4) {
        const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
        if (buttons.length === 0) return;
        e.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        const to =
          at === -1
            ? (e.shiftKey ? buttons.length - 1 : 0)
            : (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[to].focus();
        return;
      }
      e.preventDefault();
      handleNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, step, handleNext]);

  const handleSkip = () => finish(null);

  const handleCreateTask = async () => {
    if (isCreatingTask) return;
    setIsCreatingTask(true);

    if (taskInput.trim()) {
      // Add as unscheduled task (no timeBucket, no startDate) → appears in sidebar
      setFirstTaskId(addTask({ title: taskInput.trim() }));
      try {
        confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ['#a855f7', '#6366f1', '#ec4899'] });
      } catch (_) {
        // confetti may fail on some mobile browsers, which is not fatal
      }
      advanceWithExit(() => {
        setIsCreatingTask(false);
        setStep(3);
      });
    } else {
      setIsCreatingTask(false);
      setStep(3);
    }
  };

  if (!isVisible) return null;

  const exitClass = isExiting ? 'animate-out fade-out zoom-out-95 duration-300' : '';

  // Keys as this platform prints them, so a Ctrl user never reads a ⌘. Safe in
  // render: the tour only mounts on the client, after the completion check.
  const isMac = isApplePlatform();
  const launcherKeys = chordLabel(launcherBinding, isMac);

  /**
   * Step 4's card for 'ready' and 'off'. With something answering, how to
   * ask. On the desktop Ask is up for the tour (sub-step C summoned it) and
   * closes when the tour ends, since it starts closed (sidebar-store
   * ASK_OPEN_DEFAULT), so the card names every way back to it: the Ask button,
   * the chord as bound (chordLabel, so a rebinding reads right), and `?` in the
   * dock. The button hides while Ask shows, so this card, which shows beside
   * Ask, says when it is there and where: once Ask is closed, at the end of the
   * date row. On the phone the step has just switched to the Ask tab, where the
   * dock's bar IS the box and there is no chord to press. With AI off, that it
   * stays off and where it comes back, never an invitation.
   */
  const aiCard = shownAIStep === 'ready'
    ? {
        title: 'Your AI is ready',
        body: isMobile
          ? 'Type in the bar below to ask about your day.'
          : `When Ask is closed, open it with the Ask button at the end of the date row or ${chordLabel(askKeys, isMac)}, or type ? in the dock, to ask about your day.`,
      }
    : { title: TOUR_AI_OFF_TITLE, body: TOUR_AI_OFF_BODY };

  // ─── Step 1: Welcome ────────────────────────────────────────────────────────
  if (step === 1) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center">
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />

        <div className={cn('relative z-10 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-300', exitClass)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-8 flex flex-col items-center text-center gap-6">
            <div className="relative">
              <Image
                src="/icons/icon-192.png"
                alt="dsul"
                width={80}
                height={80}
                className="rounded-2xl shadow-lg"
              />
            </div>

            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">Welcome to dsul ⚡</h1>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Your calm space to plan the day.
                <br />
                Takes a few seconds to get started.
              </p>
            </div>

            <div className="w-full flex items-center justify-between">
              <SkipButton onSkip={handleSkip} />
              <Button
                className="gap-2"
                onClick={() => setStep(2)}
              >
                Let&apos;s go
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>

            <ProgressDots current={1} total={4} />
          </div>
        </div>
      </div>
    );
  }

  // ─── Step 2: First Task ─────────────────────────────────────────────────────
  if (step === 2) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center">
        <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" />

        <div className={cn('relative z-10 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-300', exitClass)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-8 flex flex-col gap-6">
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                What&apos;s one thing you want to do today?
              </h2>
              <p className="text-xs text-muted-foreground">Just one. We&apos;ll build from there.</p>
            </div>

            <Input
              ref={inputRef}
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="Walk the dog, call the dentist, anything..."
              className="text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateTask();
              }}
              disabled={isCreatingTask}
            />

            <div className="flex items-center justify-between">
              <BackButton onBack={handleBack} />
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep(3)}
                  disabled={isCreatingTask}
                >
                  Skip
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreateTask}
                  disabled={isCreatingTask}
                >
                  {isCreatingTask ? 'Adding...' : 'Add task →'}
                </Button>
              </div>
            </div>

            <div className="flex justify-center">
              <ProgressDots current={2} total={4} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Step 3: Tour Layout ────────────────────────────────────────────────────
  if (step === 3) {
    // The last card's button ends the tour when there is no step 4.
    const lastLabel = aiStep === null ? 'Got it →' : 'Next →';

    // Mobile: two sub-steps (tasks tab, then schedule tab)
    if (isMobile) {
      const mobileContent = {
        A: {
          title: 'Your tasks live here',
          // Names the control under the spotlight, which is also the answer to
          // the question the old copy left open ("head to Schedule": how?).
          // Only step A says it: the card is spotlighted on all three, and
          // repeating it each time reads as the tour losing track.
          //
          // Describes the control rather than telling the user to press it: the
          // cutout is sealed while the tour is up (blockTarget below), so an
          // instruction to tap now would be an instruction that does nothing.
          description: canChat
            ? 'The mode button in the dock is how you move between Braindump, Today and Ask.'
            : 'The mode button in the dock is how you move between Braindump and Today.',
        },
        B: {
          title: 'Plan your day',
          description: 'Drag tasks here to block time, or tap a time slot to add one.',
        },
      };
      const mc = mobileContent[mobileSubStep];
      const mobileSubIndex = mobileSubStep === 'A' ? 0 : 1;

      return (
        <div className="fixed inset-0 z-[100] pointer-events-none">
          <SpotlightOverlay rect={spotlightRect} onClick={handleNext} blockTarget />
          <div
            className="absolute left-4 right-4 pointer-events-auto animate-in fade-in slide-in-from-bottom-4 duration-300"
            style={MOBILE_CARD_ABOVE_DOCK}
          >
            <div className="bg-card border border-border rounded-xl shadow-xl p-4 flex flex-col gap-3">
              <p className="text-sm text-foreground font-medium">{mc.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{mc.description}</p>
              <div className="flex items-center justify-between">
                <BackButton onBack={handleBack} />
                <Button size="sm" onClick={handleNext}>
                  {mobileSubStep === 'B' ? lastLabel : 'Next'}
                </Button>
              </div>
              <div className="flex justify-center gap-1">
                {[0, 1].map((i) => (
                  <div
                    key={i}
                    className={cn(
                      'rounded-full transition-all',
                      i === mobileSubIndex ? 'w-3 h-1.5 bg-primary' : 'w-1.5 h-1.5 bg-muted-foreground/30'
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Desktop: 3 sub-steps
    const subStepContent = {
      A: {
        title: 'Your tasks & habits',
        description: 'Your tasks and habits live here. Drag them to the timeline to plan your day.',
        position: 'left-[320px] top-1/2 -translate-y-1/2',
      },
      B: {
        title: 'Plan your day',
        description: 'Drag tasks here to plan your day.',
        position: 'left-1/2 -translate-x-1/2 top-24',
      },
      // With AI, Ask in the right rail (summoned for this step, then put
      // back), and the card beside its 420px column; without, the dock.
      C: canChat
        ? {
            title: 'Ask',
            description: 'Ask anything here, or open an item to talk about it. It knows your tasks, habits and projects.',
            position: 'right-[452px] top-1/2 -translate-y-1/2',
          }
        : {
            title: 'Your dock',
            description: `Add, search and run commands from here. ${launcherKeys} works anywhere.`,
            position: 'right-[340px] top-1/2 -translate-y-1/2',
          },
    };

    const current = subStepContent[desktopSubStep];
    const subStepIndex = desktopSubStep === 'A' ? 0 : desktopSubStep === 'B' ? 1 : 2;
    // A sits right of the sidebar, C left of the dock, anchored to the live
    // spotlight rect; B stays centered via its static class.
    const anchorStyle =
      desktopSubStep === 'A' ? cardAnchor('right') : desktopSubStep === 'C' ? cardAnchor('left') : undefined;

    return (
      <div className="fixed inset-0 z-[100] pointer-events-none">
        <SpotlightOverlay rect={spotlightRect} onClick={handleNext} />
        <div
          className={cn(
            'absolute pointer-events-auto animate-in fade-in zoom-in-95 duration-200',
            !anchorStyle && current.position
          )}
          style={anchorStyle}
        >
          <div className="bg-card border border-border rounded-xl shadow-2xl p-4 w-64 flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">{current.title}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{current.description}</p>
            <div className="flex items-center justify-between">
              <BackButton onBack={handleBack} />
              <Button size="sm" onClick={handleNext}>
                {desktopSubStep === 'C' ? lastLabel : 'Next'}
              </Button>
            </div>
            <div className="flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-full transition-all',
                    i === subStepIndex ? 'w-3 h-1.5 bg-primary' : 'w-1.5 h-1.5 bg-muted-foreground/30'
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Step 4: AI (coach mark) ────────────────────────────────────────────────
  // Every variant is a dialog with its title focused (the effect above) and
  // Tab kept inside it. Neither wrapper fades in: the lime button and the lime
  // dot would fade through the wrapper's opacity (CLAUDE.md), so the card only
  // zooms (desktop) or slides (phone) in.
  if (step === 4) {
    const dialogProps = {
      ref: cardRef,
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
      'aria-describedby': bodyId,
      'data-testid': 'tour-ai-card',
      'data-tour-ai': shownAIStep ?? undefined,
    } as const;
    const cardTitle = (text: string) => (
      <h2 ref={titleRef} id={titleId} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
        {text}
      </h2>
    );

    if (shownAIStep === 'invite') {
      /**
       * The invitation (F01, F02): what AI could do, two things the person
       * could ask built from their own planner, and three ways out. The card
       * carries its own height cap, and only its words scroll inside it, so
       * Set up AI, Not now, No AI, thanks and Back stay on screen however
       * little room there is.
       */
      const inviteCard = (maxHeight: CSSProperties['maxHeight'], className?: string) => (
        <div
          {...dialogProps}
          className={cn('bg-card border border-border rounded-2xl shadow-2xl p-4 flex flex-col gap-3', className)}
          style={{ maxHeight }}
        >
          <div data-tour-ai-content="" className="min-h-0 overflow-y-auto flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              {cardTitle(TOUR_AI_TITLE)}
              <p id={bodyId} className="text-xs text-muted-foreground leading-relaxed">{TOUR_AI_BODY}</p>
            </div>
            {previews.length > 0 && (
              <section
                aria-labelledby={previewsId}
                data-testid="tour-previews"
                className="rounded-lg bg-surface-3 p-3 flex flex-col gap-3"
              >
                <h3 id={previewsId} className={ASK_SECTION_HEADING}>{TOUR_AI_PREVIEWS_HEADING}</h3>
                <ul className="flex flex-col gap-3">
                  {previews.map((p) => {
                    // The setup column's rows (ask-setup.tsx SetupPreviews), with
                    // the same glyphs, so a preview here is the row setup opens
                    // on. Inked deeper than the column's (F01, F02): the well is
                    // grey, where muted ink reads at about 2.6:1 and the AI's
                    // honey at less, so the words take secondary ink and the
                    // glyph the deeper amber the sunrise bar uses for the same
                    // reason (globals.css --sunrise-glyph).
                    const Icon = OPENER_ICONS[p.id] ?? MessageCircle;
                    return (
                      <li key={p.id} data-preview={p.id} className="flex gap-2.5">
                        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-sunrise-glyph" />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <p className="text-sm font-medium text-foreground">“{p.label}”</p>
                          <p className="text-sm leading-snug text-secondary-foreground">{p.description}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-sm leading-snug text-secondary-foreground">{TOUR_AI_CAPTION}</p>
              </section>
            )}
            {isMobile && <p className="text-xs text-muted-foreground">{TOUR_AI_PHONE_LINE}</p>}
          </div>
          <div className="shrink-0 flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Button size="sm" className="w-full" onClick={handleSetUpAI}>
                Set up AI
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void finish(isMobile ? TOUR_LATER_PHONE : TOUR_LATER_DESKTOP)}
                >
                  Not now
                </Button>
                <Button variant="outline" size="sm" onClick={handleNoAI}>
                  No AI, thanks
                </Button>
              </div>
            </div>
            <div className="relative flex items-center">
              <BackButton onBack={handleBack} />
              <div className="absolute left-1/2 -translate-x-1/2">
                <ProgressDots current={4} total={4} />
              </div>
            </div>
          </div>
        </div>
      );

      // Phone: above the dock, whose mode button the card's last line names.
      if (isMobile) {
        return (
          <div className="fixed inset-0 z-[100] pointer-events-none">
            <SpotlightOverlay rect={spotlightRect} blockTarget />
            <div
              className="absolute left-4 right-4 pointer-events-auto animate-in slide-in-from-bottom-4 duration-300"
              style={MOBILE_CARD_ABOVE_DOCK}
            >
              {inviteCard(PHONE_CARD_CAP)}
            </div>
          </div>
        );
      }

      // Desktop: under the key, right edges aligned; top right until it is measured.
      const { maxHeight, ...pos } = cardAnchor('below') ?? {};
      const measured = maxHeight !== undefined;
      return (
        <div className="fixed inset-0 z-[100] pointer-events-none">
          <SpotlightOverlay rect={spotlightRect} blockTarget />
          <div
            className={cn('absolute pointer-events-auto animate-in zoom-in-95 duration-300', !measured && 'right-6 top-20')}
            style={pos}
          >
            {inviteCard(measured ? maxHeight : DESKTOP_CARD_CAP, 'w-80 max-w-[calc(100vw-2rem)]')}
          </div>
        </div>
      );
    }

    const actions = (
      <>
        <div className="flex items-center justify-between">
          <BackButton onBack={handleBack} />
          <Button size="sm" onClick={handleComplete}>
            Got it →
          </Button>
        </div>
        <div className="flex justify-center">
          <ProgressDots current={4} total={4} />
        </div>
      </>
    );

    // Mobile: tooltip card above the dock (on the Ask tab, via the effect, while
    // something answers)
    if (isMobile) {
      return (
        <div className="fixed inset-0 z-[100] pointer-events-none">
          <SpotlightOverlay rect={spotlightRect} blockTarget />
          <div
            className="absolute left-4 right-4 pointer-events-auto animate-in slide-in-from-bottom-4 duration-300"
            style={MOBILE_CARD_ABOVE_DOCK}
          >
            <div {...dialogProps} className="bg-card border border-border rounded-xl shadow-xl p-4 flex flex-col gap-3">
              {cardTitle(aiCard.title)}
              <p id={bodyId} className="text-xs text-muted-foreground leading-relaxed">{aiCard.body}</p>
              {actions}
            </div>
          </div>
        </div>
      );
    }

    // Desktop: non-fullscreen coach mark card to the left of Ask (or the dock)
    const anchor = cardAnchor('left');
    return (
      <div className="fixed inset-0 z-[100] pointer-events-none">
        <SpotlightOverlay rect={spotlightRect} blockTarget />
        <div
          className={cn(
            'absolute pointer-events-auto animate-in zoom-in-95 duration-300',
            // Beside Ask's 420px column (or the dock) until the spotlight is measured.
            !anchor && (shownAIStep === 'ready' ? 'right-[452px]' : 'right-[340px]'),
            !anchor && 'top-1/2 -translate-y-1/2'
          )}
          style={anchor}
        >
          <div {...dialogProps} className="bg-card border border-border rounded-xl shadow-2xl p-4 w-72 flex flex-col gap-3">
            {cardTitle(aiCard.title)}
            <p id={bodyId} className="text-xs text-muted-foreground leading-relaxed">{aiCard.body}</p>
            {actions}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export type { OnboardingTourProps };
