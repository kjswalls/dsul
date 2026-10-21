import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));
const doneNext = vi.hoisted(() => vi.fn());
vi.mock('@/lib/do-stuff', async (importOriginal) => ({ ...(await importOriginal<object>()), doneNext }));

import { PackCard } from '@/components/sidebar/prep-pack';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { packAction, packHref, packSends, smsNumber, type Pack, type PrepPack } from '@/lib/prep-packs';

/**
 * The one-tap finish: a message opens filled in, in the person's own mail or
 * messages app (or the share sheet), and coming back asks "Sent it?" with a
 * Done that ticks the item off. Nothing is ever sent from dsul.
 */

describe('links', () => {
  it('texts a message to a number, filled in, and never to a name', () => {
    expect(smsNumber('+44 7700 900123')).toBe('+447700900123');
    expect(smsNumber('Jo')).toBeNull();
    expect(smsNumber('jo@example.com')).toBeNull();
    expect(smsNumber('123')).toBeNull();
    const msg: Pack = { kind: 'message', to: '07700 900123', body: 'Running late, sorry' };
    expect(packHref(msg)).toBe('sms:07700900123?&body=Running%20late%2C%20sorry');
    expect(packAction(msg)).toBe('Open in messages');
    expect(packHref({ kind: 'message', to: 'Jo', body: 'hi' })).toBeNull();
    expect(packAction({ kind: 'message', to: 'Jo', body: 'hi' })).toBe('Copy');
  });

  it('asks "Sent it?" only after something that sends', () => {
    expect(packSends({ kind: 'email', subject: 's', body: 'b' })).toBe(true);
    expect(packSends({ kind: 'message', body: 'b' })).toBe(true);
    expect(packSends({ kind: 'call', who: 'GP', script: [] })).toBe(false);
    expect(packSends({ kind: 'call', who: 'GP', number: '01234 567890', script: [] })).toBe(true);
    expect(packSends({ kind: 'steps', steps: ['a', 'b'] })).toBe(false);
  });
});

describe('the card', () => {
  const stored = (pack: Pack): PrepPack => ({ itemId: 'a', pack, madeFor: 'Tell Jo', updatedAt: '2026-10-21T00:00:00Z' }) as PrepPack;

  beforeEach(() => {
    vi.useFakeTimers();
    toast.mockClear();
    doneNext.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // jsdom has no share; a test that added one takes it away.
    delete (navigator as { share?: unknown }).share;
  });

  const mount = (pack: Pack) => {
    const s = stored(pack);
    usePrepPacksStore.setState({ packs: { a: s }, available: true });
    const onSettled = vi.fn();
    render(<PackCard itemId="a" title="Tell Jo" stored={s} onClose={() => {}} onSettled={onSettled} />);
    return { onSettled };
  };

  it('after Open in mail, asks "Sent it?", and its Done ticks the item off', () => {
    const { onSettled } = mount({ kind: 'email', to: 'jo@example.com', subject: 'Friday', body: 'Still on?' });
    const link = screen.getByTestId('prep-pack-primary');
    expect(link).toHaveAttribute('href', expect.stringMatching(/^mailto:jo%40example\.com\?subject=Friday/));
    fireEvent.click(link);
    expect(toast).not.toHaveBeenCalledWith('Sent it?', expect.anything());
    act(() => vi.advanceTimersByTime(1600));
    const call = toast.mock.calls.find((c) => c[0] === 'Sent it?');
    expect(call).toBeTruthy();
    call![1].action.onClick();
    expect(onSettled).toHaveBeenCalled();
    expect(doneNext).toHaveBeenCalledWith('a');
  });

  it('a message to a name offers the share sheet where there is one, and asks after it', async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    mount({ kind: 'message', to: 'Jo', body: 'Still on for Friday?' });
    const primary = screen.getByTestId('prep-pack-primary');
    expect(primary).toHaveTextContent('Share');
    await act(async () => {
      fireEvent.click(primary);
    });
    expect(share).toHaveBeenCalledWith({ text: 'Still on for Friday?' });
    act(() => vi.advanceTimersByTime(1600));
    expect(toast.mock.calls.some((c) => c[0] === 'Sent it?')).toBe(true);
  });

  it('a list never asks "Sent it?"', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    mount({ kind: 'list', items: ['eggs', 'milk'] });
    await act(async () => {
      fireEvent.click(screen.getByTestId('prep-pack-primary'));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(toast.mock.calls.some((c) => c[0] === 'Sent it?')).toBe(false);
  });
});
