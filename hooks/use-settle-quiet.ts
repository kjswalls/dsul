'use client';

import { useSyncExternalStore } from 'react';
import { SETTLING_ATTR } from '@/lib/settle';

/**
 * False while the planner's settle runs (`<html data-planner-settling>`,
 * lib/settle.ts): a landing's hold, its glide, or a shield. For a box that
 * sits outside every settle scope yet would resize one if it appeared
 * mid-run: the conductor watches only inside its scopes, so the frames such
 * a box pushes would snap instead of glide (components/mods/mod-card.tsx).
 * True on the server and wherever nothing settles.
 */
export function useSettleQuiet(): boolean {
  return useSyncExternalStore(subscribe, isQuiet, () => true);
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [SETTLING_ATTR] });
  return () => observer.disconnect();
}

function isQuiet(): boolean {
  return !document.documentElement.hasAttribute(SETTLING_ATTR);
}
