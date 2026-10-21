import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const caps = vi.hoisted(() => ({ canPrep: true }));
vi.mock('@/lib/ai-connection-store', () => ({ getAICapabilities: () => caps }));

import { EXT_DO_STUFF } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { answerLearnStyle, noteTaken, resetLearnStyleForTest } from '@/lib/learn-style';
import type { Pack } from '@/lib/prep-packs';
import { learnStyleAsked, LEARN_STYLE_KEY, styleEdit, WRITING_STYLE_KEY, writingStyleOf } from '@/lib/writing-style';

/**
 * How you write (lib/writing-style.ts, lib/learn-style.ts): a draft the person
 * changed before taking it out teaches their own model how they write, once
 * they said yes, and only the learned lines are kept.
 */

const email = (body: string, subject = 'The boiler'): Pack => ({ kind: 'email', subject, body });

describe('styleEdit', () => {
  it('learns from a real change to a draft the person would send', () => {
    const edit = styleEdit(email('Hi Sam, the boiler is out again. Could you send someone?'), email('Sam - boiler is out. Can you send someone? Thanks, K'));
    expect(edit).toEqual({
      kind: 'email',
      before: 'The boiler\n\nHi Sam, the boiler is out again. Could you send someone?',
      after: 'The boiler\n\nSam - boiler is out. Can you send someone? Thanks, K',
    });
  });

  it('ignores whitespace, a typo, and packs that are not the person writing', () => {
    expect(styleEdit(email('Hi Sam,  the boiler'), email('Hi Sam, the boiler\n'))).toBeNull();
    expect(styleEdit(email('Hi Sam, teh boiler'), email('Hi Sam, the boiler'))).toBeNull();
    expect(styleEdit({ kind: 'list', items: ['eggs'] }, { kind: 'list', items: ['eggs', 'oat milk and bread'] })).toBeNull();
    expect(styleEdit(email('Hi Sam'), email(''))).toBeNull();
  });

  it('reads a call script and a message too', () => {
    expect(styleEdit({ kind: 'call', who: 'the dentist', script: ['Hello, I would like to book'] }, { kind: 'call', who: 'the dentist', script: ['Hi, can I book a check-up'] })?.kind).toBe('call');
    expect(styleEdit({ kind: 'message', to: 'Jo', body: 'Hey Jo, are you free Friday?' }, { kind: 'message', to: 'Jo', body: 'jo!! free friday??' })?.kind).toBe('message');
  });
});

describe('noteTaken and answerLearnStyle', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const config = () => useExtensionsStore.getState().configs[EXT_DO_STUFF] ?? {};
  const set = (cfg: Record<string, unknown>) =>
    useExtensionsStore.setState({ available: true, configsLoaded: true, hydratedUserId: 'u1', configs: { [EXT_DO_STUFF]: cfg } });

  beforeEach(() => {
    resetLearnStyleForTest();
    caps.canPrep = true;
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ style: 'Short. Signs off "Thanks, K".' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    useExtensionsStore.setState({ setConfigValue: (_u, slug, key, value) => {
      useExtensionsStore.setState((s) => ({ configs: { ...s.configs, [slug]: { ...s.configs[slug], [key]: value } } }));
    } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const before = email('Hi Sam, the boiler is out again. Could you send someone?');
  const after = email('Sam - boiler is out. Can you send someone? Thanks, K');

  it('asks once before learning anything, and sends nothing until the person says yes', () => {
    set({});
    expect(noteTaken(before, after)).toBe('ask');
    expect(fetchSpy).not.toHaveBeenCalled();
    answerLearnStyle(false);
    expect(learnStyleAsked(config())).toBe(true);
    expect(noteTaken(before, after)).toBe('none');
  });

  it('a yes learns from the edit it was asked about, and keeps only the lines', async () => {
    set({ [LEARN_STYLE_KEY]: false });
    answerLearnStyle(true, before, after);
    await vi.waitFor(() => expect(writingStyleOf(config())).toBe('Short. Signs off "Thanks, K".'));
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/ai/style');
    expect(sent).toMatchObject({ kind: 'email', style: '' });
    expect(Object.keys(config()).sort()).toEqual([LEARN_STYLE_KEY, WRITING_STYLE_KEY]);
  });

  it('while on, each changed draft sends the lines so far with it', async () => {
    set({ [LEARN_STYLE_KEY]: true, [WRITING_STYLE_KEY]: 'Short.' });
    expect(noteTaken(before, after)).toBe('learning');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string).style).toBe('Short.');
  });

  it('a draft taken as written, or with no model, teaches nothing', () => {
    set({ [LEARN_STYLE_KEY]: true });
    expect(noteTaken(before, before)).toBe('none');
    caps.canPrep = false;
    expect(noteTaken(before, after)).toBe('none');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a lesson that comes back after the switch went off is dropped', async () => {
    set({ [LEARN_STYLE_KEY]: true });
    let release!: (r: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    noteTaken(before, after);
    set({ [LEARN_STYLE_KEY]: false });
    release(new Response(JSON.stringify({ style: 'Short.' }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(writingStyleOf(config())).toBe('');
  });
});
