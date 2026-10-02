'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ArrowRight, ArrowLeft, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { isApplePlatform } from '@/lib/commands/keys';
import { setOnboardingComplete } from '@/lib/user-profile';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
import Image from 'next/image';

const SPOTLIGHT_PADDING = 8;

/**
 * @param revision re-measures when the selector has NOT changed but the target
 *   may have moved. All three mobile steps spotlight the same mode card while
 *   switching the tab underneath it, and the dock the card rides is only as tall
 *   as its notice stack — one notice arriving or clearing between steps slides
 *   the card without the selector changing a character, and the cutout would sit
 *   a few px off the control it is pointing at.
 */
function useSpotlightRect(selector: string | null, revision?: string) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selector) { setRect(null); return; }

    const measure = () => {
      const el = document.querySelector(selector);
      if (el) setRect(el.getBoundingClientRect());
      else setRect(null);
    };

    measure(); // immediate pass
    // Re-measure after CSS animations settle (sidebar open, tab switch, etc.)
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', measure);
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
 * (hooks/use-toast-anchor.ts) — the same number the undo toast floats above, and
 * it already tracks the safe-area inset and the notice stack. The fallback only
 * covers the frame before the dock's first measurement lands.
 */
const MOBILE_CARD_ABOVE_DOCK = { bottom: 'var(--toast-bottom, 96px)' } as const;

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
 *   spotlight panels, and the retired mobile tab bar was idempotent — a tap fell
 *   through to `setActiveTab(<the tab the step had just switched to>)`. The
 *   mobile steps now spotlight the dock's mode card, which is a Drawer trigger:
 *   the sheet portals to body at z-50, this overlay is z-[100], so a tap through
 *   the hole opens a modal UNDER a scrim the user cannot dismiss, and its rows
 *   land on the catcher rather than the sheet. The step's own Next/Back are the
 *   only controls while the tour owns the screen.
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
  onOpenSettings: () => void;
  onExpandChat?: () => void;
  onCollapseChat?: () => void;
  onSetActiveTab?: (tab: string) => void;
}

type Step = 1 | 2 | 3 | 4;

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
      <ArrowLeft className="h-3.5 w-3.5" />
      Back
    </button>
  );
}

