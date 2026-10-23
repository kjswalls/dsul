import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { PackCard } from '@/components/sidebar/prep-pack';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import {
  answersNote,
  meantNote,
  packLabel,
  packQuestions,
  packReading,
  PackSchema,
  type PrepPack,
} from '@/lib/prep-packs';
import { PREP_MEANING_RULES } from '@/lib/prep-rules';
import { aiKnowsOf, withKnown } from '@/lib/ai-knows';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_DO_STUFF } from '@/lib/extension-registry';
import type { Item } from '@/lib/planner-types';

/**
 * Sure, fairly sure, or ask (Kirby's pick C, 2026-10-23): a fairly-sure card
 * shows what the AI took the item to mean, and "Not quite?" corrects it; an
 * unsure item asks up to three questions, a big one what is settled already.
 */

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(stored: PrepPack) {
  const task = { type: 'task', id: 'a', title: stored.madeFor, status: 'pending', isScheduled: false, order: 0 } as Item;
  const updateTask = vi.fn();
  usePlannerStore.setState({ items: [task], userTimezone: 'UTC', updateTask } as never);
  usePrepPacksStore.setState({ packs: { a: stored }, available: true, preparing: {}, tried: {} });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ packs: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<PackCard itemId="a" title={stored.madeFor} stored={stored} onClose={() => {}} />);
  return { updateTask, fetchMock };
}

const asked = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls as unknown as [string, RequestInit?][]).find(
    ([url, init]) => url === '/api/ai/prep' && init?.method === 'POST'
  );

describe('the pack schema', () => {
  it('keeps a reading and its alternates, and drops a bad one without dropping the pack', () => {
    const ok = PackSchema.parse({
      kind: 'message',
      to: 'sammy',
      body: 'Hi',
      reading: 'text Sammy to sort out your license',
      alternates: ["Sammy's a pet: get a pet license"],
    });
    expect(packReading(ok)).toEqual({
      reading: 'text Sammy to sort out your license',
      alternates: ["Sammy's a pet: get a pet license"],
    });
    const bad = PackSchema.parse({ kind: 'steps', steps: ['a', 'b'], reading: 42, alternates: 'x' });
    expect(packReading(bad)).toBeNull();
  });

  it('reads an old one-question card, and up to three questions in a new one', () => {
    const old = PackSchema.parse({ kind: 'question', question: 'Which invoice?' });
    if (old.kind !== 'question') throw new Error('kind');
    expect(packQuestions(old)).toEqual([{ question: 'Which invoice?' }]);
    expect(packLabel(old)).toBe('1 question');

    const many = PackSchema.parse({
      kind: 'question',
      question: "What's settled already?",
      options: ['Dates', 'Cities'],
      multi: true,
      more: [{ question: "Who's going?" }, { question: 'Budget?' }, { question: 'a fourth' }, { nope: 1 }],
    });
    if (many.kind !== 'question') throw new Error('kind');
    expect(packQuestions(many).map((q) => q.question)).toEqual(["What's settled already?", "Who's going?", 'Budget?']);
    expect(packQuestions(many)[0].multi).toBe(true);
    expect(packLabel(many)).toBe('3 questions');
  });

  it('writes answers and a correction into the notes, a line each', () => {
    expect(
      answersNote('Before.', [
        { question: "Who's Sammy?", answer: 'My dog' },
        { question: 'Which city?', answer: ' ' },
      ])
    ).toBe("Before.\nWho's Sammy? My dog");
    expect(meantNote(undefined, "Sammy's dog license")).toBe("I meant: Sammy's dog license");
  });

  it('never drafts a message just because a name is in the title', () => {
    expect(PREP_MEANING_RULES.join(' ')).toMatch(/A name in the title is not enough/);
  });
});

