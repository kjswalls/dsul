import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentPill } from '@/components/primitives/pills';

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

  it('is working during a live run, and never carries the sheen mark', () => {
    const dot = dotOf({ assignee: 'claude', aiStatus: 'working', aiStatusAt: recent(), status: 'pending' });
    expect(dot?.getAttribute('data-ai-dot')).toBe('working');
    expect(dot?.hasAttribute('data-ai-working')).toBe(false);
  });

  it('is quiet for a failed run', () => {
    expect(dotOf({ assignee: 'claude', aiStatus: 'failed', aiStatusAt: recent(), status: 'pending' })?.getAttribute('data-ai-dot')).toBe('quiet');
  });

  it('is absent with no AI news', () => {
    expect(dotOf({ status: 'pending' })).toBeNull();
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
});
