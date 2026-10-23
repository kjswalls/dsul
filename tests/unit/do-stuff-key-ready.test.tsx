import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * The do stuff key says what is ready (Kirby, 2026-10-23): the count, without
 * the questions (the dock counts those where they are answered), and the slow
 * sheen on its word that the dock's old ready line wore.
 */

const work = vi.hoisted(() => ({ value: { working: false, workingCount: 0, ready: 0, questions: 0 } }));
vi.mock('@/hooks/use-ai-work', () => ({ useAiWork: () => work.value }));

import { DoStuffKey } from '@/components/sidebar/do-stuff';
import { useDoStuffStore } from '@/lib/do-stuff';

beforeEach(() => {
  work.value = { working: false, workingCount: 0, ready: 0, questions: 0 };
  useDoStuffStore.getState().stop();
});
afterEach(cleanup);

const word = () => screen.getByText('do stuff');

describe('the do stuff key, with something ready', () => {
  it('is plain with nothing ready', () => {
    render(<DoStuffKey />);
    expect(screen.getByTestId('do-stuff-start')).toHaveAccessibleName('Do stuff');
    expect(word()).not.toHaveAttribute('data-ai-sheen-slow');
  });

  it('counts the ready, leaves the questions out, and wears the sheen', () => {
    work.value = { working: false, workingCount: 0, ready: 13, questions: 1 };
    render(<DoStuffKey />);
    expect(screen.getByTestId('do-stuff-start')).toHaveAccessibleName('Do stuff, 12 ready');
    expect(word()).toHaveAttribute('data-ai-sheen-slow');
  });

  it('has no count or sheen when all that waits is questions', () => {
    work.value = { working: false, workingCount: 0, ready: 2, questions: 2 };
    render(<DoStuffKey />);
    expect(screen.getByTestId('do-stuff-start')).toHaveAccessibleName('Do stuff');
    expect(word()).not.toHaveAttribute('data-ai-sheen-slow');
  });
});
