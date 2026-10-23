import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Pictures in the chat box (AI step 2c, lib/chat-images.ts): attached in the
 * panel's box while the connected model answers, sent with that one message,
 * and never saved. The browser's shrink step (canvas) is stood in: jsdom has
 * no image decoder.
 */

const shrink = vi.hoisted(() => ({
  result: { ok: true, image: { mediaType: 'image/jpeg', data: '/9j/4AAQ' } } as
    | { ok: true; image: { mediaType: 'image/jpeg'; data: string } }
    | { ok: false; reason: string },
}));
vi.mock('@/components/ai/chat-image-attach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ai/chat-image-attach')>();
  return { ...actual, readChatImage: vi.fn(async () => shrink.result) };
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: toasts.error, dismiss: vi.fn(), success: vi.fn() }),
}));

import { ChatComposer } from '@/components/ai/chat-composer';
import { ChatTranscript, TranscriptMessages } from '@/components/ai/chat-transcript';
import * as openChat from '@/lib/open-chat';
import { useItemFilesStore } from '@/lib/item-files-store';
import { ATTACH_COPY } from '@/components/ai/chat-image-attach';
import { MAX_CHAT_IMAGES, MAX_IMAGE_DATA_CHARS, imageCountLabel, sanitizeChatImages } from '@/lib/chat-images';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import type { StoredMessage } from '@/lib/conversation-types';
import { seedAI, CONNECTED_MODEL, OPENCLAW_CHAT } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

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

let api: FakeApi;
let transport: FakeTransport;
let unseed: () => void = () => {};

beforeEach(() => {
  api = fakeApi();
  transport = fakeTransport();
  configureConversations({ api: api.api, transport: transport.transport });
  clearChatState();
  useConversationsStore.setState({ saving: 'unknown' });
  shrink.result = { ok: true, image: { mediaType: 'image/jpeg', data: '/9j/4AAQ' } };
  toasts.error.mockClear();
});
afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
});

const settle = () => act(() => flush());
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const picture = (name = 'cat.png') => new File(['x'], name, { type: 'image/png' });
async function attach(...files: File[]) {
  fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files } });
  await settle();
}

describe('sanitizeChatImages', () => {
  it('takes none, or up to three listed pictures of base64 within the cap', () => {
    expect(sanitizeChatImages(undefined)).toEqual([]);
    expect(sanitizeChatImages(null)).toEqual([]);
    const ok = { mediaType: 'image/webp', data: 'UklGRg==' };
    expect(sanitizeChatImages([ok])).toEqual([ok]);
    expect(sanitizeChatImages([{ ...ok, extra: 'dropped' }])).toEqual([ok]);
  });

  it('refuses anything else whole', () => {
    for (const bad of [
      {},
      'x',
      [null],
      [{ mediaType: 'image/svg+xml', data: 'AAAA' }],
      [{ mediaType: 'image/png', data: '' }],
      [{ mediaType: 'image/png', data: 'AAA' }],
      [{ mediaType: 'image/png', data: 'AA AA' }],
      [{ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_DATA_CHARS + 4) }],
      Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ mediaType: 'image/png', data: 'AAAA' })),
    ]) {
      expect(sanitizeChatImages(bad)).toBeNull();
    }
  });

  it('counts in words', () => {
    expect(imageCountLabel(1)).toBe('1 image');
    expect(imageCountLabel(3)).toBe('3 images');
  });
});

