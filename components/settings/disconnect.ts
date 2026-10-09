'use client';

import { useState } from 'react';
import { connectErrorCopy, labelName } from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { openClawStatus } from '@/lib/ai-pane-state';
import type { ModelConnectionView } from '@/lib/ai-types';
import { resetPluginTransport } from '@/lib/chat-transport';
import { useUIStore } from '@/lib/ui-store';

/**
 * Disconnect the saved model, through the one confirm: Settings → AI's
 * Connection cards and the AI-off card ask the same question in the same
 * words. Confirmed, it sends the DELETE (lib/ai-connection-store.ts
 * `disconnect`), which works while AI is off too.
 *
 * `onDone` hears how a CONFIRMED delete ended: true when it landed, false
 * when the server refused it (and `error` says so, in our words). Cancel calls
 * nothing: a ConfirmRequest has no cancel callback (lib/ui-store.ts).
 * `fallbackFocus` rides along as the request's own, for a delete that takes
 * the control that opened the confirm with it.
 */
export function useDisconnect(
  model: ModelConnectionView | null,
  opts?: {
    /** After a CONFIRMED DELETE answers: true when it landed, false when refused. */
    onDone?: (ok: boolean) => void;
    /** Passed through as ConfirmRequest.fallbackFocus: run at the confirm's real close when its opener is gone. */
    fallbackFocus?: () => void;
  }
): {
  ask(): void;
  pending: boolean;
  error: string | null;
} {
  const pending = useAIConnectionStore((s) => s.busy === 'disconnect');
  const [error, setError] = useState<string | null>(null);

  const ask = () => {
    if (!model) return;
    setError(null);
    const name = labelName(model.provider, model.baseUrl);
    const onDone = opts?.onDone;
    useUIStore.getState().confirm({
      title: `Disconnect ${name}?`,
      // The middle sentence: once nothing answers there is no Ask and no
      // History to look in, so nothing else says whether the chats survived.
      description: `dsul will delete the saved key. Chat and plan suggestions hide until you connect again. Your saved conversations stay, and come back when you reconnect. The key stays active with ${name} until you revoke it there.`,
      confirmLabel: 'Disconnect',
      destructive: true,
      testId: 'model-disconnect-confirm',
      // The model's key, never a planner row.
      touchesPlanner: false,
      fallbackFocus: opts?.fallbackFocus,
      onConfirm: () => {
        void useAIConnectionStore
          .getState()
          .disconnect()
          .then((result) => {
            if (!result.ok) setError(connectErrorCopy(result.code, name));
            onDone?.(result.ok);
          });
      },
    });
  };

  return { ask, pending, error };
}

export const UNPAIR_FAILED = 'Couldn’t unpair OpenClaw just now. Try again in a moment.';

/**
 * Unpair OpenClaw, through its one confirm: the OpenClaw section's paired
 * card and the AI-off card's paired row ask the same question. Confirmed, it
 * sends DELETE /api/ai/openclaw (lib/ai-connection-store.ts `unpair`), which
 * deletes the agent key and the plugin's webhooks and leaves a Gateway URL
 * alone, so the confirm says so when one is saved.
 *
 * `onDone` and `fallbackFocus` work as in `useDisconnect`.
 */
export function useUnpair(opts?: {
  onDone?: (ok: boolean) => void;
  fallbackFocus?: () => void;
}): {
  ask(): void;
  pending: boolean;
  error: string | null;
} {
  const pending = useAIConnectionStore((s) => s.busy === 'unpair');
  const [error, setError] = useState<string | null>(null);

  const ask = () => {
    const { openclaw } = useAIConnectionStore.getState();
    if (!openclaw.agent) return;
    setError(null);
    const { name } = openClawStatus(openclaw);
    const gateway = openclaw.gateway
      ? ' Your Gateway URL stays saved under Advanced, so OpenClaw can still answer in Ask. Clear it there to stop that too.'
      : '';
    const onDone = opts?.onDone;
    useUIStore.getState().confirm({
      title: `Unpair ${name}?`,
      description: `dsul will delete the key OpenClaw uses and stop sending it your changes, so it can no longer read or change your planner. Your saved conversations stay. To pair again, run setup from OpenClaw.${gateway}`,
      confirmLabel: 'Unpair',
      destructive: true,
      testId: 'openclaw-unpair-confirm',
      // The agent's key and webhooks, never a planner row.
      touchesPlanner: false,
      fallbackFocus: opts?.fallbackFocus,
      onConfirm: () => {
        void useAIConnectionStore
          .getState()
          .unpair()
          .then((result) => {
            // The chat token this browser holds is derived from the key
            // that is gone; a later pairing mints a new one.
            if (result.ok) resetPluginTransport();
            else setError(UNPAIR_FAILED);
            onDone?.(result.ok);
          });
      },
    });
  };

  return { ask, pending, error };
}
