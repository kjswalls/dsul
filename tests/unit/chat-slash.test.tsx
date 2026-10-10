import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { addDays, isSameDay } from 'date-fns';

/**
 * / commands in the chat box (AI step 2c, memory/plans/ai-vision.md): a
 * message that starts with "/" offers the ⌘K commands that match it. One that
 * runs in a step runs from the box and clears it; one that needs a value opens
 * ⌘K with that command already picked.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
// The command context reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { ChatComposer } from '@/components/ai/chat-composer';
import { Omnibar } from '@/components/sidebar/omnibar';
import { activeSlash } from '@/lib/chat-slash';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { clearChatState, configureConversations } from '@/lib/conversations-store';
import type { TaskItem } from '@/lib/planner-types';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, type FakeTransport } from './helpers/conversations-fakes';

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const DENTIST: TaskItem = {
  type: 'task',
  id: 't1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
};

const pristine = usePlannerStore.getState();
let transport: FakeTransport;
let unseed: () => void;

beforeEach(() => {
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  unseed = seedAI({ model: CONNECTED_MODEL });
  usePlannerStore.setState({ ...pristine, items: [DENTIST], tasks: [DENTIST], selectedDate: new Date() });
  useUIStore.setState({ activeDialog: null });
});
afterEach(() => {
  cleanup();
  unseed();
  usePlannerStore.setState(pristine, true);
  useUIStore.setState({ activeDialog: null });
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });
const options = () => screen.queryAllByTestId('chat-slash-option');

describe('activeSlash', () => {
  it('is a / at the very start, up to the caret, on one line', () => {
    expect(activeSlash('/tom', 4)).toEqual({ query: 'tom' });
    expect(activeSlash('/', 1)).toEqual({ query: '' });
    expect(activeSlash('a /tom', 6)).toBeNull();
    expect(activeSlash('/tom', 0)).toBeNull();
    expect(activeSlash('/tom\nmore', 9)).toBeNull();
    expect(activeSlash(`/${'x'.repeat(41)}`, 42)).toBeNull();
  });
});

describe('the / list in the chat box', () => {
  it('offers matching commands and runs a one-step one from the box, clearing it', () => {
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    type('/tomorrow');
    const rows = options();
    expect(rows.map((r) => r.textContent)).toContain('Go to tomorrow');
    expect(box()).toHaveAttribute('aria-activedescendant', rows[0].id);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('');
    expect(isSameDay(usePlannerStore.getState().selectedDate, addDays(new Date(), 1))).toBe(true);
    expect(transport.inputs).toHaveLength(0);
  });

  it('hands a command that needs a value to ⌘K, already picked', () => {
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    type('/complete');
    const row = options().find((r) => r.textContent?.startsWith('Complete'));
    expect(row).toBeDefined();
    expect(row!.textContent).toMatch(/in /);
    fireEvent.click(row!);
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'launcher', commandId: 'items.complete' });
    expect(box().value).toBe('');
  });

  it('Escape closes the list until the / is gone, and then Enter sends the words', () => {
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    type('/tomorrow');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByTestId('chat-slash-list')).toBeNull();
    type('/tomorrow please');
    expect(screen.queryByTestId('chat-slash-list')).toBeNull();
    type('hi');
    type('/');
    expect(screen.getByTestId('chat-slash-list')).toBeInTheDocument();
  });

  it('with nothing matching, shows no list, names no option, and sends the message', () => {
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    type('/zzzzqqq');
    expect(screen.queryByTestId('chat-slash-list')).toBeNull();
    expect(box()).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('');
  });
});

describe('the launcher opened with a command picked', () => {
  it('starts in that command’s picker', () => {
    act(() => useUIStore.getState().openDialog({ type: 'launcher', commandId: 'items.complete' }));
    render(<Omnibar variant="launcher" initialCommandId="items.complete" />);
    expect(screen.getAllByTestId('omnibar-entity-row').map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Book the dentist')])
    );
  });
});
