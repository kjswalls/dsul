'use client';

import { useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

import { AskMarkIcon } from '@/components/ai/ask-mark';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';
import { AI_SETTINGS_PATH, PROVIDER_META, type ModelProviderId } from '@/lib/ai-types';

/**
 * The AI's two dock lines: "your key stopped working" and "AI now uses your own
 * model". Both are about something with no object on screen (the AI surfaces
 * they would sit on are exactly what the gate has hidden, or, when OpenClaw
 * answers in the model's place, ones that name OpenClaw and never the model), so
 * neither names an anchor and both live on the dock. One source feeds both shells: `useDockNotices`
 * renders the desktop strip and the phone's.
 *
 * Its own file, not a hook in notice-sources.tsx: tests/unit/notice-slot-rules
 * mocks that module wholesale, and a new export there would be silently
 * undefined under the mock.
 *
 * No toast for the failing key, on purpose. The failure persists until someone
 * fixes it, and a toast is gone in five seconds; a line that waits is the repo's
 * idiom for a condition that waits too.
 */

/** Where both notices send you: Settings → AI, by the path the address bar shows (the pane id 'beacon' is a contract). */
const SETTINGS_HREF = AI_SETTINGS_PATH;

/**
 * The failing line's words. "AI paused" only when it is true: a failing model
 * is not the same as no AI when OpenClaw is set up, because the gate then
 * answers with OpenClaw (lib/ai-registry.ts falls back to it when the model is
 * the choice and unusable). Ask and the omnibar then name OpenClaw
 * and keep working, so the line names the model's provider instead of claiming
 * the whole AI stopped. 'custom' has no brand to name ("Other" is the picker's
 * word for it, not a name).
 */
function failingKeyLabel(canChat: boolean, provider: ModelProviderId | null): string {
  if (!canChat) return 'AI paused: your key stopped working';
  if (!provider || provider === 'custom') return 'Your model’s key stopped working';
  return `Your ${PROVIDER_META[provider].label} key stopped working`;
}

/**
 * "Hide for now", per (account, check). Module scope, so it lasts the session
 * and no longer: a reload shows the line again while the key is still broken.
 * Keyed on `checkedAt` as well as the account so a NEW failure (a recheck that
 * failed again later, or a key that worked and then stopped) shows again even
 * if the last one was hidden.
 */
const hiddenFailures = new Set<string>();
const listeners = new Set<() => void>();
let hiddenVersion = 0;

function subscribeHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function hiddenSnapshot(): number {
  return hiddenVersion;
}

function hideFailure(key: string): void {
  hiddenFailures.add(key);
  hiddenVersion += 1;
  listeners.forEach((l) => l());
}

/** Test seam: the session's dismissals are module state, so tests reset them. */
export function __resetAINoticeForTests(): void {
  hiddenFailures.clear();
  hiddenVersion += 1;
  listeners.forEach((l) => l());
}

export function useAINotice(): DockNotice | null {
  const router = useRouter();
  const { known, canChat, modelFailing, aiHidden } = useAICapabilities();
  const userId = useAIConnectionStore((s) => s.hydratedUserId);
  const checkedAt = useAIConnectionStore((s) => s.model?.checkedAt ?? null);
  const hasModel = useAIConnectionStore((s) => s.model !== null);
  const provider = useAIConnectionStore((s) => s.model?.provider ?? null);
  const legacyNotice = useAISettingsStore((s) => s.legacyNotice);
  const dismissLegacyNotice = useAISettingsStore((s) => s.dismissLegacyNotice);
  // Subscribed so a dismissal re-renders every mounted dock, not just the one
  // whose ✕ was pressed.
  useSyncExternalStore(subscribeHidden, hiddenSnapshot, hiddenSnapshot);

  // "No AI, thanks": the gate keeps the connection facts (a failing key is
  // still failing), but neither line may bring AI back up.
  if (aiHidden) return null;

  const openSettings = () => router.push(SETTINGS_HREF);

  if (modelFailing) {
    const key = `${userId ?? ''}|${checkedAt ?? ''}`;
    if (hiddenFailures.has(key)) return null;
    return {
      id: 'ai-failing',
      // A decision only the user can make (fix or replace the key), and
      // nothing else will say so: with nothing else to answer, every AI surface
      // is hidden; with OpenClaw answering, those surfaces name OpenClaw and
      // never mention the model.
      rank: NOTICE_RANK.decision,
      icon: AskMarkIcon,
      iconClassName: 'text-destructive',
      label: <span className="font-semibold">{failingKeyLabel(canChat, provider)}</span>,
      actionLabel: 'Fix',
      onSelect: openSettings,
      onDismiss: () => hideFailure(key),
      dismissLabel: 'Hide for now',
      testId: 'notice-ai-failing',
    };
  }

  // Only for a browser that held a key from before keys moved server-side, and
  // only while nothing at all can answer: the one case where AI went quiet with
  // no explanation. Connecting a model clears the flag for good (the connection
  // store drops it on a successful connect AND on any status read naming a
  // model, so an OpenRouter sign-in or another device's connect counts too,
  // and a later disconnect does not bring it back).
  if (known && !hasModel && !canChat && legacyNotice) {
    return {
      id: 'ai-moved',
      rank: NOTICE_RANK.statement,
      icon: AskMarkIcon,
      label: <span className="font-semibold">AI now uses your own model</span>,
      actionLabel: 'Connect',
      onSelect: openSettings,
      onDismiss: dismissLegacyNotice,
      dismissLabel: 'Dismiss',
      testId: 'notice-ai-moved',
    };
  }

  return null;
}
