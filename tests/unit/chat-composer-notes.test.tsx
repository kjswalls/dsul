import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The Ask / Note switch in the rail's item box (components/ai/chat-composer.tsx
 * under BoundComposer) and in ItemConversation's inline box: where it shows,
 * what Note mode changes, that a note is saved through the notes store and
 * never sent, that it works mid-reply, and that Ask and Note keep separate
 * drafts, so a note is never shown or sent as a message by a box that does
 * not know it is one.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: toasts.error, dismiss: vi.fn(), success: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));

import { BoundComposer } from '@/components/ai/bound-composer';
import { ItemConversation } from '@/components/ai/item-conversation';
import * as openChat from '@/lib/open-chat';
import { askAboutItem } from '@/lib/open-chat';
import { useItemFilesStore } from '@/lib/item-files-store';
import { clearItemNotesState, useItemNotesStore } from '@/lib/item-notes-store';
import { clearChatState, useConversationsStore } from '@/lib/conversations-store';
import { bindingKey, noteDraftKey, useRailStore } from '@/lib/rail-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { TaskItem } from '@/lib/planner-types';
import { seedAI, CONNECTED_MODEL, OPENCLAW_CHAT } from './helpers/ai-fixtures';

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

const ITEM = { kind: 'item' as const, itemId: 'i1' };
const TASK: TaskItem = {
  type: 'task',
  id: 'i1',
  title: 'Call the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
};
const ASK_KEY = bindingKey(ITEM);
const NOTE_KEY = noteDraftKey('i1');

let unseed: () => void = () => {};
let add: ReturnType<typeof vi.fn>;
let filesAdd: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearChatState();
  clearItemNotesState();
  useRailStore.getState().reset();
  add = vi.fn(async () => true);
  useItemNotesStore.setState({ available: true, add } as never);
  filesAdd = vi.fn(async () => {});
  useItemFilesStore.setState({ available: true, byItem: {}, uploading: {}, add: filesAdd } as never);
  send = vi.spyOn(openChat, 'sendFrom').mockResolvedValue(undefined as never);
  toasts.error.mockClear();
  usePlannerStore.setState({ items: [TASK] } as never);
});
afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  send.mockRestore();
  useItemFilesStore.setState({ available: null });
  clearItemNotesState();
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const toNote = () => fireEvent.click(screen.getByTestId('box-mode-note'));
const panel = (binding: Parameters<typeof BoundComposer>[0]['binding'] = ITEM) =>
  render(<BoundComposer binding={binding} />);

