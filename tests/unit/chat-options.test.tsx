import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';

/**
 * Option cards in chat (lib/chat-options.ts): the ClawBoy convention, read the
 * way ClawBoy reads it so an agent's question with choices is buttons here too,
 * and answered the way ClawBoy answers, so the agent parses one format.
 */

const sendFrom = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/open-chat', () => ({ sendFrom }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { TranscriptMessages } from '@/components/ai/chat-transcript';
import {
  composeAnswers,
  parseAnswers,
  parseOptions,
  questionStates,
  stripOptionDirectives,
  MAX_CHOICES,
} from '@/lib/chat-options';
import { buildBeaconSystemPrompt } from '@/lib/beacon-system-prompt';
import type { ChatMessage } from '@/lib/conversations-store';

const SINGLE =
  'Which day works?\n\n[clawboy-options]: <data:application/json,{"choices":[{"label":"Tuesday","value":"Tuesday works"},{"label":"Thursday","value":"Thursday works","hint":"after 2"}]}>';
const MULTI =
  'A few quick ones:\n\n[clawboy-options]: <data:application/json,{"questions":[{"id":"day","prompt":"Which day?","choices":[{"label":"Tue","value":"tue"},{"label":"Thu","value":"thu"}]},{"id":"remind","prompt":"Remind you?","choices":[{"label":"Yes","value":"yes"},{"label":"No","value":"no"}],"allowFreeText":false}]}>';
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('parseOptions', () => {
  it('reads the plain-JSON link-reference and takes it out of the words', () => {
    const p = parseOptions(SINGLE);
    expect(p.text).toBe('Which day works?');
    expect(p.questions).toEqual([
      {
        id: '_single',
        choices: [
          { label: 'Tuesday', value: 'Tuesday works' },
          { label: 'Thursday', value: 'Thursday works', hint: 'after 2' },
        ],
        allowFreeText: true,
      },
    ]);
  });

  it('reads the base64 form, several questions, and the legacy comment', () => {
    const json = '{"choices":[{"label":"Ja","value":"ja ✓"}]}';
    expect(parseOptions(`Ok?\n[clawboy-options]: <data:application/json;base64,${b64(json)}>`).questions?.[0].choices).toEqual([
      { label: 'Ja', value: 'ja ✓' },
    ]);
    const multi = parseOptions(MULTI);
    expect(multi.questions?.map((q) => [q.id, q.allowFreeText])).toEqual([
      ['day', true],
      ['remind', false],
    ]);
    const legacy = parseOptions('Pick:\n<!-- clawboy:options\n{"choices":[{"label":"A","value":"a"}]}\n-->');
    expect(legacy).toEqual({ text: 'Pick:', questions: [{ id: '_single', choices: [{ label: 'A', value: 'a' }], allowFreeText: true }] });
  });

  it('leaves text alone when the directive is missing or broken, and caps the choices', () => {
    expect(parseOptions('just words')).toEqual({ text: 'just words', questions: null });
    const broken = 'Hm\n[clawboy-options]: <data:application/json,{"choices":[{"label":"A"}]}>';
    expect(parseOptions(broken).questions).toBeNull();
    const many = JSON.stringify({ choices: Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: `v${i}` })) });
    expect(parseOptions(`x\n[clawboy-options]: <data:application/json,${many}>`).questions?.[0].choices).toHaveLength(MAX_CHOICES);
  });

  it('hides a directive still streaming in', () => {
    expect(stripOptionDirectives('Which day?\n\n[clawboy-options]: <data:application/json,{"choi')).toBe('Which day?');
  });
});