describe('attaching pictures in the chat box', () => {
  it('shows each one, sends them with the next message only, and saves the words alone', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    await attach(picture());
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Picture 1' })).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/4AAQ');

    fireEvent.change(box(), { target: { value: 'what is this?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    expect(transport.inputs[0].images).toEqual([{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }]);
    expect(screen.queryByTestId('chat-attachments')).toBeNull();
    // Saved: the words and how many pictures, never the picture.
    expect(JSON.stringify(api.turns)).toContain('what is this?');
    expect(JSON.stringify(api.turns)).not.toContain('/9j/4AAQ');
    expect(api.turns[0].body.messages[0]).toMatchObject({ role: 'user', imageCount: 1 });
    expect(api.turns[0].body.messages[1]).not.toHaveProperty('imageCount');

    // The transcript shows the picture itself while this page holds it, and says it was not saved.
    const id = transport.inputs[0].conversationId;
    const question = useConversationsStore.getState().threads[id].messages[0];
    expect(question.imageCount).toBe(1);
    render(<ChatTranscript id={id} />);
    expect(screen.getByTestId('chat-message-images')).toHaveTextContent('1 image, not saved');
    expect(screen.getByRole('img', { name: 'Picture 1' })).toBeInTheDocument();
    expect(screen.queryByTestId('chat-picture-placeholder')).toBeNull();

    // The next message goes without it.
    act(() => useRailStore.getState().popToHome('desktop'));
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'and now?' } });
    fireEvent.keyDown(screen.getAllByRole('textbox')[0], { key: 'Enter' });
    await settle();
    expect(transport.inputs[1].images).toBeUndefined();
  });

  it('takes a pasted picture, and a remove takes it off again', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    fireEvent.paste(box(), { clipboardData: { files: [picture()], getData: () => '' } });
    await settle();
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('chat-attachment-remove'));
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
  });

  it(`stops at ${MAX_CHAT_IMAGES}, and says why a picture was not taken`, async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    await attach(picture('a.png'), picture('b.png'), picture('c.png'), picture('d.png'));
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(MAX_CHAT_IMAGES);
    expect(toasts.error).toHaveBeenCalledWith(ATTACH_COPY.tooMany(MAX_CHAT_IMAGES));
    expect(screen.getByTestId('chat-attach')).toBeDisabled();

    cleanup();
    shrink.result = { ok: false, reason: ATTACH_COPY.unreadable };
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    await attach(picture());
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith(ATTACH_COPY.unreadable);
  });

  it('offers nothing to attach while OpenClaw answers, and sends it no picture', async () => {
    unseed = seedAI({ ...OPENCLAW_CHAT, choice: 'openclaw' });
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    expect(screen.getByTestId('chat-attach')).toBeDisabled();
    fireEvent.paste(box(), { clipboardData: { files: [picture()], getData: () => '' } });
    await settle();
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
  });

  it('after a reload, shows a quiet tile where each picture was, from the saved count alone', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const cid = 'c0000000-0000-4000-8000-000000000001';
    const stored = (pos: number, o: Partial<StoredMessage>): StoredMessage => ({
      id: `d0000000-0000-4000-8000-00000000000${pos}`,
      pos,
      role: 'user',
      content: 'what is this?',
      status: 'complete',
      errorCode: null,
      replyTo: null,
      answerer: null,
      model: null,
      createdAt: '2026-10-11T01:00:00.000Z',
      ...o,
    });
    api.answer.thread = (id) =>
      id === cid
        ? {
            ok: true,
            value: {
              conversation: summary({ id: cid, messageCount: 2 }),
              messages: [
                stored(1, { imageCount: 2 }),
                stored(2, { role: 'assistant', content: 'A cat on a step.', replyTo: 'd0000000-0000-4000-8000-000000000001', answerer: 'model' }),
              ],
              hasEarlier: false,
            },
          }
        : undefined;
    await act(() => useConversationsStore.getState().openThread(cid));
    render(<ChatTranscript id={cid} />);
    expect(screen.getAllByTestId('chat-picture-placeholder')).toHaveLength(2);
    expect(screen.getByTestId('chat-message-images')).toHaveTextContent('2 images, not saved');
    expect(screen.queryByRole('img', { name: /Picture/ })).toBeNull();
  });
});

