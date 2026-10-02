import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

// The macOS desktop app's window-drag band (app/globals.css, "Desktop app: the window's top
// band"). Browsers never define env(titlebar-area-*), so none of this is visible to e2e; these
// pin the source shape that keeps the browser unchanged and the desktop band usable.

vi.mock('@/components/sidebar/braindump', () => ({ Braindump: () => null }));
vi.mock('@/components/sidebar/sidebar-dock', () => ({ SidebarDock: () => null }));

import { Sidebar } from '@/components/sidebar/sidebar';
import { useSidebarStore } from '@/lib/sidebar-store';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('the window-drag band, in source', () => {
  it('is the first element in <body>', () => {
    // Where drag regions overlap the LATER one wins, so every hole must come after the band.
    expect(read('app/layout.tsx')).toMatch(
      /<body\b[^>]*>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<div aria-hidden className="titlebar-drag" \/>/
    );
  });

  it('is fixed, takes no pointer and declares both spellings', () => {
    const rule = read('app/globals.css').match(/\.titlebar-drag \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('position: fixed;');
    expect(rule).toContain('pointer-events: none;');
    expect(rule).toContain('-webkit-app-region: drag;');
    expect(rule).toContain('app-region: drag;');
  });

  it('gives every titlebar env() a 0px fallback, and never asks for the WCO display mode', () => {
    for (const file of [...sources('app'), ...sources('components'), ...sources('hooks'), ...sources('lib')]) {
      const text = read(file);
      // Prose may name env(titlebar-area-x); every use with arguments must fall back to 0px,
      // never a bare 0 (invalid inside calc() and min(), which would drop the declaration).
      for (const m of text.matchAll(/env\(titlebar-area-[a-z]+\s*,([^)]*)\)/g)) {
        expect(m[1].trim(), `${file}: ${m[0]}`).toBe('0px');
      }
      // Electron never matches it, so a rule behind it would silently never apply.
      expect(text, file).not.toMatch(/(@media|@custom-media|matchMedia\()[^{;]*window-controls-overlay/);
    }
  });
});

describe('<Sidebar/> holes in the band', () => {
  beforeEach(() => {
    useSidebarStore.setState({ leftSidebarOpen: true, leftSidebarHovered: false, leftSidebarHoverEnabled: false });
  });
  afterEach(cleanup);

  it('docked open: the sash is a hole and the word is one', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-resize-handle')).toHaveClass('titlebar-hole');
    expect(screen.getByTestId('sidebar-wordmark')).toHaveClass('titlebar-hole-word');
  });

  it('collapsed: the expand zone is a hole and the clipped word is not', () => {
    useSidebarStore.setState({ leftSidebarOpen: false });
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-expand-zone')).toHaveClass('titlebar-hole');
    expect(screen.getByTestId('sidebar-wordmark')).not.toHaveClass('titlebar-hole-word');
  });

  it('peeking: the column and its footprint are holes, so the band does not end the peek', () => {
    useSidebarStore.setState({ leftSidebarOpen: false, leftSidebarHoverEnabled: true });
    render(<Sidebar />);
    act(() => useSidebarStore.setState({ leftSidebarHovered: true }));
    expect(screen.getByTestId('sidebar-column')).toHaveClass('titlebar-hole');
    expect(screen.getByTestId('sidebar-peek-footprint')).toHaveClass('titlebar-hole');
    expect(screen.getByTestId('sidebar-wordmark')).toHaveClass('titlebar-hole-word');
  });
});
