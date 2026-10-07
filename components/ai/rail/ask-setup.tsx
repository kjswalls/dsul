'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, MessageCircle } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { OPENER_ICONS } from '@/components/ai/ask/it-works-card';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { ConnectAI } from '@/components/ai/connect/connect-ai';
import { ConnectFix, fixCopy } from '@/components/ai/connect/connect-fix';
import { labelName, useRefreshOnWindowFocus } from '@/components/ai/connect/connect-shared';
import { RailHeader } from '@/components/ai/rail/rail-header';
import { Button } from '@/components/ui/button';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { buildOpenerPreviews } from '@/lib/ai-openers';
import { chooseNoAI } from '@/lib/no-ai';
import { useRailStore } from '@/lib/rail-store';
import { useOpenerContext } from '@/hooks/use-opener-context';

/** How many things it could ask the setup home previews (the desktop column). */
export const SETUP_PREVIEWS = 3;

/**
 * Settings → AI by its alias (`/settings/ai`; the pane's id stays 'beacon',
 * and nothing on screen says it), its key field or its model row ringed
 * (`?focus=`, the settings page routes the id to its pane). The copy for the
 * fix home lives with its card, and is named here as it always was.
 */
export { SETUP_MODEL_HREF, SETUP_SETTINGS_HREF } from '@/components/ai/connect/connect-shared';
export { fixCopy };

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
 *    nothing answers yet. Then the way in, right here: the connect card, its
 *    folds and Good to know (components/ai/connect/connect-ai.tsx).
 *  - Fix home: the saved connection, what is wrong with it in plain words,
 *    a box for a new key, and a fresh check of the key it has
 *    (connect-fix.tsx). A connection with no model picked is fixed in
 *    Settings → AI instead.
 *  - The foot, pinned: "AI is optional. dsul works fully without it." and
 *    No AI, thanks, which hides AI on every device with an Undo in the strip
 *    (lib/no-ai.ts).
 *
 * Nothing in it is lime, and nothing fades in: the column's own width slide
 * is its entrance (CLAUDE.md, the lime accent; right-rail.tsx slides too).
 * Escape closes it, docked or overlaid: unlike Ask it is not a place to rest,
 * except from a key box with a key in it, which keeps its own Escape.
 * Focus, lost when the key that opened it hid, goes to its heading.
 *
 * It stays mounted, hidden and inert, under an item opened over it (the
 * shell's `setupMounted`), so a key left in a box, and what was said about
 * it, are still there when the item closes. While hidden it takes no focus,
 * hears no Escape and asks the server nothing.
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

  // In the desktop app a sign-in finishes in the browser: the window asks
  // again when it comes back, while this shows.
  useRefreshOnWindowFocus(visible);

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
              // The live row's glyph (it-works-card.tsx), so a preview keeps it once it can be asked.
              const Icon = OPENER_ICONS[p.id] ?? MessageCircle;
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
      <ConnectAI host="column" />
    </>
  );
}

/**
 * A saved model that needs attention. A key turned down, or one dsul can't
 * read, is fixed in place (ConnectFix); a connection with no model picked
 * says so, and the way to its model row in Settings → AI. One that works
 * again has nothing to fix: the column is becoming Ask.
 */
function FixHome() {
  const model = useAIConnectionStore((s) => s.model);
  if (!model) return null;
  if (model.status === 'failing') return <ConnectFix model={model} />;
  if (model.model) return null;
  const copy = fixCopy(model);
  return (
    <section data-testid="setup-fix" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{labelName(model.provider, model.baseUrl)}</h3>
        <p className="text-xs text-muted-foreground">{copy.status}</p>
      </div>
      <div className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2.5">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
        <p className="text-sm leading-snug text-foreground">{copy.note}</p>
      </div>
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={copy.href}>{copy.action}</Link>
      </Button>
    </section>
  );
}
