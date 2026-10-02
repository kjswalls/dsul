'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import { ChatComposer } from '@/components/ai/chat-composer';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { chatAssistantLabel } from '@/lib/chat-utils';
import { bindingKey, useRailStore, type ComposerBinding } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/**
 * False inside a RightRail that is hidden under an item (components/ai/rail/
 * right-rail.tsx). Ask stays mounted there so its views keep their text and
 * scroll, but a composer nobody can see must never take a focus request: the
 * item's own composer, or the next view to show, is the one it was for. Nor
 * can it measure itself, so its auto-grow waits for this to turn true.
 */
export const ComposerAwakeContext = createContext(true);

/**
 * The box under every Ask view and the item's conversation: ChatComposer, bound
 * to where its text goes (lib/open-chat.ts `sendFrom` decides what a binding
 * means), with three things every rail composer needs and the phone's dock bar
 * does not:
 *
 *  - ITS TEXT LIVES IN rail-store (`drafts`, by binding key), so a half-typed
 *    message survives the view unmounting: a push, a Back, an item opened over
 *    it. A draft and the conversation it becomes share one key.
 *  - FOCUS ONLY ON REQUEST. It takes focus when a pending request names it, or
 *    names no composer (Ctrl+J, `?`, "Ask AI"), and never because it mounted:
 *    the item's composer mounts on every row click, and stealing the caret each
 *    time would fight the canvas. Deferred past the commit with setTimeout(0),
 *    as Radix's FocusScope defers its own restore, which would otherwise win.
 *  - ESCAPE WITH TEXT ONLY BLURS. It is consumed (preventDefault), so the
 *    rail's Escape and the item panel's (both honour defaultPrevented) do not
 *    also go back, park or close the item over a draft. A second Escape, on
 *    the now-unfocused rail or an empty box, does that.
 *
 * `data-sub-input` is load-bearing in the item panel: the panel spreads its
 * Enter-to-submit onto the whole aside, and the composer leaves an IME's
 * commit Enter alone on purpose (chat-composer.tsx), so without it that Enter
 * would save and close the item.
 */
export function BoundComposer({
  binding,
  className,
  placeholder,
}: {
  binding: ComposerBinding;
  className?: string;
  /** The box's own wording, where the default would mislead ("Reply…" under a conversation). */
  placeholder?: string;
}) {
  const key = bindingKey(binding);
  const text = useRailStore((s) => s.drafts[key] ?? '');
  const pending = useRailStore((s) => s.pendingFocus);
  const awake = useContext(ComposerAwakeContext);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!awake || pending?.target !== 'composer') return;
    if (!useRailStore.getState().consumeFocus('composer', binding)) return;
    // No cleanup clearing this: consuming the request re-runs the effect, and
    // that must not cancel the focus it just claimed.
    setTimeout(() => {
      const field = wrapperRef.current?.querySelector('textarea');
      if (!field?.isConnected) return;
      field.focus({ preventScroll: true });
      // After what is there, so text put in for the user ("Help me start ")
      // is carried on, not typed in front of.
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }, 0);
  }, [awake, pending, binding]);

  return (
    <div
      ref={wrapperRef}
      data-sub-input
      data-ask-composer=""
      className={cn('flex flex-col gap-1', className)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const field = e.target;
        if (!(field instanceof HTMLTextAreaElement) || !field.value.trim()) return;
        e.preventDefault();
        field.blur();
      }}
    >
      <ChatComposer
        variant="panel"
        binding={binding}
        value={text}
        onValueChange={(next) => useRailStore.getState().setDraft(key, next)}
        awake={awake}
        placeholder={placeholder}
      />
      <AnswererLabel className="px-2" />
    </div>
  );
}

/**
 * Who answers, under the box: the connected model's id ("gpt-4o-mini") or the
 * paired agent ("OpenClaw · kirby-1"). Plain text, not a control: 2c turns it
 * into the picker, and until then nothing about it may look clickable (no
 * hover, focus or cursor change). Nothing when nothing answers, which is
 * never, since every composer it sits under mounts behind the gate.
 */
export function AnswererLabel({ className }: { className?: string }) {
  const { target, agentId } = useAICapabilities();
  const model = useAIConnectionStore((s) => s.model?.model ?? null);
  const label = target === 'openclaw' ? chatAssistantLabel('openclaw', agentId) : target === 'model' ? model : null;
  if (!label) return null;
  return (
    <p data-testid="answerer-label" className={cn('truncate text-[11px] text-muted-foreground', className)}>
      {label}
    </p>
  );
}
