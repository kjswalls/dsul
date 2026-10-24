import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';

/**
 * The dock's one line about the AI's work (components/notices/ai-work-notice.tsx):
 * what waits on an answer, under a slow sheen, and Answer, which opens the
 * quick round; nothing about what is being worked on (the rows say that, with
 * the relay); nothing about what is ready (the do stuff key says that);
 * nothing while doing stuff.
 */

const work = vi.hoisted(() => ({ value: { working: false, workingCount: 0, ready: 0, questions: 0 } }));

vi.mock('@/hooks/use-ai-work', () => ({ useAiWork: () => work.value }));

import { useAIWorkNotice } from '@/components/notices/ai-work-notice';
import { useDoStuffStore } from '@/lib/do-stuff';
import { NOTICE_RANK } from '@/lib/dock-notices';

const notice = () => renderHook(() => useAIWorkNotice()).result.current;
const labelOf = (n: NonNullable<ReturnType<typeof notice>>) => render(<>{n.label}</>).container;
const glyphOf = (n: NonNullable<ReturnType<typeof notice>>) => {
  const Icon = n.icon;
  return render(<Icon className="h-3.5 w-3.5" />).container;
};

beforeEach(() => {
  work.value = { working: false, workingCount: 0, ready: 0, questions: 0 };
  useDoStuffStore.getState().stop();
});
afterEach(cleanup);

describe('the AI work line', () => {
  it('is absent when the AI has nothing going', () => {
    expect(notice()).toBeNull();
  });

  it('says nothing about what is ready, which the do stuff key says', () => {
    work.value = { working: false, workingCount: 0, ready: 3, questions: 0 };
    expect(notice()).toBeNull();
  });

  it('counts the questions under a slow sheen, below any decision, and Answer opens the quick round', () => {
    work.value = { working: false, workingCount: 0, ready: 4, questions: 1 };
    const n = notice()!;
    expect(n.rank).toBe(NOTICE_RANK.receipt);
    expect(n.anchor).toBeUndefined();
    const label = labelOf(n);
    expect(label.textContent).toBe('1 to answer');
    expect(label.querySelector('[data-ai-sheen-slow]')).not.toBeNull();
    expect(glyphOf(n).querySelector('[data-ai-dot="question"]')).not.toBeNull();
    expect(n.actionLabel).toBe('Answer');
    expect(n.tray).toBeTypeOf('function');
    expect(n.open).toBe(false);
    expect(n.trayTitle).toBeTruthy();
  });

  it("leaves the desktop's questions to the header's Needs you badge, so the desktop has no line", () => {
    const desktop = () => renderHook(() => useAIWorkNotice({ questions: false })).result.current;
    work.value = { working: true, workingCount: 1, ready: 0, questions: 2 };
    expect(desktop()).toBeNull();
  });

  it('says nothing about what is being worked on: the rows carry the relay', () => {
    work.value = { working: true, workingCount: 2, ready: 0, questions: 0 };
    expect(notice()).toBeNull();
  });

  it('keeps the question dot on the questions line while work goes on', () => {
    work.value = { working: true, workingCount: 1, ready: 1, questions: 1 };
    const glyph = glyphOf(notice()!);
    expect(glyph.querySelector('[data-ai-dot="question"]')).not.toBeNull();
    expect(glyph.querySelector('[data-ai-relay]')).toBeNull();
  });

  it('is gone while doing stuff, where the lanes say it', () => {
    work.value = { working: true, workingCount: 1, ready: 3, questions: 0 };
    useDoStuffStore.getState().start();
    expect(notice()).toBeNull();
  });
});
