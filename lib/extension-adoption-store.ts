'use client';

import { create } from 'zustand';

import type { AdoptionStat } from './extension-adoption';

/**
 * Adoption figures for the store, fetched once per page load.
 *
 * Not persisted and never retried in a loop: these are decoration on a card,
 * and a failed fetch means the cards show no figure — the same thing they show
 * before there are enough people for a figure to exist. Nothing else may read
 * this to decide behaviour.
 */
interface ExtensionAdoptionStore {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  stats: Record<string, AdoptionStat>;
  load: () => void;
}

export const useExtensionAdoptionStore = create<ExtensionAdoptionStore>((set, get) => ({
  status: 'idle',
  stats: {},
  load: () => {
    if (get().status !== 'idle') return;
    set({ status: 'loading' });
    fetch('/api/extensions/adoption')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { available?: boolean; stats?: Record<string, AdoptionStat> } | null) => {
        if (!body?.available) {
          set({ status: 'unavailable', stats: {} });
          return;
        }
        set({ status: 'ready', stats: body.stats ?? {} });
      })
      .catch(() => set({ status: 'unavailable', stats: {} }));
  },
}));
