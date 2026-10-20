import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { PackCard } from '@/components/sidebar/prep-pack';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import type { PrepPack } from '@/lib/prep-packs';
import type { Item } from '@/lib/planner-types';

/**
 * A question pack on its card: the AI's one question, its likely answers, a
 * box for your own. Answering writes the notes, drops the question and asks
 * again (memory/plans/power-mode.md, "Background prep").
 */

const question: PrepPack = {
  itemId: 'a',
  madeFor: 'Email Mara',
  updatedAt: '2026-10-20T12:00:00.000Z',
  pack: { kind: 'question', question: 'Which invoice?', options: ['March', 'April'] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const task = { type: 'task', id: 'a', title: 'Email Mara', status: 'pending', isScheduled: false, order: 0 } as Item;
  usePlannerStore.setState({ items: [task], userTimezone: 'UTC' } as never);
  usePrepPacksStore.setState({ packs: { a: question }, available: true, preparing: {}, tried: {} });
  const updateTask = vi.fn();
  usePlannerStore.setState({ updateTask } as never);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ packs: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<PackCard itemId="a" title="Email Mara" stored={question} onClose={() => {}} />);
  return { updateTask, fetchMock };
}

describe('a question pack', () => {
  it('shows the question and its answers, with no Copy or Open', () => {
    mount();
    expect(screen.getByText('Which invoice?')).toBeTruthy();
    expect(screen.getAllByTestId('prep-pack-option').map((b) => b.textContent)).toEqual(['March', 'April']);
    expect(screen.queryByTestId('prep-pack-primary')).toBeNull();
    expect(screen.getByText('Your AI needs one thing first')).toBeTruthy();
  });

  it('answers into the notes, drops the question, and asks again', () => {
    const { updateTask, fetchMock } = mount();
    fireEvent.click(screen.getByText('April'));
    expect(updateTask).toHaveBeenCalledWith('a', { notes: 'Which invoice? April' }, expect.anything());
    expect(usePrepPacksStore.getState().packs.a).toBeUndefined();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    expect(calls.some(([url, init]) => url.startsWith('/api/ai/prep?item=a') && init?.method === 'DELETE')).toBe(true);
    const ask = calls.find(([url, init]) => url === '/api/ai/prep' && init?.method === 'POST');
    expect(JSON.parse(String(ask?.[1]?.body)).items[0]).toMatchObject({ id: 'a', notes: 'Which invoice? April' });
  });

  it('takes a typed answer too', () => {
    const { updateTask } = mount();
    fireEvent.change(screen.getByTestId('prep-pack-answer'), { target: { value: 'the May one' } });
    fireEvent.click(screen.getByText('Answer'));
    expect(updateTask).toHaveBeenCalledWith('a', { notes: 'Which invoice? the May one' }, expect.anything());
  });
});

describe('a researched pack', () => {
  it('shows its options and sources as outward links that open a new tab', () => {
    const stored: PrepPack = {
      itemId: 'a',
      madeFor: 'Book the dentist',
      updatedAt: '2026-10-20T12:00:00.000Z',
      pack: {
        kind: 'options',
        options: [{ title: 'Dr Patel', when: 'Tue 3pm', url: 'https://www.clinic.example/book' }],
        sources: [{ title: 'Clinic hours', url: 'https://clinic.example/hours' }],
      },
    };
    const task = { type: 'task', id: 'a', title: 'Book the dentist', status: 'pending', isScheduled: false, order: 0 } as Item;
    usePlannerStore.setState({ items: [task], userTimezone: 'UTC' } as never);
    usePrepPacksStore.setState({ packs: { a: stored }, available: true, preparing: {}, tried: {} });
    render(<PackCard itemId="a" title="Book the dentist" stored={stored} onClose={() => {}} />);
    expect(screen.getByTestId('prep-pack-options').textContent).toContain('Dr Patel');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(
      expect.arrayContaining(['https://www.clinic.example/book', 'https://clinic.example/hours'])
    );
    for (const l of links) {
      expect(l.getAttribute('target')).toBe('_blank');
      expect(l.getAttribute('rel')).toContain('noopener');
    }
    expect(screen.getByTestId('prep-pack-sources').textContent).toContain('clinic.example');
  });
});
