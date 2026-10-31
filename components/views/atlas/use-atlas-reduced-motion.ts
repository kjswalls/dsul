'use client';

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '@/lib/zen-transition';

/**
 * Reduced motion, from the OS or the in-app switch (`data-reduce-motion`):
 * the glide, the scale-down, the far zoom's wave, the ground's fade and the
 * minimap's slide are all off under either.
 */
export function useAtlasReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const read = () => setReduced(prefersReducedMotion());
    read();
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', read);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(read);
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    return () => {
      mq?.removeEventListener?.('change', read);
      mo?.disconnect();
    };
  }, []);
  return reduced;
}