describe('the item’s box attaches files to the item', () => {
  const ITEM = { kind: 'item' as const, itemId: 'i1' };
  let add: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    add = vi.fn(async () => {});
    useItemFilesStore.setState({ available: true, byItem: {}, uploading: {}, add } as never);
    send = vi.spyOn(openChat, 'sendFrom').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    send.mockRestore();
    useItemFilesStore.setState({ available: null });
  });
  const pdf = () => new File(['%PDF-'], 'W-2 2025.pdf', { type: 'application/pdf' });
  const sendButton = () => screen.getByRole('button', { name: 'Send' });

  it('takes any file, shows it as a chip, and says it is kept when you send', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    expect(screen.getByTestId('chat-attach')).toHaveAttribute('aria-label', 'Attach files');
    expect(screen.getByTestId('chat-attach-input')).not.toHaveAttribute('accept');
    await attach(pdf());
    expect(screen.getByRole('list', { name: 'Files to add to this item' })).toHaveTextContent('W-2 2025.pdf');
    expect(screen.getByTestId('chat-attachments-note')).toHaveTextContent('Kept on this item when you send.');
    expect(add).not.toHaveBeenCalled();
  });

  it('saves files sent with no words to the item, and sends no message', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    const f = pdf();
    await attach(f);
    fireEvent.click(sendButton());
    expect(add).toHaveBeenCalledWith('i1', [f], { placedAt: expect.any(Number) });
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-attachments')).toBeNull();
  });

  it('keeps the original on the item and sends the shrunk picture to the model', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    const cat = picture();
    await attach(cat);
    fireEvent.change(box(), { target: { value: 'what is this?' } });
    fireEvent.click(sendButton());
    expect(add).toHaveBeenCalledWith('i1', [cat], { placedAt: expect.any(Number) });
    expect(send).toHaveBeenCalledWith(ITEM, 'what is this?', {
      surface: undefined,
      images: [{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }],
    });
    const placedAt = add.mock.calls[0][2].placedAt as number;
    expect(placedAt).toBeLessThanOrEqual(Date.now());
  });

  it('adds nothing once the chip is removed before sending', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    await attach(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Remove W-2 2025.pdf' }));
    fireEvent.change(box(), { target: { value: 'never mind' } });
    fireEvent.click(sendButton());
    expect(add).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(ITEM, 'never mind', { surface: undefined });
  });

  it('takes files while OpenClaw answers, sends it no picture, and says so', async () => {
    unseed = seedAI({ ...OPENCLAW_CHAT, choice: 'openclaw' });
    render(<ChatComposer variant="panel" binding={ITEM} />);
    expect(screen.getByTestId('chat-attach')).toBeEnabled();
    const cat = picture();
    await attach(cat);
    expect(screen.getByTestId('chat-attachments-note')).toHaveTextContent(
      'Kept on this item when you send. OpenClaw doesn’t get files.'
    );
    fireEvent.change(box(), { target: { value: 'here' } });
    fireEvent.click(sendButton());
    expect(add).toHaveBeenCalledWith('i1', [cat], { placedAt: expect.any(Number) });
    expect(send).toHaveBeenCalledWith(ITEM, 'here', { surface: undefined });
  });

  it('says the AI sees only the first three pictures', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    await attach(picture('a.png'), picture('b.png'), picture('c.png'), picture('d.png'));
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(4);
    expect(screen.getByTestId('chat-attachments-note')).toHaveTextContent(
      'Kept on this item when you send. The AI sees the first 3 pictures.'
    );
    fireEvent.change(box(), { target: { value: 'which?' } });
    fireEvent.click(sendButton());
    expect(send.mock.calls[0][2].images).toHaveLength(3);
  });

  it('keeps today’s pictures-only box while files are not available', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useItemFilesStore.setState({ available: false });
    render(<ChatComposer variant="panel" binding={ITEM} />);
    expect(screen.getByTestId('chat-attach')).toHaveAttribute('aria-label', 'Attach pictures');
    expect(screen.getByTestId('chat-attach-input')).toHaveAttribute('accept');
    await attach(picture());
    expect(screen.getByRole('list', { name: 'Attached pictures' })).toBeInTheDocument();
    expect(screen.queryByTestId('chat-attachments-note')).toBeNull();
  });

  it('takes a drop, with a drop zone while dragging', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={ITEM} />);
    const panel = screen.getByTestId('chat-composer-panel');
    const f = pdf();
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [f] } });
    expect(screen.getByTestId('chat-drop-zone')).toHaveTextContent('Drop to add to this item');
    fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [f] } });
    await settle();
    expect(screen.queryByTestId('chat-drop-zone')).toBeNull();
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(1);
  });

  it('leaves every other box as it was', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    expect(screen.getByTestId('chat-attach')).toHaveAttribute('aria-label', 'Attach pictures');
    shrink.result = { ok: false, reason: ATTACH_COPY.notImage };
    await attach(pdf());
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith(ATTACH_COPY.notImage);
    const panel = screen.getByTestId('chat-composer-panel');
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByTestId('chat-drop-zone')).toHaveTextContent('Drop pictures to send with your message');
  });

  it('says in an item’s thread that the pictures went to the AI', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(
      <TranscriptMessages
        busy={false}
        pictureNote="sent"
        messages={[{ id: 'q', role: 'user', content: 'what is this?', createdAt: 1, imageCount: 1 } as never]}
      />
    );
    expect(screen.getByTestId('chat-message-images')).toHaveTextContent('1 image sent to the AI');
    expect(screen.getByTestId('chat-picture-placeholder')).toHaveAttribute(
      'title',
      'This picture went to the AI with your message.'
    );
  });
});
