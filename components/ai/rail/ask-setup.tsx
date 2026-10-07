'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CalendarDays,
  CalendarRange,
  CircleAlert,
  History,
  Hourglass,
  ListChecks,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { RailHeader } from '@/components/ai/rail/rail-header';
import { Button } from '@/components/ui/button';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { buildOpenerPreviews } from '@/lib/ai-openers';
import { PROVIDER_META, type ModelConnectionView } from '@/lib/ai-types';
import { chooseNoAI } from '@/lib/no-ai';
import { useRailStore } from '@/lib/rail-store';
import { useOpenerContext } from '@/hooks/use-opener-context';

/** How many things it could ask the setup home previews (the desktop column). */
export const SETUP_PREVIEWS = 3;

/**
 * Where the setup column sends someone to connect, until the column carries
 * its own connect card: Settings → AI, its key field ringed (`?focus=`, the
 * settings page routes the id to its pane). The pane's id is permanent, so
 * the path keeps its old lowercase name; nothing on screen says it.
 */
export const SETUP_SETTINGS_HREF = '/settings/beacon?focus=beacon.apiKey';
/** A saved connection with no model picked: the model row. */
export const SETUP_MODEL_HREF = '/settings/beacon?focus=beacon.model';

/** Each preview's glyph, beside its quoted words; a later opener falls back to a speech bubble. */
const PREVIEW_ICONS: Record<string, LucideIcon> = {
  plan: CalendarDays,
  triage: ListChecks,
  'plan-tomorrow': CalendarDays,
  'let-go': Hourglass,
  review: History,
  reflect: CalendarRange,
};

const park = () => useRailStore.getState().park();

