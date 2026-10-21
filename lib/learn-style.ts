import { getAICapabilities } from './ai-connection-store';
import { EXT_DO_STUFF } from './extension-registry';
import { useExtensionsStore } from './extensions-store';
import type { Pack } from './prep-packs';
import {
  LEARN_STYLE_KEY,
  learnStyleAsked,
  learnStyleOn,
  styleEdit,
  WRITING_STYLE_KEY,
  writingStyleOf,
  type StyleEdit,
} from './writing-style';

/**
 * The one writer of "How you write" (lib/writing-style.ts). A card calls
 * `noteTaken` when a draft leaves it (Copy, Open in mail); an edit worth
 * learning from goes to /api/ai/style, and the lines that come back are
 * written to Do stuff's config. One lesson at a time: a second edit that
 * lands while one is out waits, and only the newest waits.
 */

let inFlight = false;
let queued: StyleEdit | null = null;

const ext = () => useExtensionsStore.getState();
const config = () => ext().configs[EXT_DO_STUFF];

/** What the card should do next: nothing, or ask once whether to learn. */
export type Taken = 'none' | 'learning' | 'ask';

export function noteTaken(before: Pack, after: Pack): Taken {
  const edit = styleEdit(before, after);
  if (!edit || !ext().configsLoaded || !getAICapabilities().canPrep) return 'none';
  if (learnStyleOn(config())) {
    void learn(edit);
    return 'learning';
  }
  return learnStyleAsked(config()) ? 'none' : 'ask';
}

/**
 * The card's question, answered. Asked once on any device: a no (or a toast
 * that went by) writes false, so it never asks again; Settings turns it on.
 */
export function answerLearnStyle(yes: boolean, before?: Pack, after?: Pack): void {
  const userId = ext().hydratedUserId;
  if (!userId) return;
  ext().setConfigValue(userId, EXT_DO_STUFF, LEARN_STYLE_KEY, yes);
  const edit = yes && before && after ? styleEdit(before, after) : null;
  if (edit) void learn(edit);
}

async function learn(edit: StyleEdit): Promise<void> {
  if (inFlight) {
    queued = edit;
    return;
  }
  inFlight = true;
  try {
    const res = await fetch('/api/ai/style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...edit, style: writingStyleOf(config()) }),
    });
    if (!res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { style?: unknown };
    const userId = ext().hydratedUserId;
    // Switched off while it was out, or another account: the lesson is dropped.
    if (!userId || !learnStyleOn(config()) || typeof body.style !== 'string') return;
    const next = body.style.trim();
    if (next && next !== writingStyleOf(config())) ext().setConfigValue(userId, EXT_DO_STUFF, WRITING_STYLE_KEY, next);
  } catch {
    // Offline: this lesson is lost, and the next edit teaches the same thing.
  } finally {
    inFlight = false;
    const next = queued;
    queued = null;
    if (next) void learn(next);
  }
}

/** Tests only. */
export function resetLearnStyleForTest(): void {
  inFlight = false;
  queued = null;
}
