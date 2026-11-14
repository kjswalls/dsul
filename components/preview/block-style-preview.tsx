'use client';

/**
 * PREVIEW ONLY: a floating switcher for trying schedule block styles on a
 * preview deploy (Kirby, 2026-11-14: "try keycap in a preview, with some more
 * subtle versions"). It stamps `data-blk` on <html>; the styles are the
 * `:root[data-blk=…]` rules at the end of app/globals.css. Once a style is
 * picked, it is baked into the block's own tokens and this file goes.
 */

import { useEffect, useState } from 'react';

const STYLES = [
  { id: 'today', label: 'Today' },
  { id: 'k1', label: 'Key' },
  { id: 'k2', label: 'Slim' },
  { id: 'k3', label: 'Hairline' },
  { id: 'k4', label: 'Soft' },
] as const;
type StyleId = (typeof STYLES)[number]['id'];
const DEFAULT: StyleId = 'k2';

function read(): StyleId {
  try {
    // Query only, nothing stored: browser storage belongs to lib/local-state's
    // registry (tests/unit/local-state.test.ts), and a preview has no business there.
    const v = new URLSearchParams(window.location.search).get('blk');
    if (STYLES.some((s) => s.id === v)) return v as StyleId;
  } catch {}
  return DEFAULT;
}

export function BlockStylePreview() {
  const [style, setStyle] = useState<StyleId | null>(null);
  useEffect(() => setStyle(read()), []);
  useEffect(() => {
    if (!style) return;
    const root = document.documentElement;
    if (style === 'today') root.removeAttribute('data-blk');
    else root.setAttribute('data-blk', style);
  }, [style]);
  if (!style) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Schedule block style (preview)"
      className="titlebar-hole fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-[var(--surface-2)] p-1 text-[12px] shadow-[var(--shadow-elev-md)]"
    >
      <span className="px-2 text-muted-foreground">Blocks</span>
      {STYLES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={style === s.id}
          onClick={() => setStyle(s.id)}
          className={
            'rounded-full px-2.5 py-1 transition-colors ' +
            (style === s.id ? 'bg-foreground text-background' : 'text-foreground hover:bg-[var(--surface-3)]')
          }
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