/** A field being typed into keeps its own Escape. */
function typing(el: Element): boolean {
  return (
    ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== '') ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/**
 * The right column while nothing answers but the AI gate offers to set AI up
 * (`askInvite`, the unlit "Set up AI" key) or to fix a saved model that
 * stopped working (`askFix`, "Fix AI"). Opened only by the unlit key or
 * Ctrl+J (lib/open-chat.ts toggleRail), never kept open across a reload, and
 * gone the moment something answers: then the column is Ask itself
 * (rail-store `railMode`, 'setup' becoming 'ask' under the same summon).
 *
 * Its own component, not a view of Ask: Ask home wakes the conversation list
 * and the agent columns, and neither has anything to say before a model does.
 * It never wears `data-rail-view` or `data-ask-home`, which mean Ask.
 *
 *  - Header: the unlit mark and the word the key wore, ✕ only (no History,
 *    no New chat: there are no chats yet).
 *  - Setup home: Ask's own greeting, then what the person could ask now, the
 *    chips Ask would offer today as quoted previews (lib/ai-openers.ts
 *    `buildOpenerPreviews`): no hover, no arrows, nothing to press, since
 *    nothing answers yet. Then the way in, which is Settings → AI for now.
 *  - Fix home: the saved connection, what is wrong with it in plain words,
 *    the way to Settings → AI, and a fresh check of the key it has.
 *  - The foot, pinned: "AI is optional. dsul works fully without it." and
 *    No AI, thanks, which hides AI on every device with an Undo in the strip
 *    (lib/no-ai.ts).
 *
 * Nothing in it is lime, and nothing fades in: the column's own width slide
 * is its entrance (CLAUDE.md, the lime accent; right-rail.tsx slides too).
 * Escape closes it, docked or overlaid: unlike Ask it is not a place to rest.
 * Focus, lost when the key that opened it hid, goes to its heading.
 */
export function AskSetup({
  visible,
  leaving = false,
}: {
  visible: boolean;
  /** Easing out of a docked column: still painted, inert, listening to nothing. */
  leaving?: boolean;
}) {
  const { askInvite, askFix } = useAICapabilities();
  // Which home it is. While it eases out after No AI, both are false: it
  // keeps the one it showed (React's "information from previous renders").
  const live = askFix ? 'fix' : askInvite ? 'invite' : null;
  const [shown, setShown] = useState<'invite' | 'fix'>(live ?? 'invite');
  if (live !== null && live !== shown) setShown(live);
  const kind = live ?? shown;
  const word = kind === 'fix' ? 'Fix AI' : 'Set up AI';
  const asideRef = useRef<HTMLElement>(null);

  // There is no box here. A composer request (Ask's, made just before the
  // gate changed) would wait for the next box to mount anywhere and take the
  // caret there unasked, so it is dropped while this shows.
  const strayBoxRequest = useRailStore((s) => visible && s.pendingFocus?.target === 'composer');
  useEffect(() => {
    if (strayBoxRequest) useRailStore.getState().consumeFocus('composer');
  }, [strayBoxRequest]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      const el = document.activeElement;
      if (el && el !== document.body && (!el.closest('[data-rail]') || typing(el))) return;
      park();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  // Shown by the key or Ctrl+J: the key hid as the column opened, so focus
  // that was on it is lost; it goes to the heading. Focus the user has
  // elsewhere (a row on the canvas, Ctrl+J pressed from it) stays put.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      const root = asideRef.current;
      const active = document.activeElement;
      if (!root || root.hidden) return;
      const lost = !active || active === document.body || !!active.closest('[hidden], [inert]');
      if (lost) root.querySelector<HTMLElement>('[data-ask-heading]')?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <aside
      ref={asideRef}
      data-ask-setup={kind}
      aria-label={word}
      hidden={!visible && !leaving}
      inert={!visible}
      className="flex h-full w-[420px] flex-col overflow-hidden outline-none"
    >
      <RailHeader
        heading={
          <>
            <AskMark lit={false} />
            <span className="truncate">{word}</span>
          </>
        }
        onClose={park}
        closeTestId="setup-close"
      />
      <div data-ask-setup-scroller="" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-1 pb-5">
        <AskGreeting variant="home" />
        {kind === 'fix' ? <FixHome /> : <SetupHome />}
      </div>
      <div
        data-ask-setup-foot=""
        className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground"
      >
        <span className="min-w-0">AI is optional. dsul works fully without it.</span>
        <button
          type="button"
          data-testid="no-ai-thanks"
          onClick={() => void chooseNoAI()}
          className="shrink-0 rounded-md px-1.5 py-1 text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          No AI, thanks
        </button>
      </div>
    </aside>
  );
}

/** Nothing connected: what AI could do with this planner today, and the way in. */
function SetupHome() {
  const headingId = useId();
  const { ctx, minutesNow } = useOpenerContext();
  const previews = useMemo(
    () => (ctx && minutesNow !== null ? buildOpenerPreviews(ctx, { max: SETUP_PREVIEWS, minutesNow }) : []),
    [ctx, minutesNow]
  );

  return (
    <>
      {previews.length > 0 && (
        <section aria-labelledby={headingId} data-testid="setup-previews" className="flex flex-col gap-3">
          <h3 id={headingId} className={ASK_SECTION_HEADING}>
            What you could ask now
          </h3>
          <ul className="flex flex-col gap-3">
            {previews.map((p) => {
              const Icon = PREVIEW_ICONS[p.id] ?? MessageCircle;
              return (
                <li key={p.id} data-preview={p.id} className="flex gap-2.5">
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ai" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm font-medium text-foreground">“{p.label}”</p>
                    <p className="text-sm leading-snug text-muted-foreground">{p.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">Each becomes one click once AI is connected.</p>
        </section>
      )}
      <section data-testid="setup-connect" className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-4">
        <h3 className="text-sm font-medium text-foreground">Connect AI</h3>
        <p className="text-sm leading-snug text-muted-foreground">
          Use a free key from Google, a key you already have, or your own OpenClaw agent. It takes about a minute.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1 self-start">
          <Link href={SETUP_SETTINGS_HREF}>Set up in Settings → AI</Link>
        </Button>
      </section>
    </>
  );
}

/** Who turned the key down, as a sentence's subject. */
function providerName(model: ModelConnectionView): string {
  return model.provider === 'custom' ? 'Your service' : PROVIDER_META[model.provider].label;
}

/**
 * What is wrong with the saved connection, in plain words. `askFix` covers a
 * key the provider stopped accepting, a key dsul can no longer read, and a
 * connection saved with no model picked. An OpenRouter sign-in never had a
 * key to paste, so its copy says sign-in and "connect it again" (Settings →
 * AI offers Sign in again on the web, a key in the desktop app).
 *
 * `check` labels the fresh check and `still` is what it says when the
 * provider still turns it down.
 */
export function fixCopy(model: ModelConnectionView): {
  status: string;
  note: string;
  href: string;
  action: string;
  check: string;
  still: string;
} {
  const signIn = model.authMethod === 'oauth';
  const check = signIn ? 'Check again' : 'Check the key again';
  const still = signIn
    ? `${providerName(model)} still turns it down. Connecting again in Settings → AI fixes it.`
    : `${providerName(model)} still turns it down. A new key in Settings → AI fixes it.`;
  if (model.status !== 'failing') {
    return {
      status: 'No model picked',
      note: 'No model is picked yet, so AI can’t answer. Pick one in Settings → AI.',
      href: SETUP_MODEL_HREF,
      action: 'Pick a model in Settings → AI',
      check,
      still,
    };
  }
  if (model.problem === 'key_unreadable') {
    return {
      status: 'Needs attention',
      note: signIn
        ? 'dsul can’t read your saved sign-in anymore, so AI can’t answer right now. Connect it again in Settings → AI and Ask picks up where it left off.'
        : 'dsul can’t read your saved key anymore, so AI can’t answer right now. Paste it again in Settings → AI and Ask picks up where it left off.',
      href: SETUP_SETTINGS_HREF,
      action: 'Fix it in Settings → AI',
      check,
      still,
    };
  }
  return {
    status: 'Needs attention',
    note: signIn
      ? `${providerName(model)} stopped accepting your sign-in, so AI can’t answer right now. Connect it again in Settings → AI and Ask picks up where it left off.`
      : `${providerName(model)} stopped accepting your key, so AI can’t answer right now. Paste a new one in Settings → AI and Ask picks up where it left off.`,
    href: SETUP_SETTINGS_HREF,
    action: 'Fix it in Settings → AI',
    check,
    still,
  };
}

/** A saved model that needs attention: what is wrong, and the way to fix it. */
function FixHome() {
  const model = useAIConnectionStore((s) => s.model);
  const busy = useAIConnectionStore((s) => s.busy);
  const [still, setStill] = useState<string | null>(null);
  if (!model) return null;
  const copy = fixCopy(model);
  // A fresh check only helps a key the provider turned down: an unreadable
  // key reads no better a second time, and a missing model is not a key.
  const canRecheck = model.status === 'failing' && model.problem !== 'key_unreadable';
  const title = model.provider === 'custom' ? 'Your own service' : PROVIDER_META[model.provider].label;

  const recheck = async () => {
    // Pressed again while a check is out: the button stays focusable while
    // busy (a focused button that goes `disabled` drops focus to <body>).
    if (useAIConnectionStore.getState().busy !== null) return;
    setStill(null);
    const result = await useAIConnectionStore.getState().recheck();
    if (result.ok) {
      // The route answers a check it could make with the connection as it now
      // stands, so a key still turned down is an ok answer whose status still
      // reads failing. Working again, the gate lights and the column becomes
      // Ask on its own; anything else rewrites the note above by itself.
      const now = useAIConnectionStore.getState().model;
      if (now?.status === 'failing' && now.problem === 'key_rejected') setStill(copy.still);
      return;
    }
    setStill(result.code === 'key_rejected' ? copy.still : 'Couldn’t check it just now. Try again in a moment.');
  };

  return (
    <section data-testid="setup-fix" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{copy.status}</p>
      </div>
      <div className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2.5">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
        <p className="text-sm leading-snug text-foreground">{copy.note}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={copy.href}>{copy.action}</Link>
        </Button>
        {canRecheck && (
          <button
            type="button"
            data-testid="setup-recheck"
            aria-disabled={busy !== null || undefined}
            onClick={() => void recheck()}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-default aria-disabled:hover:text-muted-foreground"
          >
            {busy === 'recheck' ? 'Checking…' : copy.check}
          </button>
        )}
      </div>
      {still && (
        <p role="status" className="text-xs text-muted-foreground">
          {still}
        </p>
      )}
    </section>
  );
}
