import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

const answerAgentQuestion = vi.fn((..._args: unknown[]) => true);
vi.mock('@/lib/agent-question', () => ({
  answerAgentQuestion: (...args: unknown[]) => answerAgentQuestion(...args),
}));
const OPTIONS: Record<string, string[]> = {};
vi.mock('@/hooks/use-agent-question', () => ({
  useAgentQuestion: (item: { id: string }) => ({ options: OPTIONS[item.id] ?? [], ready: true, clear: () => {} }),
}));
vi.mock('@/lib/planner-ready', () => ({ usePlannerLoaded: () => true, isPlannerPreviewing: () => false }));
const openItemFromAsk = vi.fn();
vi.mock('@/lib/open-chat', () => ({ openItemFromAsk: (...a: unknown[]) => openItemFromAsk(...a) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import { usePlannerStore } from '@/lib/planner-store';
import { useNeedsYouStore, UNDO_MS } from '@/lib/needs-you-store';
import { askers, askerInitial, badgeLine } from '@/lib/needs-you';
import { AskerCard } from '@/components/ai/needs-you/asker-card';
import { NeedsYouBadge } from '@/components/ai/needs-you/needs-you-badge';
import { BlockAsk } from '@/components/ai/needs-you/block-ask';
import type { AgentItem } from '@/lib/ask-home';
import type { Item } from '@/lib/planner-types';

const item = (id: string, assignee: string, aiResult: string, at: string): AgentItem =>
  ({
    id,
    type: 'task',
    title: `Item ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    assignee,
    aiStatus: 'blocked',
    aiStatusAt: at,
    aiResult,
  }) as unknown as AgentItem;

const A = item('a', 'openclaw', 'Tue or Thu?', '2026-10-12T01:00:00Z');
const B = item('b', 'claude', 'Which file?', '2026-10-12T02:00:00Z');
const C = item('c', 'openclaw', 'Still on?', '2026-10-12T03:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  answerAgentQuestion.mockClear();
  openItemFromAsk.mockClear();
  for (const k of Object.keys(OPTIONS)) delete OPTIONS[k];
  useNeedsYouStore.setState({ pending: {}, inbox: { open: false, focus: null } });
  usePlannerStore.setState({ items: [A, B, C] as unknown as Item[] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('askers', () => {
  it('groups by asker in order of their longest wait', () => {
    const groups = askers([A, B, C]);
    expect(groups.map((g) => g.assignee)).toEqual(['openclaw', 'claude']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(groups[0].label).toBe('OpenClaw');
    expect(askerInitial(groups[1])).toBe('C');
  });

  it('words the badge', () => {
    expect(badgeLine(3)).toBe('3 to answer');
    expect(badgeLine(0)).toBe('answered');
  });
});

describe('held answers', () => {
  it('go to the agent once the undo window closes', () => {
    useNeedsYouStore.getState().answer(A, ' Tue ');
    expect(useNeedsYouStore.getState().pending.a?.text).toBe('Tue');
    expect(answerAgentQuestion).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(UNDO_MS));
    expect(answerAgentQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'Tue');
    expect(useNeedsYouStore.getState().pending.a).toBeUndefined();
  });

  it('never go once taken back', () => {
    useNeedsYouStore.getState().answer(A, 'Tue');
    useNeedsYouStore.getState().undo('a');
    act(() => void vi.advanceTimersByTime(UNDO_MS * 2));
    expect(answerAgentQuestion).not.toHaveBeenCalled();
  });

  it('never answer a question already answered elsewhere', () => {
    useNeedsYouStore.getState().answer(A, 'Tue');
    usePlannerStore.setState({ items: [{ ...A, aiStatus: 'queued' }] as unknown as Item[] });
    act(() => void vi.advanceTimersByTime(UNDO_MS));
    expect(answerAgentQuestion).not.toHaveBeenCalled();
  });

  it('refuse a blank answer, and go at once when the page hides', () => {
    expect(useNeedsYouStore.getState().answer(A, '  ')).toBe(false);
    useNeedsYouStore.getState().answer(A, 'Tue');
    useNeedsYouStore.getState().flush();
    expect(answerAgentQuestion).toHaveBeenCalledTimes(1);
  });
});

describe('AskerCard', () => {
  it('pages an asker with two questions, picks by letter and submits with Undo', () => {
    OPTIONS.a = ['Tue 3pm', 'Thu 10am'];
    const [openclaw] = askers([A, C]);
    render(<AskerCard asker={openclaw} />);
    expect(screen.getByTestId('asker-card-page')).toHaveTextContent('1 of 2');
    expect(screen.getByText('Tue or Thu?')).toBeInTheDocument();

    const submit = screen.getByTestId('asker-card-submit');
    expect(submit).toBeDisabled();
    const question = screen.getByTestId('asker-card-question');
    fireEvent.keyDown(screen.getAllByTestId('asker-card-option')[0], { key: 'b' });
    expect(screen.getAllByTestId('asker-card-option')[1]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('asker-card-clear'));
    expect(screen.getAllByTestId('asker-card-option')[1]).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(question).getAllByTestId('asker-card-option')[1]);
    fireEvent.click(submit);

    expect(useNeedsYouStore.getState().pending.a?.text).toBe('Thu 10am');
    const folded = screen.getByTestId('asker-card-answered');
    expect(folded).toHaveTextContent('“Thu 10am”');
    // The pager moved on to the one still open.
    expect(screen.queryByTestId('asker-card-page')).toBeNull();
    expect(screen.getByText('Still on?')).toBeInTheDocument();

    fireEvent.click(within(folded).getByTestId('asker-card-undo'));
    expect(useNeedsYouStore.getState().pending.a).toBeUndefined();
    expect(screen.getByText('Tue or Thu?')).toBeInTheDocument();
  });

  it('takes the user own words over a picked choice', () => {
    OPTIONS.a = ['Tue 3pm'];
    render(<AskerCard asker={askers([A])[0]} />);
    fireEvent.click(screen.getByTestId('asker-card-option'));
    const field = screen.getByTestId('asker-card-input');
    fireEvent.change(field, { target: { value: 'Neither, next week' } });
    expect(screen.getByTestId('asker-card-option')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(useNeedsYouStore.getState().pending.a?.text).toBe('Neither, next week');
  });

  it('opens the item from its title', () => {
    render(<AskerCard asker={askers([A])[0]} />);
    fireEvent.click(screen.getByTestId('asker-card-item'));
    expect(openItemFromAsk).toHaveBeenCalledWith(A);
  });
});

describe('NeedsYouBadge', () => {
  it('shows the askers and opens one card each', () => {
    render(<NeedsYouBadge />);
    const badge = screen.getByTestId('needs-you-badge');
    expect(badge).toHaveTextContent('3 to answer');
    act(() => useNeedsYouStore.getState().openInbox());
    const inbox = screen.getByTestId('needs-you-inbox');
    expect(within(inbox).getAllByTestId('asker-card').map((c) => c.dataset.asker)).toEqual(['openclaw', 'claude']);
    act(() => void useNeedsYouStore.getState().answer(B, 'that one'));
    expect(badge).toHaveTextContent('2 to answer');
  });

  it('is not there while nobody is waiting', () => {
    usePlannerStore.setState({ items: [] });
    render(<NeedsYouBadge />);
    expect(screen.queryByTestId('needs-you-badge')).toBeNull();
  });
});

describe('BlockAsk', () => {
  it('answers from a block choice and opens the inbox on the question', () => {
    OPTIONS.a = ['Tue 3pm', 'Thu 10am'];
    const onBlock = vi.fn();
    render(
      <div onClick={onBlock} onPointerDown={onBlock}>
        <BlockAsk item={A} choices />
      </div>
    );
    expect(screen.getByTestId('block-ask-question')).toHaveTextContent('OpenClaw: Tue or Thu?');
    fireEvent.click(screen.getByTestId('block-ask-question'));
    expect(useNeedsYouStore.getState().inbox).toEqual({ open: true, focus: 'a' });
    fireEvent.pointerDown(screen.getAllByTestId('block-ask-option')[0]);
    fireEvent.click(screen.getAllByTestId('block-ask-option')[0]);
    expect(onBlock).not.toHaveBeenCalled();
    expect(useNeedsYouStore.getState().pending.a?.text).toBe('Tue 3pm');
    expect(screen.getByTestId('block-ask')).toHaveTextContent('Answered “Tue 3pm”');
    fireEvent.click(screen.getByTestId('block-ask-undo'));
    expect(useNeedsYouStore.getState().pending.a).toBeUndefined();
  });

  it('keeps the choices for the inbox on a short block', () => {
    OPTIONS.a = ['Tue 3pm'];
    render(<BlockAsk item={A} choices={false} />);
    expect(screen.queryByTestId('block-ask-option')).toBeNull();
  });
});