describe('a fairly-sure card', () => {
  const stored: PrepPack = {
    itemId: 'a',
    madeFor: "get sammy's license",
    updatedAt: '2026-10-23T06:00:00.000Z',
    pack: {
      kind: 'message',
      to: 'sammy',
      body: 'Hey Sammy, could we sort out my license?',
      reading: 'text Sammy to sort out your license',
      alternates: ["Sammy's a pet: get a pet license"],
    },
  };

  it('says what it took the item to mean', () => {
    mount(stored);
    expect(screen.getByTestId('prep-pack-reading').textContent).toContain('text Sammy to sort out your license');
  });

  it('takes a correction into the notes and asks again', () => {
    const { updateTask, fetchMock } = mount(stored);
    fireEvent.click(screen.getByTestId('prep-pack-not-quite'));
    fireEvent.click(screen.getByText("Sammy's a pet: get a pet license"));
    expect(updateTask).toHaveBeenCalledWith('a', { notes: "I meant: Sammy's a pet: get a pet license" }, expect.anything());
    expect(usePrepPacksStore.getState().packs.a).toBeUndefined();
    expect(JSON.parse(String(asked(fetchMock)?.[1]?.body)).items[0].notes).toBe("I meant: Sammy's a pet: get a pet license");
  });

  it('calls the throw-away Discard', () => {
    mount(stored);
    expect(screen.getByTestId('prep-pack-dismiss').textContent).toBe('Discard');
  });
});

describe('a card with several questions', () => {
  const stored: PrepPack = {
    itemId: 'a',
    madeFor: 'plan trip to China',
    updatedAt: '2026-10-23T06:00:00.000Z',
    pack: {
      kind: 'question',
      question: "What's settled already?",
      options: ['Dates', 'Cities', "Who's going"],
      multi: true,
      more: [{ question: 'How long?', options: ['A week', 'Two weeks'] }],
    },
  };

  it('selects rather than sends, and sends every answer at once', () => {
    const { updateTask, fetchMock } = mount(stored);
    expect(screen.getByText('Your AI wants to know what is settled')).toBeTruthy();
    fireEvent.click(screen.getByText('Dates'));
    fireEvent.click(screen.getByText("Who's going"));
    expect(updateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Two weeks'));
    fireEvent.click(screen.getByTestId('prep-pack-answer-all'));
    expect(updateTask).toHaveBeenCalledWith(
      'a',
      { notes: "What's settled already? Dates, Who's going\nHow long? Two weeks" },
      expect.anything()
    );
    expect(asked(fetchMock)).toBeTruthy();
  });

  it('waits for at least one answer', () => {
    mount(stored);
    expect((screen.getByTestId('prep-pack-answer-all') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what your AI knows', () => {
  it('adds a line once, whatever its case, and drops the oldest past the cap', () => {
    expect(withKnown('', ["Who's Sammy? My dog"])).toBe("Who's Sammy? My dog");
    expect(withKnown("Who's Sammy? My dog", ["who's sammy? my dog", 'We moved'])).toBe("Who's Sammy? My dog\nWe moved");
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(100)}`);
    const capped = withKnown('', long);
    expect(capped.length).toBeLessThanOrEqual(3000);
    expect(capped.endsWith(long[39])).toBe(true);
    expect(capped.startsWith('line 0 ')).toBe(false);
    expect(aiKnowsOf({ knows: 42 })).toBe('');
  });

  it('keeps an answer for every item only when Remember is ticked, and sends the list with the next ask', () => {
    const setConfigValue = vi.fn((_u: string, slug: string, key: string, value: unknown) =>
      useExtensionsStore.setState((s) => ({ configs: { ...s.configs, [slug]: { ...s.configs[slug], [key]: value } } }))
    );
    useExtensionsStore.setState({ configs: { [EXT_DO_STUFF]: {} }, setConfigValue } as never);
    const stored: PrepPack = {
      itemId: 'a',
      madeFor: "get sammy's license",
      updatedAt: '2026-10-23T06:00:00.000Z',
      pack: { kind: 'question', question: "Who's Sammy?", options: ['A person', 'My dog'] },
    };
    usePrepPacksStore.setState({ userId: 'u1' });
    const { fetchMock } = mount(stored);
    fireEvent.click(screen.getByTestId('prep-pack-remember'));
    fireEvent.click(screen.getByText('My dog'));
    expect(setConfigValue).toHaveBeenCalledWith('u1', EXT_DO_STUFF, 'knows', "Who's Sammy? My dog");
    expect(JSON.parse(String(asked(fetchMock)?.[1]?.body)).knows).toBe("Who's Sammy? My dog");
  });

  it('keeps nothing when Remember is left off', () => {
    const setConfigValue = vi.fn();
    useExtensionsStore.setState({ configs: { [EXT_DO_STUFF]: {} }, setConfigValue } as never);
    usePrepPacksStore.setState({ userId: 'u1' });
    mount({
      itemId: 'a',
      madeFor: 'x',
      updatedAt: '2026-10-23T06:00:00.000Z',
      pack: { kind: 'question', question: 'Which?', options: ['A', 'B'] },
    });
    fireEvent.click(screen.getByText('A'));
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});
