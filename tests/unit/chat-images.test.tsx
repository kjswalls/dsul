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
import { ChatTranscript } from '@/components/ai/chat-transcript';
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
import { seedAI, CONNECTED_MODEL, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

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
    // Saved: the words, never the picture.
    expect(JSON.stringify(api.turns)).toContain('what is this?');
    expect(JSON.stringify(api.turns)).not.toContain('/9j/4AAQ');

    // The transcript says so, for as long as this page holds it.
    const id = transport.inputs[0].conversationId;
    const question = useConversationsStore.getState().threads[id].messages[0];
    expect(question.imageCount).toBe(1);
    render(<ChatTranscript id={id} />);
    expect(screen.getByTestId('chat-message-images')).toHaveTextContent('1 image, not saved');

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
    unseed = seedAI({ ...OPENCLAW_PLUGIN, choice: 'openclaw' });
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    expect(screen.getByTestId('chat-attach')).toBeDisabled();
    fireEvent.paste(box(), { clipboardData: { files: [picture()], getData: () => '' } });
    await settle();
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
  });
});