describe('where the switch shows', () => {
  it('shows for an item in the panel, never for home, a conversation or the dock', () => {
    unseed = seedAI(CONNECTED_MODEL);
    const item = panel();
    expect(screen.getByTestId('box-mode-ask')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radiogroup', { name: 'Send as' })).toBeInTheDocument();
    item.unmount();
    for (const binding of [{ kind: 'home' as const }, { kind: 'conversation' as const, id: 'c1' }]) {
      const view = panel(binding);
      expect(screen.queryByTestId('box-mode-note')).toBeNull();
      view.unmount();
    }
    render(<BoundComposer binding={ITEM} variant="dock" />);
    expect(screen.queryByTestId('box-mode-note')).toBeNull();
  });

  it.each([null, false])('is not drawn while notes are %s', (available) => {
    unseed = seedAI(CONNECTED_MODEL);
    useItemNotesStore.setState({ available });
    panel();
    expect(screen.queryByTestId('box-mode-note')).toBeNull();
  });
});

describe('Note mode', () => {
  it('changes the placeholder, the Save label and the line, and hides the model chip', () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    expect(screen.getByTestId('chat-model-chip')).toBeInTheDocument();
    toNote();
    expect(box()).toHaveAttribute('placeholder', 'Add a note…');
    expect(box()).toHaveAccessibleName('Note on this item');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeInTheDocument();
    expect(screen.getByTestId('note-mode-line')).toHaveTextContent('Saved on this item. Not sent to the AI.');
    expect(screen.queryByTestId('chat-model-chip')).toBeNull();
  });

  it('names OpenClaw when it is the one answering', () => {
    unseed = seedAI({ ...OPENCLAW_CHAT, choice: 'openclaw' });
    panel();
    toNote();
    expect(screen.getByTestId('note-mode-line')).toHaveTextContent(
      'Saved on this item. Not sent to the AI or OpenClaw.'
    );
  });

  it('Save calls the notes store and never sendFrom', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    toNote();
    fireEvent.change(box(), { target: { value: '  bring the card  ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save note' })));
    expect(add).toHaveBeenCalledWith('i1', 'bring the card', { placedAt: expect.any(Number) });
    expect(send).not.toHaveBeenCalled();
    expect(useRailStore.getState().drafts[NOTE_KEY]).toBeUndefined();
  });

  it('keeps files sent with a note on the item, just above it', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    toNote();
    const pdf = new File(['%PDF-'], 'W-2.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pdf] } });
    });
    expect(screen.getByTestId('chat-attachments-note')).toHaveTextContent('Kept on this item when you save.');
    fireEvent.change(box(), { target: { value: 'the form' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save note' })));
    const placedAt = filesAdd.mock.calls[0][2].placedAt as number;
    expect(filesAdd).toHaveBeenCalledWith('i1', [pdf], { placedAt });
    expect(add).toHaveBeenCalledWith('i1', 'the form', { placedAt: placedAt + 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('opens no command list for a note that starts with "/"', () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    // In Ask mode a "/" offers the commands.
    fireEvent.change(box(), { target: { value: '/' } });
    fireEvent.select(box());
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.change(box(), { target: { value: '' } });
    toNote();
    fireEvent.change(box(), { target: { value: '/' } });
    fireEvent.select(box());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('works while a reply is streaming: the field writable, the + enabled, Save saving', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useConversationsStore.setState((s) => ({ sending: { ...s.sending, [ASK_KEY]: true } }) as never);
    panel();
    expect(box()).toHaveAttribute('readonly');
    toNote();
    expect(box()).not.toHaveAttribute('readonly');
    expect(screen.getByTestId('chat-attach')).toBeEnabled();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    fireEvent.change(box(), { target: { value: 'mid reply' } });
    await act(async () => fireEvent.keyDown(box(), { key: 'Enter' }));
    expect(add).toHaveBeenCalledWith('i1', 'mid reply', expect.anything());
  });

  it('keeps a 10,001-character note in the box and says why', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    toNote();
    const long = 'x'.repeat(10_001);
    fireEvent.change(box(), { target: { value: long } });
    await act(async () => fireEvent.keyDown(box(), { key: 'Enter' }));
    expect(add).not.toHaveBeenCalled();
    expect(box()).toHaveValue(long);
    expect(toasts.error).toHaveBeenCalledWith('Notes can be up to 10,000 characters. This one has 10,001.');
  });
});

describe('two drafts', () => {
  it('keeps Ask and Note text apart, and a switch moves text only into an empty draft', () => {
    unseed = seedAI(CONNECTED_MODEL);
    panel();
    fireEvent.change(box(), { target: { value: 'I meant this as a note' } });
    toNote();
    expect(box()).toHaveValue('I meant this as a note');
    expect(useRailStore.getState().drafts[ASK_KEY]).toBeUndefined();
    fireEvent.click(screen.getByTestId('box-mode-ask'));
    expect(box()).toHaveValue('I meant this as a note');
    fireEvent.change(box(), { target: { value: '' } });
    useRailStore.getState().setDraft(NOTE_KEY, 'a note');
    useRailStore.getState().setDraft(ASK_KEY, 'a question');
    toNote();
    expect(box()).toHaveValue('a note');
    fireEvent.click(screen.getByTestId('box-mode-ask'));
    expect(box()).toHaveValue('a question');
  });

  it('never shows a note draft in the dock, and Enter there sends only the Ask draft', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useRailStore.getState().setBoxMode(ASK_KEY, 'note');
    useRailStore.getState().setDraft(NOTE_KEY, 'private note');
    useRailStore.getState().setDraft(ASK_KEY, 'a question');
    render(<BoundComposer binding={ITEM} variant="dock" />);
    expect(box()).toHaveValue('a question');
    await act(async () => fireEvent.keyDown(box(), { key: 'Enter' }));
    expect(send).toHaveBeenCalledWith(ITEM, 'a question', { surface: undefined });
    expect(add).not.toHaveBeenCalled();
  });

  it('a failed save comes back in Note mode even if the box was switched to Ask meanwhile', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    let fail!: (v: unknown) => void;
    add.mockReturnValue(new Promise((r) => (fail = r)));
    panel();
    toNote();
    fireEvent.change(box(), { target: { value: 'lost?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('box-mode-ask'));
    expect(screen.getByTestId('box-mode-ask')).toHaveAttribute('aria-checked', 'true');
    await act(async () => fail('failed'));
    expect(screen.getByTestId('box-mode-note')).toHaveAttribute('aria-checked', 'true');
    expect(box()).toHaveValue('lost?');
    expect(useRailStore.getState().drafts[ASK_KEY]).toBeUndefined();
  });

  it('a parked ask lands in the Ask draft and sets Ask mode', () => {
    unseed = seedAI(CONNECTED_MODEL);
    useRailStore.getState().setBoxMode(ASK_KEY, 'note');
    useRailStore.getState().setDraft(NOTE_KEY, 'half a note');
    useConversationsStore.setState((s) => ({ sending: { ...s.sending, [ASK_KEY]: true } }) as never);
    askAboutItem(TASK, { isMobile: false, text: 'What is next?', page: true });
    const rail = useRailStore.getState();
    expect(rail.drafts[ASK_KEY]).toBe('What is next?');
    expect(rail.drafts[NOTE_KEY]).toBe('half a note');
    expect(rail.boxModes[ASK_KEY]).toBeUndefined();
  });

  it('the mode set in the rail’s box shows in the inline box', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useConversationsStore.setState({ resolveItemThread: async () => 'c1', openThread: async () => {} } as never);
    panel();
    toNote();
    render(<ItemConversation item={TASK} mode="inline" />);
    await act(async () => {});
    const radios = screen.getAllByTestId('box-mode-note');
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('item-thread-input')).toHaveAttribute('placeholder', 'Add a note…');
  });
});