export function OnboardingTour({ userId, onComplete, onOpenSettings, onExpandChat, onCollapseChat, onSetActiveTab }: OnboardingTourProps) {
  const [step, setStep] = useState<Step>(1);
  const [taskInput, setTaskInput] = useState('');
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [desktopSubStep, setDesktopSubStep] = useState<'A' | 'B' | 'C'>('A');
  const [mobileSubStep, setMobileSubStep] = useState<'A' | 'B'>('A');
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  /**
   * Whether anything can answer in chat. The tour never walks someone to a
   * chat surface that is not there: without it, sub-step C is the dock and
   * step 4 says AI is optional. The flow and its dots are the same either way;
   * the spotlight is Ask's column (`right-sidebar`, which exists only while
   * something answers) with AI, and the capture dock (`dock`) without.
   */
  const { canChat } = useAICapabilities();
  // Spotlight selector based on current step/sub-step
  const spotlightSelector = (() => {
    if (step === 3) {
      if (!isMobile) {
        if (desktopSubStep === 'A') return '[data-tour="left-sidebar"]';
        if (desktopSubStep === 'B') return '[data-tour="timeline"]';
        if (desktopSubStep === 'C') {
          return canChat ? '[data-tour="right-sidebar"]' : '[data-tour="dock"]';
        }
      } else {
        // Every mobile step spotlights the DOCK'S MODE CARD, not a per-surface
        // target. The three-tab bar these steps used to point at is gone; its
        // `tab-*` handles moved onto the switcher sheet's entries, which are
        // only in the DOM while that sheet is open — a spotlight there would cut
        // a hole in the overlay around nothing. The card is on screen for every
        // step, and it is what the effects below have just moved. It is also a
        // Drawer trigger, which is why the mobile steps seal the cutout with
        // `blockTarget` — see SpotlightOverlay.
        if (mobileSubStep === 'A' || mobileSubStep === 'B') return '[data-tour="mode-card"]';
      }
    }
    if (step === 4) {
      if (isMobile) return '[data-tour="mode-card"]';
      return canChat ? '[data-tour="right-sidebar"]' : '[data-tour="dock"]';
    }
    return null;
  })();
  
  const spotlightRect = useSpotlightRect(
    spotlightSelector,
    `${step}-${desktopSubStep}-${mobileSubStep}`
  );

  // Anchor a card just outside the spotlight target, computed from its live
  // rect — replaces hardcoded left/right offsets that broke when the sidebar
  // width changed. Falls back to null (callers keep a static class) if no rect.
  // The card sits beside its target on the preferred side, flips when that
  // side has no room for it, and goes above a target too wide for either —
  // a layout (lib/layout-themes.ts) can put the braindump at the right edge or
  // lay the dock across the whole foot of the screen.
  const cardAnchor = (side: 'left' | 'right') => {
    if (!spotlightRect) return undefined;
    const CARD_W = 288 + 16;
    const iw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const ih = typeof window !== 'undefined' ? window.innerHeight : 0;
    const roomRight = iw - spotlightRect.right - 16;
    const roomLeft = spotlightRect.left - 16;
    let place: 'left' | 'right' | 'above' = side;
    if (place === 'right' && roomRight < CARD_W) place = roomLeft >= CARD_W ? 'left' : 'above';
    else if (place === 'left' && roomLeft < CARD_W) place = roomRight >= CARD_W ? 'right' : 'above';
    if (place === 'above') {
      return { left: '50%', bottom: ih - spotlightRect.top + 16, transform: 'translateX(-50%)' as const };
    }
    const top = spotlightRect.top + spotlightRect.height / 2;
    return place === 'right'
      ? { left: spotlightRect.right + 16, top, transform: 'translateY(-50%)' as const }
      : { right: iw - spotlightRect.left + 16, top, transform: 'translateY(-50%)' as const };
  };

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

  // Show Ask for desktop sub-step C, and put it back after. Only when chat
  // exists: otherwise C is about the dock. The shell wires these to a summon
  // that never persists and a park (app-shell.tsx), so the tour never writes
  // the user's `askOpen`, and nothing is left armed to spring open later.
  useEffect(() => {
    if (step === 3 && !isMobile) {
      if (desktopSubStep === 'C' && canChat) {
        onExpandChatRef.current?.();
      } else {
        onCollapseChatRef.current?.();
      }
    }
  }, [step, isMobile, desktopSubStep, canChat]);

  // Switch to tasks tab when reaching mobile sub-step A (step 3)
  useEffect(() => {
    if (step === 3 && isMobile) {
      if (mobileSubStep === 'A') {
        onSetActiveTabRef.current?.('braindump');
      } else if (mobileSubStep === 'B') {
        onSetActiveTabRef.current?.('today');
      }
    }
  }, [step, isMobile, mobileSubStep]);

  // Switch to chat tab when reaching step 4 on mobile, when there is one. With
  // nothing to answer the phone has no chat tab (lib/mobile-nav-store.ts), and
  // the step stays on Today, pointing at the mode card it already lit.
  useEffect(() => {
    if (step === 4 && isMobile && canChat) {
      onSetActiveTabRef.current?.('chat');
    }
  }, [step, isMobile, canChat]);

  const advanceWithExit = useCallback((fn: () => void) => {
    setIsExiting(true);
    setTimeout(() => {
      setIsExiting(false);
      fn();
    }, 280);
  }, []);

  const handleComplete = useCallback(async () => {
    onCollapseChatRef.current?.();
    onSetActiveTabRef.current?.('braindump');
    setIsVisible(false);
    toast.success("You're all set ✨ One thing at a time — you've got this.", {
      description: 'Tip: replay this tour anytime from Settings.',
      duration: 5000,
    });
    await setOnboardingComplete(userId);
    onComplete();
  }, [userId, onComplete]);

  const handleNext = useCallback(() => {
    if (step === 3 && !isMobile) {
      if (desktopSubStep === 'A') { setDesktopSubStep('B'); return; }
      if (desktopSubStep === 'B') { setDesktopSubStep('C'); return; }
    }
    if (step === 3 && isMobile) {
      if (mobileSubStep === 'A') { setMobileSubStep('B'); return; }
    }
    if (step < 4) {
      setStep((s) => (s + 1) as Step);
    } else if (step === 4) {
      handleComplete();
    }
  }, [step, isMobile, desktopSubStep, mobileSubStep, handleComplete]);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (step === 2) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        handleNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [step, handleNext]);

  const handleSkip = async () => {
    onCollapseChatRef.current?.();
    onSetActiveTabRef.current?.('braindump');
    setIsVisible(false);
    await setOnboardingComplete(userId);
    onComplete();
  };

  const handleCreateTask = async () => {
    if (isCreatingTask) return;
    setIsCreatingTask(true);

    if (taskInput.trim()) {
      // Add as unscheduled task (no timeBucket, no startDate) → appears in sidebar
      addTask({ title: taskInput.trim() });
      try {
        confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ['#a855f7', '#6366f1', '#ec4899'] });
      } catch (_) {
        // confetti may fail on some mobile browsers — non-fatal
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
  const launcherKeys = isMac ? '⌘K' : 'Ctrl+K';
  const askKeys = isMac ? '⌘↵' : 'Ctrl↵';

  /**
   * Step 4's card. Without anything to answer it says AI is optional and where
   * to connect one, never that something is missing. With it, how to ask. On
   * the phone the step has just switched to the chat tab, where the dock's bar
   * IS the chat field and there is no ⌘↵ to press.
   */
  const aiCard = canChat
    ? {
        title: 'Your AI is ready',
        body: isMobile
          ? 'Type in the bar below to ask about your day.'
          : `Type ? in the dock, or press ${askKeys}, to ask about your day.`,
      }
    : {
        title: 'Bring your own AI (optional)',
        body: 'dsul works without AI. If you want help planning, connect a model you already use, or OpenClaw, in Settings.',
      };

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
              <p className="text-xs text-muted-foreground">Just one — we&apos;ll build from there.</p>
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

  // ─── Step 3: Tour Layout ──────────────────────────────��─────────────────────
  if (step === 3) {
    // Mobile: two sub-steps (tasks tab, then schedule tab)
    if (isMobile) {
      const mobileContent = {
        A: {
          title: 'Your tasks live here',
          // Names the control under the spotlight, which is also the answer to
          // the question the old copy left open ("head to Schedule" — how?).
          // Only step A says it: the card is spotlighted on all three, and
          // repeating it each time reads as the tour losing track.
          //
          // Describes the control rather than telling the user to press it: the
          // cutout is sealed while the tour is up (blockTarget below), so an
          // instruction to tap now would be an instruction that does nothing.
          description: canChat
            ? 'The mode button in the dock is how you move between Braindump, Today and AI.'
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
                  {mobileSubStep === 'B' ? 'Next →' : 'Next'}
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
      C: {
        ...(canChat
          ? {
              title: 'Your AI chat',
              description: 'Ask anything here. It knows your tasks, habits and projects.',
            }
          : {
              title: 'Your dock',
              description: `Add, search and run commands from here. ${launcherKeys} works anywhere.`,
            }),
        position: 'right-[340px] top-1/2 -translate-y-1/2',
      },
    };

    const current = subStepContent[desktopSubStep];
    const subStepIndex = desktopSubStep === 'A' ? 0 : desktopSubStep === 'B' ? 1 : 2;
    // A sits right of the sidebar, C left of the dock — anchored to the live
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
                {desktopSubStep === 'C' ? 'Next →' : 'Next'}
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

  // ─── Step 4: AI Chat (coach mark) ───────────────────────────────────────────
  if (step === 4) {
    // Mobile: tooltip card above the dock (on the chat tab, via the effect, when
    // there is one)
    if (isMobile) {
      return (
        <div className="fixed inset-0 z-[100] pointer-events-none">
          <SpotlightOverlay rect={spotlightRect} blockTarget />
          <div
            className="absolute left-4 right-4 pointer-events-auto animate-in fade-in slide-in-from-bottom-4 duration-300"
            style={MOBILE_CARD_ABOVE_DOCK}
          >
            <div className="bg-card border border-border rounded-xl shadow-xl p-4 flex flex-col gap-3">
              <p className="text-sm font-medium text-foreground">{aiCard.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{aiCard.body}</p>
              <div className="flex items-center justify-between">
                <BackButton onBack={handleBack} />
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      handleComplete();
                      setTimeout(() => onOpenSettings(), 300);
                    }}
                    className="gap-1.5"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Settings
                  </Button>
                  <Button size="sm" onClick={handleComplete}>
                    Got it →
                  </Button>
                </div>
              </div>
              <div className="flex justify-center">
                <ProgressDots current={4} total={4} />
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Desktop: non-fullscreen coach mark card to the left of chat sidebar
    return (
      <div className="fixed inset-0 z-[100] pointer-events-none">
        <SpotlightOverlay rect={spotlightRect} />
        <div
          className={cn(
            'absolute pointer-events-auto animate-in fade-in zoom-in-95 duration-300',
            !cardAnchor('left') && 'right-[340px] top-1/2 -translate-y-1/2'
          )}
          style={cardAnchor('left')}
        >
          <div className="bg-card border border-border rounded-xl shadow-2xl p-4 w-72 flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">{aiCard.title}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{aiCard.body}</p>
            <div className="flex items-center justify-between">
              <BackButton onBack={handleBack} />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleComplete();
                    setTimeout(() => onOpenSettings(), 300);
                  }}
                  className="gap-1.5"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </Button>
                <Button size="sm" onClick={handleComplete}>
                  Got it →
                </Button>
              </div>
            </div>
            <div className="flex justify-center">
              <ProgressDots current={4} total={4} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export type { OnboardingTourProps };
