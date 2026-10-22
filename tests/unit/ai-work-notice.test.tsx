import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';

/**
 * The dock's one line about the AI's work (components/notices/ai-work-notice.tsx):
 * what is ready, said once for the account instead of on every row, its words
 * crossed by a slow sheen, and Look, which starts Do stuff; the relay as its
 * glyph while work goes on; nothing while doing stuff.
 */

const work = vi.hoisted(() => ({ value: { working: false, workingCount: 0, ready: 0, questions: 0 } }));
const gate = vi.hoisted(() => ({ doStuff: true }));

vi.mock('@/hooks/use-ai-work', () => ({ useAiWork: () => work.value }));
vi.mock('@/lib/extension-gates', () => ({ useDoStuffEnabled: () => gate.doStuff }));

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
  gate.doStuff = true;
  useDoStuffStore.getState().stop();
});
afterEach(cleanup);

describe('the AI work line', () => {
  it('is absent when the AI has nothing going', () => {
    expect(notice()).toBeNull();
  });

  it('counts what is ready and the questions apart, under a slow sheen, below any decision', () => {
    work.value = { working: false, workingCount: 0, ready: 4, questions: 1 };
    const n = notice()!;
    expect(n.rank).toBe(NOTICE_RANK.receipt);
    expect(n.anchor).toBeUndefined();
    const label = labelOf(n);
    expect(label.textContent).toBe('3 ready · 1 question');
    expect(label.querySelector('[data-ai-sheen-slow]')).not.toBeNull();
    expect(glyphOf(n).querySelector('[data-ai-dot=""]')).not.toBeNull();
  });

  it('wears the warm dot when all that waits is questions', () => {
    work.value = { working: false, workingCount: 0, ready: 2, questions: 2 };
    const n = notice()!;
    expect(labelOf(n).textContent).toBe('2 questions');
    expect(glyphOf(n).querySelector('[data-ai-dot="question"]')).not.toBeNull();
  });

  it('Look starts Do stuff, whose ready lane holds those rows', () => {
    work.value = { working: false, workingCount: 0, ready: 1, questions: 0 };
    const n = notice()!;
    expect(n.actionLabel).toBe('Look');
    n.onSelect!();
    expect(useDoStuffStore.getState().on).toBe(true);
  });

  it('offers no Look with Do stuff turned off', () => {
    gate.doStuff = false;
    work.value = { working: false, workingCount: 0, ready: 1, questions: 0 };
    expect(notice()!.actionLabel).toBeUndefined();
  });

  it('says what is being worked on, with the relay as its glyph', () => {
    work.value = { working: true, workingCount: 2, ready: 0, questions: 0 };
    const n = notice()!;
    expect(n.label).toBe('Getting 2 things ready');
    expect(n.rank).toBe(NOTICE_RANK.statement);
    expect(glyphOf(n).querySelector('[data-ai-relay]')).not.toBeNull();
  });

  it('keeps the relay on the ready line while work goes on', () => {
    work.value = { working: true, workingCount: 1, ready: 1, questions: 0 };
    expect(glyphOf(notice()!).querySelector('[data-ai-relay]')).not.toBeNull();
  });

  it('is gone while doing stuff, where the lanes say it', () => {
    work.value = { working: true, workingCount: 1, ready: 3, questions: 0 };
    useDoStuffStore.getState().start();
    expect(notice()).toBeNull();
  });
});
