import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentPill } from '@/components/primitives/pills';
import { PrepStatus } from '@/components/ai/ai-work-badge';
import { usePrepPacksStore } from '@/lib/prep-packs-store';

/**
 * A row's AI status under its hover buttons (Kirby's pick C, 2026-10-31): the
 * buttons sit where the chip does, so while they are up the chip is hidden and
 * a dot by the buttons stands in for it, its tone the chip's state.
 */

afterEach(cleanup);

const dotOf = (item: Record<string, string>) => {
  const { queryByTestId } = render(
    <TooltipProvider>
      <AgentPill item={item} dot />
    </TooltipProvider>
  );
  return queryByTestId('ai-dot')?.querySelector('[data-ai-dot]') ?? null;
};

const recent = () => new Date(Date.now() - 60_000).toISOString();

describe('the hover dot', () => {
  it('is ready for a finished item waiting on its tick', () => {
    expect(dotOf({ assignee: 'claude', aiStatus: 'done', aiStatusAt: recent(), status: 'pending' })?.getAttribute('data-ai-dot')).toBe('ready');
  });

  it('is the warm one for a question', () => {
    expect(dotOf({ assignee: 'claude', aiStatus: 'blocked', aiStatusAt: recent(), status: 'pending' })?.getAttribute('data-ai-dot')).toBe('question');
  });

  it('plays the relay during a live run, and never carries the sheen mark', () => {
    const { queryByTestId } = render(
      <TooltipProvider>
        <AgentPill item={{ assignee: 'claude', aiStatus: 'working', aiStatusAt: recent(), status: 'pending' }} dot />
      </TooltipProvider>
    );
    const dot = queryByTestId('ai-dot');
    expect(dot?.getAttribute('data-row-ai-dot')).toBe('working');
    expect(dot?.querySelectorAll('[data-ai-relay] > i')).toHaveLength(6);
    expect(dot?.querySelector('[data-ai-working]')).toBeNull();
  });

  it('is quiet for a failed run', () => {
    expect(dotOf({ assignee: 'claude', aiStatus: 'failed', aiStatusAt: recent(), status: 'pending' })?.getAttribute('data-ai-dot')).toBe('quiet');
  });

  it('is absent with no AI news', () => {
    expect(dotOf({ status: 'pending' })).toBeNull();
  });
});

describe("the open item's prep line", () => {
  it('plays the big relay while the item is being got ready, and is gone otherwise', () => {
    usePrepPacksStore.setState({ preparing: { a: true } });
    const { queryByTestId, rerender } = render(<PrepStatus itemId="a" />);
    expect(queryByTestId('prep-status')?.querySelector("[data-ai-relay='big']")).not.toBeNull();
    rerender(<PrepStatus itemId="b" />);
    expect(queryByTestId('prep-status')).toBeNull();
    usePrepPacksStore.setState({ preparing: {} });
  });
});

describe('the stylesheet', () => {
  const css = readFileSync('app/globals.css', 'utf8');
  const fold = css.slice(css.indexOf('[data-row-ai-fold]:is('), css.indexOf('[data-row-ai-dot] {'));

  it('hides the row marks while the buttons are up, never through an opacity (they are lime)', () => {
    expect(fold).toMatch(/:hover/);
    expect(fold).toMatch(/:has\(:focus-visible\)/);
    expect(fold).toMatch(/visibility:\s*hidden/);
    expect(fold).not.toMatch(/opacity\s*:/);
  });

  it('breathes the AI finished dots and the wordmark dot, by scale and halo, never an opacity', () => {
    const breathe = css.slice(css.indexOf('The breathing tile'), css.indexOf('/* The ready words'));
    expect(breathe).toMatch(/\[data-ai-dot='ready'\],\s*\[data-lime-dot\]\s*\{[^}]*animation: lime-breathe/);
    expect(breathe).not.toMatch(/opacity\s*:/);
    expect(readFileSync('components/primitives/wordmark.css', 'utf8')).toMatch(/\.wordmark-dot \{[^}]*animation: lime-breathe/);
  });

  it('draws them as tiles, square like the relay\'s, not round', () => {
    const breathe = css.slice(css.indexOf('The breathing tile'), css.indexOf('/* The ready words'));
    expect(breathe).toMatch(/\[data-lime-dot\]\s*\{[^}]*border-radius: 1\.5px/);
    expect(readFileSync('components/primitives/wordmark.css', 'utf8')).toMatch(/\[data-flavor='classic'\] \.wordmark-dot \{\s*border-radius: 18%/);
  });

  it('stills the breath under reduced motion, from the OS and from the app switch', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\[data-ai-dot='ready'\],\s*\[data-lime-dot\] \{\s*animation: none/);
    expect(css).toMatch(/\[data-reduce-motion='true'\] :is\(\[data-ai-dot='ready'\], \[data-lime-dot\], \.wordmark-dot\)/);
  });
});
