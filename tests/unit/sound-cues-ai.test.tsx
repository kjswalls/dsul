import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * The AI's two sounds: "started" when a conversation starts streaming,
 * "finished" only when THIS turn's reply completes. A reply stopped before its
 * first word is dropped in the same update that ends the stream, leaving an
 * earlier complete reply newest; that must not ring.
 */

const cue = vi.fn();
vi.mock('@/lib/sounds/cue', () => ({ cueSound: (...a: unknown[]) => cue(...a) }));

import { SoundCues } from '@/components/providers/sound-cues';
import { useConversationsStore } from '@/lib/conversations-store';
import { EXT_SOUNDS } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; status: string; errorCode: null };
const msg = (id: string, role: Msg['role'], status = 'complete'): Msg => ({ id, role, content: 'x', status, errorCode: null });

function thread(streaming: boolean, messages: Msg[]) {
  const prev = useConversationsStore.getState().threads;
  useConversationsStore.setState({ threads: { ...prev, t1: { id: 't1', streaming, messages } as never } });
}

describe('SoundCues and the AI', () => {
  beforeEach(() => {
    cue.mockClear();
    useExtensionsStore.setState({ enabled: { [EXT_SOUNDS]: true } });
    useConversationsStore.setState({ threads: {} });
    render(<SoundCues />);
  });
  afterEach(() => {
    cleanup();
    useExtensionsStore.getState().reset();
  });

  const earlier = [msg('u1', 'user'), msg('a1', 'assistant')];

  it('rings started, then finished when the reply completes', () => {
    act(() => thread(true, [...earlier, msg('u2', 'user'), msg('a2', 'assistant', 'streaming')]));
    expect(cue).toHaveBeenLastCalledWith('aiStart');
    act(() => thread(false, [...earlier, msg('u2', 'user'), msg('a2', 'assistant')]));
    expect(cue).toHaveBeenLastCalledWith('aiDone');
  });

  it('stays quiet for a reply stopped before its first word', () => {
    act(() => thread(true, [...earlier, msg('u2', 'user'), msg('a2', 'assistant', 'streaming')]));
    act(() => thread(false, [...earlier, msg('u2', 'user')]));
    expect(cue).not.toHaveBeenCalledWith('aiDone');
  });

  it('stays quiet for a stopped or failed reply', () => {
    act(() => thread(true, [msg('u2', 'user'), msg('a2', 'assistant', 'streaming')]));
    act(() => thread(false, [msg('u2', 'user'), msg('a2', 'assistant', 'stopped')]));
    expect(cue).not.toHaveBeenCalledWith('aiDone');
  });
});