describe('answers', () => {
  it('compose as ClawBoy does, and read back', () => {
    const qs = parseOptions(MULTI).questions!;
    const msg = composeAnswers(qs, { day: 'thu', remind: null });
    expect(msg).toMatch(/^\[clawboy-answers\]: <data:application\/json;base64,[A-Za-z0-9+/=]+>\n\n/);
    expect(msg).toContain('**Which day?**\nThu\n\n**Remind you?**\n(skipped)');
    expect(parseAnswers(msg)).toEqual({ day: 'thu', remind: null });
    expect(questionStates(qs, msg)).toEqual({ day: { answered: true, value: 'thu' }, remind: { answered: true } });
  });

  it('a one-question card is answered by a plain message too', () => {
    const qs = parseOptions(SINGLE).questions!;
    expect(questionStates(qs, null)).toEqual({ _single: { answered: false } });
    expect(questionStates(qs, 'thursday')).toEqual({ _single: { answered: true, value: 'Thursday works' } });
    expect(questionStates(qs, 'neither, sorry')).toEqual({ _single: { answered: true, freeText: 'neither, sorry' } });
  });
});

describe('the chat prompt', () => {
  it('teaches the model the one-line form', () => {
    expect(buildBeaconSystemPrompt()).toContain('[clawboy-options]: <data:application/json,{"choices":');
  });
});

const msg = (id: string, role: 'user' | 'assistant', content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  status: 'complete',
  errorCode: null,
  replyTo: null,
  answerer: role === 'assistant' ? 'openclaw' : null,
  model: null,
  createdAt: 0,
  pos: 0,
  sync: 'saved',
  ...over,
});
const VIA = { kind: 'conversation', id: 'c1' } as const;

describe('the card in a conversation', () => {
  let unseed = () => {};
  beforeEach(() => {
    sendFrom.mockClear();
    unseed = seedAI(CONNECTED_MODEL);
  });
  afterEach(() => {
    cleanup();
    unseed();
  });

  it('under the latest reply, one tap sends the answer', () => {
    render(<TranscriptMessages messages={[msg('u1', 'user', 'when?'), msg('a1', 'assistant', SINGLE)]} busy={false} retryVia={VIA} />);
    expect(screen.queryByText(/clawboy-options/)).toBeNull();
    expect(screen.getByTestId('chat-options')).toHaveAttribute('data-live', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Thursday/ }));
    const sent = (sendFrom.mock.calls[0] as unknown[])[1] as string;
    expect((sendFrom.mock.calls[0] as unknown[])[0]).toEqual(VIA);
    expect(parseAnswers(sent)).toEqual({ _single: 'Thursday works' });
    expect(sent.endsWith('\n\nThursday')).toBe(true);
  });

  it('several questions page through and go as one message', () => {
    render(<TranscriptMessages messages={[msg('u1', 'user', 'plan it'), msg('a1', 'assistant', MULTI)]} busy={false} retryVia={VIA} />);
    expect(screen.getByTestId('chat-options-page')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByRole('button', { name: /Tue/ }));
    expect(screen.getByTestId('chat-options-page')).toHaveTextContent('2 of 2');
    expect(screen.queryByTestId('chat-option-input')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-options-send'));
    expect(parseAnswers((sendFrom.mock.calls[0] as unknown[])[1] as string)).toEqual({ day: 'tue', remind: null });
  });

  it('once answered, shows the pick, and the answer reads as words', () => {
    const answer = composeAnswers(parseOptions(SINGLE).questions!, { _single: 'Tuesday works' });
    render(
      <TranscriptMessages
        messages={[msg('u1', 'user', 'when?'), msg('a1', 'assistant', SINGLE), msg('u2', 'user', answer), msg('a2', 'assistant', 'Done.')]}
        busy={false}
        retryVia={VIA}
      />
    );
    expect(screen.getByTestId('chat-options')).toHaveAttribute('data-live', 'false');
    expect(screen.getByRole('button', { name: /Tuesday/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Tuesday/ })).toBeDisabled();
    expect(screen.queryByText(/clawboy-answers/)).toBeNull();
    expect(screen.queryByTestId('chat-edit')).toBeNull();
  });

  it('is not live while a reply is still arriving or chat cannot send', () => {
    render(<TranscriptMessages messages={[msg('u1', 'user', 'when?'), msg('a1', 'assistant', SINGLE)]} busy retryVia={VIA} />);
    expect(screen.getByTestId('chat-options')).toHaveAttribute('data-live', 'false');
  });
});
