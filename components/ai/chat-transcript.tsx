'use client';

import { Fragment, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Check, Copy, Pencil, RotateCcw, Wand2 } from 'lucide-react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProposalCard } from '@/components/ai/proposal-card';
import { TypingIndicator } from '@/components/ui/typing-indicator';
import { useConversationsStore, type ChatMessage } from '@/lib/conversations-store';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import {
  canUndoReceipt,
  placeReceipts,
  receiptCopy,
  useChatReceipts,
  useConversationReceipts,
  type ChatReceipt,
} from '@/lib/chat-receipts';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useProposalStore } from '@/lib/proposal-store';
import { buildPlanPrompt } from '@/lib/plan-prompt';
import { chatErrorCopy, isRetryableReplyError } from '@/lib/chat-errors';
import { sendFrom } from '@/lib/open-chat';
import type { ComposerBinding } from '@/lib/rail-store';
import { chatAssistantName, stripReasoningTags } from '@/lib/chat-utils';
import { clockTime } from '@/lib/format-chat-timestamp';
import { prefersReducedMotion } from '@/lib/zen-transition';
import type { Answerer } from '@/lib/conversation-types';

/**
 * chat-transcript.tsx — a conversation's messages, the one way every
 * conversation surface draws them: Ask's conversation view (the scroller
 * below, `ChatTranscript`) and an item's own conversation (the list alone,
 * `TranscriptMessages`, inside the item's body, which is its scroller).
 *
 * Claude's shape (the approved Full Chat page):
 *  - YOURS: right-aligned, a soft bubble, no avatar.
 *  - REPLIES: full width, plain markdown, no bubble, no avatar, no card.
 *  - UNDER A FINISHED REPLY: Copy and its time, on hover and on focus within
 *    (always on a touch screen, which has no hover). Nothing there is lime, so
 *    the fade that hides them dims no accent.
 *  - STATUS LINES, muted and never content: "Stopped" after a stopped reply's
 *    partial text; a failed reply's words by its CODE (lib/chat-errors.ts,
 *    never the stored text, which holds none); "Not saved" once per turn the
 *    account will never hold.
 *  - RECEIPTS where a plan was accepted (lib/chat-receipts.ts): what changed,
 *    with Undo while it is still the last thing done; memory only.
 *  - TRY AGAIN under the latest reply when it was stopped, or failed in a way
 *    asking again might get past (`isRetryableReplyError`): the same question
 *    sent again as a new turn, so nothing saved is rewritten. The failed turn
 *    stays; the model never hears it (chat-transport.ts drops a question an
 *    error answered).
 *  - EDIT under your latest question: change the words and send them as a
 *    new turn after the old pair, which stays, saved and as the model hears
 *    it (Kirby's call, 2026-10-10: history is only ever added to). The latest
 *    question only, so the new turn lands right under the one it corrects.
 *  - A DIVIDER where who answers changes between replies: each message records
 *    its answerer, and a conversation may be continued under the other one.
 *  - TO A SCREEN READER: the transcript is a log that does not read the stream
 *    out word by word; one polite status line (ReplyStatus) says a reply has
 *    started and how it ended.
 */

/** "Your model answers from here" / "OpenClaw answers from here". */
export function answererDividerCopy(answerer: Answerer): string {
  return answerer === 'openclaw' ? 'OpenClaw answers from here' : 'Your model answers from here';
}

/**
 * Where a divider goes: before the turn of each reply whose answerer differs
 * from the last reply that named one. The turn starts at the question when the
 * question sits right above its reply, so the divider never splits a turn.
 * Index → the answerer from there on.
 */
export function answererDividers(messages: readonly ChatMessage[]): Map<number, Answerer> {
  const at = new Map<number, Answerer>();
  let last: Answerer | null = null;
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.answerer) return;
    if (last && m.answerer !== last) {
      const prev = messages[i - 1];
      at.set(prev && prev.role === 'user' && prev.id === m.replyTo ? i - 1 : i, m.answerer);
    }
    last = m.answerer;
  });
  return at;
}

/**
 * "Not saved", once per turn: under its reply, or under the question when no
 * reply came to carry it (a stop before the first word).
 */
function endsUnsavedTurn(messages: readonly ChatMessage[], i: number): boolean {
  const m = messages[i];
  const next = messages[i + 1];
  return m.sync === 'unsaved' && !(next?.sync === 'unsaved' && next.replyTo === m.id);
}

/**
 * The question to ask again under the latest reply, or null when there is no
 * Try again: the reply is not the last message, still arriving, finished
 * fine, or failed in a way the same words would fail again.
 */
export function retryQuestion(messages: readonly ChatMessage[]): string | null {
  const m = messages.at(-1);
  if (!m || m.role !== 'assistant') return null;
  if (m.status !== 'stopped' && !(m.status === 'error' && isRetryableReplyError(m.errorCode))) return null;
  let q: ChatMessage | undefined;
  for (let i = messages.length - 2; i >= 0 && !q; i--) {
    const c = messages[i];
    if (c.role === 'user' && (!m.replyTo || c.id === m.replyTo)) q = c;
  }
  return q?.content.trim() ? q.content : null;
}

/** Where Edit goes: the latest question in the thread, or -1 when there is none. */
export function editableQuestionIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return -1;
}

/**
 * The messages alone, with no scroller of their own.
 *
 * `planFor` is the conversation the latest reply's "Turn this into a plan"
 * answers on (`conv:<id>`); without it there is no such offer (an item's
 * conversation, whose item has its own Break-into-steps). `busy` hides it
 * while a reply is still arriving. `retryVia` is where Try again sends
 * (the composer binding this conversation's own box uses); without it there
 * is no Try again. Edit sends through it too, and without it there is no Edit.
 */
export function TranscriptMessages({
  messages,
  typing,
  busy,
  planFor,
  retryVia,
  receipts,
}: {
  messages: readonly ChatMessage[];
  typing: boolean;
  busy: boolean;
  planFor?: string;
  retryVia?: ComposerBinding;
  /** This conversation's accepted-plan receipts, and the conversation they belong to. */
  receipts?: { conversationId: string; list: readonly ChatReceipt[] };
}) {
  const dividers = answererDividers(messages);
  const placed = receipts?.list.length ? placeReceipts(messages.map((m) => m.id), receipts.list) : null;
  const receiptsAt = (i: number) =>
    receipts &&
    placed?.get(i)?.map((r) => <ReceiptLine key={r.actionId} conversationId={receipts.conversationId} r={r} />);
  const again = retryVia && !busy ? retryQuestion(messages) : null;
  const editAt = retryVia && !busy ? editableQuestionIndex(messages) : -1;
  return (
    <>
      {messages.map((m, i) => (
        <Fragment key={m.id}>
          {dividers.has(i) && <AnswererDivider answerer={dividers.get(i) as Answerer} />}
          {m.role === 'user' ? (
            <UserMessage m={m} notSaved={endsUnsavedTurn(messages, i)} editVia={i === editAt ? retryVia : undefined} />
          ) : (
            <Reply
              m={m}
              // Only the reply still arriving cares; every other one keeps its
              // props, so a streamed delta re-renders (and re-parses) one reply,
              // not the whole thread.
              typing={typing && m.status === 'streaming'}
              notSaved={endsUnsavedTurn(messages, i)}
              planFrom={planFor && i === messages.length - 1 && !busy ? { conversationId: planFor, messages } : undefined}
              retry={again && retryVia && i === messages.length - 1 ? { via: retryVia, text: again } : undefined}
            />
          )}
          {receiptsAt(i)}
        </Fragment>
      ))}
      {receiptsAt(-1)}
    </>
  );
}

/**
 * One accepted plan, said where it was asked for. Undo shows only while the
 * accept is still the planner's latest entry (canUndoReceipt), and takes the
 * undo strip's row for it down too, so the two never offer the same Undo.
 */
function ReceiptLine({ conversationId, r }: { conversationId: string; r: ChatReceipt }) {
  const latest = usePlannerStore((s) => s.actionLog[s.actionLog.length - 1 - s.historyIndex]?.id ?? null);
  const copy = receiptCopy(r);
  if (!copy) return null;
  const undoable = canUndoReceipt(r, latest);
  return (
    <div data-testid="chat-receipt" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Check className="size-3.5 shrink-0" aria-hidden />
      <span>{copy}</span>
      {undoable && (
        <button
          type="button"
          data-testid="chat-receipt-undo"
          onClick={() => {
            // Re-checked at the press: a change can land between render and click.
            const p = usePlannerStore.getState();
            if (!canUndoReceipt(r, p.actionLog[p.actionLog.length - 1 - p.historyIndex]?.id ?? null)) return;
            p.undo();
            useChatReceipts.getState().markUndone(conversationId, r.actionId);
            useUndoStripStore.getState().dismiss(r.actionId);
          }}
          className="rounded px-1 font-medium text-foreground underline-offset-2 hover:underline"
        >
          Undo
        </button>
      )}
    </div>
  );
}

/**
 * Named by its words: a separator's children are presentational, so the
 * visible line is hidden and the separator itself carries them.
 */
function AnswererDivider({ answerer }: { answerer: Answerer }) {
  const copy = answererDividerCopy(answerer);
  return (
    <div data-testid="answerer-divider" role="separator" aria-label={copy} className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span aria-hidden className="text-2xs text-muted-foreground">
        {copy}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  m,
  notSaved,
  editVia,
}: {
  m: ChatMessage;
  notSaved: boolean;
  /** Set on the latest question only, while nothing is arriving: where an edit is sent. */
  editVia?: ComposerBinding;
}) {
  const { canChat } = useAICapabilities();
  const [editing, setEditing] = useState(false);
  const canEdit = !!editVia && canChat;
  if (editing && canEdit) {
    return (
      <EditQuestion
        m={m}
        onCancel={() => setEditing(false)}
        onSend={(text) => {
          setEditing(false);
          void sendFrom(editVia, text);
        }}
      />
    );
  }
  return (
    <div data-message-role="user" data-message-id={m.id} className="group/question flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-secondary px-3 py-2 text-sm leading-relaxed text-foreground">
        {m.content}
      </div>
      {notSaved && <NotSaved />}
      {canEdit && (
        // A tool, so it fades like Copy under a reply; always on a touch screen.
        <button
          type="button"
          data-testid="chat-edit"
          onClick={() => setEditing(true)}
          className="flex items-center gap-1 rounded p-1 text-2xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/question:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Pencil className="size-3" aria-hidden />
          <span>Edit</span>
        </button>
      )}
    </div>
  );
});

/**
 * The latest question, open for editing. Send asks the edited words as a new
 * turn; the question as it was stays above, with its reply. Enter sends,
 * Shift+Enter is a new line, Escape puts it back.
 */
function EditQuestion({
  m,
  onCancel,
  onSend,
}: {
  m: ChatMessage;
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState(m.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const ready = text.trim().length > 0;
  const send = () => {
    if (ready) onSend(text);
  };
  return (
    <div data-message-role="user" data-message-id={m.id} data-testid="chat-edit-box" className="flex flex-col items-end gap-1.5">
      <textarea
        ref={ref}
        value={text}
        aria-label="Edit your question"
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="w-full max-w-[85%] resize-none rounded-2xl border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="chat-edit-cancel"
          onClick={onCancel}
          className="rounded-full px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="chat-edit-send"
          disabled={!ready}
          onClick={send}
          className="rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * A reply's markdown, styled by hand: the `prose` utilities need
 * @tailwindcss/typography, which the app does not load, and preflight strips
 * list markers and link styling, so a list read as loose lines and a link as
 * body text. Scoped to the reply rather than adding the plugin, which would
 * restyle every other surface carrying the same (inert) classes.
 */
export const REPLY_PROSE = [
  'break-words text-sm leading-relaxed text-foreground',
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1',
  '[&_:is(h1,h2,h3,h4)]:mt-3 [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:font-semibold',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_strong]:font-semibold [&_a]:text-success-text [&_a]:underline [&_a]:underline-offset-2',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.9em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
].join(' ');

const REPLY_REMARK = [remarkGfm];

/** Inside a reply's link: an image there is named by its alt text alone (no link in a link). */
const InReplyLink = createContext(false);

/**
 * A reply's image, as a link to it rather than an <img>. An image fetches its
 * URL the moment it renders, with no click, so a reply holding
 * `![](https://host/?q=…)` (a prompt-injected one, filling the query with
 * what the conversation said) would hand that to a third party; and saved
 * replies render on every open, on every device. A link waits for the user,
 * and shows them where it goes. Named by its alt text, else its address.
 */
function ReplyImage({ src, alt }: { src?: string | Blob; alt?: string } & ExtraProps) {
  const inLink = useContext(InReplyLink);
  const href = typeof src === 'string' ? src : '';
  const label = alt?.trim() || href;
  if (!label) return null;
  return inLink || !href ? <>{label}</> : <a href={href}>{label}</a>;
}

/**
 * Module scope, so a memoised Reply hands ReactMarkdown the same object every
 * render. The link is the default one (an <a> with its href and title), only
 * marking its inside for ReplyImage.
 */
const REPLY_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a: ({ node, ...props }) => (
    <InReplyLink.Provider value>
      <a {...props} />
    </InReplyLink.Provider>
  ),
  img: ReplyImage,
};

const Reply = memo(function Reply({
  m,
  typing,
  notSaved,
  planFrom,
  retry,
}: {
  m: ChatMessage;
  typing: boolean;
  notSaved: boolean;
  /** Set on the latest reply only, once it has finished. */
  planFrom?: { conversationId: string; messages: readonly ChatMessage[] };
  /** Set on the latest reply only, when it can be asked again (retryQuestion). */
  retry?: { via: ComposerBinding; text: string };
}) {
  const { canChat, canPropose, openclawTransport } = useAICapabilities();
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  // When today's limit lifts, while one holds: the server's word, read with
  // the connection (lib/ai-connection-store.ts `noteCallFailure` re-reads it).
  const limitedUntil = useAIConnectionStore((s) => s.model?.limitedUntil ?? null);
  const streaming = m.status === 'streaming';
  const text = m.content ? stripReasoningTags(m.content).replace(/^\[\[reply_to[^\]]*\]\]\s*/i, '') : '';

  return (
    <div data-message-role="assistant" data-message-id={m.id} className="group/reply flex flex-col gap-1">
      {text ? (
        <div className={REPLY_PROSE}>
          <ReactMarkdown remarkPlugins={REPLY_REMARK} components={REPLY_COMPONENTS}>
            {text}
          </ReactMarkdown>
        </div>
      ) : streaming ? (
        // The plugin answers in one piece, so it types; a stream that has not
        // started yet waits.
        typing && m.answerer === 'openclaw' && openclawTransport === 'plugin' ? <TypingIndicator /> : <LoadingDots />
      ) : null}
      {m.status === 'stopped' && (
        <p data-testid="chat-stopped-note" className="text-xs text-muted-foreground">
          Stopped
        </p>
      )}
      {/* A failed reply's words are ours, by its code, never its content: they
          were not the AI's to save or to send back to a model. Not a live
          region of its own: ReplyStatus says it once, for the reply seen failing.
          A daily limit says when it lifts, on the planner's clock, while the
          connection says one holds; the saved code alone stays time-free. */}
      {m.status === 'error' && (
        <p data-testid="chat-error-note" className="text-sm text-muted-foreground">
          {chatErrorCopy(m.errorCode, m.answerer, { resetAt: limitedUntil, timeZone: userTimezone, timeFormat })}
        </p>
      )}
      {!streaming && (
        <div
          data-testid="reply-actions"
          className="flex items-center gap-2 opacity-0 transition-opacity group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {m.content && <CopyButton text={m.content} />}
          {m.createdAt > 0 && (
            // History's clock and Ask home's: "8:03", never "8:03 AM" beside them.
            <span data-testid="reply-time" className="text-2xs text-muted-foreground tabular-nums">
              {clockTime(m.createdAt, userTimezone, timeFormat)}
            </span>
          )}
        </div>
      )}
      {notSaved && <NotSaved />}
      {/* Outside the hover-faded row, as the plan offer is: a dead end has to
          show its way out without being looked for. */}
      {retry && canChat && <RetryButton via={retry.via} text={retry.text} />}
      {/* Latest reply only: one offer at the foot of the thread. Outside the
          hover-faded row above on purpose: it is the one control that has to be
          findable without knowing it is there. */}
      {planFrom && canPropose && m.content && m.status !== 'error' && (
        <PlanButton conversationId={planFrom.conversationId} messages={planFrom.messages} replyId={m.id} />
      )}
    </div>
  );
});

/**
 * Hand the exchange to the proposal path, so a conversation can end in
 * something you tap rather than something you then go and do by hand. It sends
 * the EXCHANGE, not the reply alone (lib/plan-prompt.ts says why), and the
 * card answers on this conversation's surface (`conv:<id>`): it renders inline
 * after the last message, and what it changes is counted on this conversation.
 */
function PlanButton({
  conversationId,
  messages,
  replyId,
}: {
  conversationId: string;
  messages: readonly ChatMessage[];
  replyId: string;
}) {
  const request = useProposalStore((s) => s.request);
  // Scoped to this conversation's own request: another surface's proposal
  // loading must not grey this out with no "Thinking it through…" in sight.
  const busy = useProposalStore((s) => s.status === 'loading' && s.lastRequest?.surface === `conv:${conversationId}`);
  return (
    <button
      type="button"
      onClick={() => request('ask', buildPlanPrompt([...messages], replyId), undefined, { conversationId })}
      disabled={busy}
      data-testid="chat-make-plan"
      className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:border-ai/40 hover:text-foreground disabled:opacity-50"
    >
      <Wand2 className="size-3 text-ai" aria-hidden />
      Turn this into a plan
    </button>
  );
}

/**
 * Ask the same question again, as a new turn through the conversation's own
 * binding (sendFrom, the one place a send is decided). The button goes as the
 * new turn lands, since it is no longer the latest reply's.
 */
function RetryButton({ via, text }: { via: ComposerBinding; text: string }) {
  return (
    <button
      type="button"
      onClick={() => void sendFrom(via, text)}
      data-testid="chat-retry"
      className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <RotateCcw className="size-3" aria-hidden />
      Try again
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      data-testid="reply-copy"
      aria-label={copied ? 'Copied' : 'Copy reply'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {}
        );
      }}
      className="flex items-center gap-1 rounded p-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {/* Not the success green: that is the lime accent, and this row fades. */}
      {copied ? <Check className="size-3 text-foreground" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/**
 * A turn the account will never hold: the save was refused, or gave up after
 * its retries. Not behind the hover fade: it is news about the conversation,
 * not a tool.
 */
function NotSaved() {
  return (
    <span data-testid="chat-not-saved" className="text-2xs text-muted-foreground">
      Not saved
    </span>
  );
}

/** A reply that has not started yet. Silent: ReplyStatus says so in words. Still under reduced motion. */
function LoadingDots() {
  return (
    <span data-testid="reply-dots" aria-hidden className="inline-flex items-center gap-1 py-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground motion-reduce:animate-none"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

/** The latest reply, if any. */
function lastReply(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i];
  return undefined;
}

/**
 * What a listener is told about the reply on its way: once that it started
 * ("OpenClaw is replying…"), once how it ended ("Reply finished.", "Stopped.",
 * or a failure in our words). A polite live region, always mounted with its
 * transcript; a transcript that arrives whole says nothing, since nothing
 * happened while it was open.
 */
export function ReplyStatus({ messages }: { messages: readonly ChatMessage[] }) {
  const last = lastReply(messages);
  const streaming = last?.status === 'streaming';
  // The reply seen arriving here, as derived state: its end is news, an old
  // reply's is not.
  const [watched, setWatched] = useState<string | null>(null);
  if (streaming && last && watched !== last.id) setWatched(last.id);

  let words = '';
  if (last && streaming) words = `${chatAssistantName(last.answerer ?? 'model')} is replying…`;
  else if (last && last.id === watched) {
    words =
      last.status === 'stopped'
        ? 'Stopped.'
        : last.status === 'error'
          ? chatErrorCopy(last.errorCode, last.answerer)
          : 'Reply finished.';
  }
  return (
    <p role="status" data-testid="reply-status" className="sr-only">
      {words}
    </p>
  );
}

/** Within this many pixels of the bottom, the view follows what arrives. */
export const FOLLOW_PX = 120;

const NO_MESSAGES: ChatMessage[] = [];

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/** A message's element in the transcript, by id. */
function messageNode(el: HTMLElement, id: string): HTMLElement | null {
  return Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find((n) => n.dataset.messageId === id) ?? null;
}

/** Where a message sits in the scroller's visible box, in pixels from its top. */
const offsetIn = (el: HTMLElement, node: HTMLElement) => node.getBoundingClientRect().top - el.getBoundingClientRect().top;

/**
 * A conversation's transcript in its own scroller: Ask's conversation view.
 *
 * SCROLLING. What arrives (a streamed reply, the plan card, a page loaded
 * underneath) is followed only while the view was within FOLLOW_PX of the
 * bottom; scrolled further up, the view stays where the reader put it and a
 * "Jump to latest" pill shows instead, which scrolls down (smoothly, unless
 * motion is reduced) and goes. The reader's own send always goes to the
 * bottom, and a transcript arriving whole (an open, a fetch) lands there.
 * "Load earlier" keeps the scroll where it was: the page lands above the
 * line being read, held by that message's own position (whatever grew at the
 * bottom meanwhile), not by a distance from the bottom.
 *
 * FOCUS. Two controls go away as they are used: "Jump to latest" hands focus
 * to the conversation's box, and "Load earlier", once there is nothing more
 * to load, to the transcript itself. While a page is on its way it stays
 * focusable (aria-disabled, not disabled, which would drop focus to <body>).
 */
export function ChatTranscript({ id }: { id: string }) {
  const messages = useConversationsStore((s) => s.threads[id]?.messages ?? NO_MESSAGES);
  const typing = useConversationsStore((s) => !!s.threads[id]?.typing);
  const hasEarlier = useConversationsStore((s) => !!s.threads[id]?.hasEarlier);
  const busy = useConversationsStore((s) => !!s.sending[`conv:${id}`] || !!s.threads[id]?.streaming);
  const cardUp = useProposalStore((s) => s.status !== 'idle' && s.lastRequest?.surface === `conv:${id}`);
  const receipts = useConversationReceipts(id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Within FOLLOW_PX of the bottom as of the last scroll: what arrives next is followed. */
  const following = useRef(true);
  /**
   * A smooth jump to the bottom under way: its own scroll events pass through
   * FOLLOW_PX on the way down, and must neither stop following nor bring the
   * pill back for the rest of the ride.
   */
  const jumping = useRef(false);
  const [jump, setJump] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** The message being read when Load earlier was pressed, and where it sat in the scroller. */
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  /** Load earlier held focus as it went: the transcript takes it. */
  const earlierFocus = useRef(false);
  const seen = useRef<{ count: number; first: string | undefined; lastUser: string | undefined }>({
    count: 0,
    first: undefined,
    lastUser: undefined,
  });

  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') {
      jumping.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else el.scrollTop = el.scrollHeight;
    following.current = true;
    setJump(false);
  }, []);

  /** Something grew: follow it, or offer the pill. */
  const grew = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (following.current) {
      el.scrollTop = el.scrollHeight;
      setJump(false);
    } else {
      setJump(distanceFromBottom(el) > FOLLOW_PX);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = seen.current;
    let lastUser: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0 && !lastUser; i--) if (messages[i].role === 'user') lastUser = messages[i];
    seen.current = { count: messages.length, first: messages[0]?.id, lastUser: lastUser?.id };
    if (!el) return;
    // An earlier page, landed above: the message being read goes back to
    // where it sat, measured, so native scroll anchoring having moved the
    // scroller already (or not) makes no difference, nor does anything that
    // grew at the bottom while the page was on its way.
    if (anchor.current !== null && messages[0]?.id !== prev.first && prev.count > 0) {
      const node = messageNode(el, anchor.current.id);
      if (node) el.scrollTop += offsetIn(el, node) - anchor.current.offset;
      anchor.current = null;
      return;
    }
    // The transcript arriving whole, or the reader's own send: the bottom.
    const sent = !!lastUser && lastUser.id !== prev.lastUser && lastUser.sync === 'pending' && prev.count > 0;
    if ((prev.count === 0 && messages.length > 0) || sent) {
      toBottom(false);
      return;
    }
    grew();
  }, [messages, typing, cardUp, toBottom, grew]);

  // Growth no message change shows: markdown reflowing, the card's own
  // states, a window resized narrower.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => grew());
    ro.observe(content);
    return () => ro.disconnect();
  }, [grew]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = distanceFromBottom(el) <= FOLLOW_PX;
    if (jumping.current) {
      // The jump's own ride down: it ends at the bottom.
      if (near) jumping.current = false;
      return;
    }
    following.current = near;
    setJump(!near);
  };

  // The ride down can end short of FOLLOW_PX (the reader grabbed the scroll):
  // `scrollend` says it is over either way, and the next scroll is the
  // reader's own.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ended = () => {
      if (!jumping.current) return;
      jumping.current = false;
      const near = distanceFromBottom(el) <= FOLLOW_PX;
      following.current = near;
      setJump(!near);
    };
    el.addEventListener('scrollend', ended);
    return () => el.removeEventListener('scrollend', ended);
  }, []);

  /**
   * "Jump to latest": the bottom, and the box, when the pill (about to go)
   * held focus. The phone's conversation has no box of its own (the dock's is
   * its box, and stays disabled while a reply streams, which is when this
   * mostly shows), so there the log takes the focus, as the last "Load
   * earlier" hands it, rather than dropping it to <body>.
   */
  const jumpToLatest = (e: React.MouseEvent<HTMLButtonElement>) => {
    const hadFocus = e.currentTarget === document.activeElement;
    toBottom(!prefersReducedMotion());
    if (!hadFocus) return;
    const log = scrollRef.current;
    const box = log
      ?.closest('[data-ask-conversation]')
      ?.querySelector<HTMLTextAreaElement>('[data-ask-composer] textarea');
    (box ?? log)?.focus({ preventScroll: true });
  };

  const loadEarlier = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (loadingEarlier) return;
    // Pressed with focus on it: should the last page take the button away,
    // the transcript takes the focus. Noted now, since the page's render may
    // have removed the button before this call resumes.
    earlierFocus.current = e.currentTarget === document.activeElement;
    const el = scrollRef.current;
    const first = el && messages[0] ? messageNode(el, messages[0].id) : null;
    if (el && first && messages[0]) anchor.current = { id: messages[0].id, offset: offsetIn(el, first) };
    setLoadingEarlier(true);
    try {
      await useConversationsStore.getState().loadEarlier(id);
    } finally {
      setLoadingEarlier(false);
      const t = useConversationsStore.getState().threads[id];
      // Nothing came (a failure): there is nothing to anchor.
      if (t?.messages[0]?.id === seen.current.first) anchor.current = null;
      // More to load: the button stays, and its focus with it.
      if (t?.hasEarlier) earlierFocus.current = false;
    }
  };

  // The last page: the button goes, and with it the focus it held. Only focus
  // that went nowhere moves: a reader who has moved on is left there.
  useEffect(() => {
    if (hasEarlier || !earlierFocus.current) return;
    earlierFocus.current = false;
    const at = document.activeElement;
    if (!at || at === document.body) scrollRef.current?.focus({ preventScroll: true });
  }, [hasEarlier]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* A log that reads nothing out as it streams (aria-live off): the
          status line below says when a reply starts and how it ends. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        tabIndex={-1}
        data-testid="chat-transcript"
        className="min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div ref={contentRef} className="flex flex-col gap-3 px-5 pt-2 pb-4">
          {hasEarlier && (
            <button
              type="button"
              onClick={(e) => void loadEarlier(e)}
              aria-disabled={loadingEarlier || undefined}
              data-testid="chat-load-earlier"
              className="self-center rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:opacity-60"
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </button>
          )}
          <TranscriptMessages
            messages={messages}
            typing={typing}
            busy={busy}
            planFor={id}
            retryVia={{ kind: 'conversation', id }}
            receipts={{ conversationId: id, list: receipts }}
          />
          {/* The conversation's plan card, inline after the last message; it
              outlives this view unmounting (rail-store drops it once the
              conversation has left both Ask stacks). */}
          <ProposalCard surface={`conv:${id}`} />
        </div>
      </div>
      <ReplyStatus messages={messages} />
      {jump && (
        <button
          type="button"
          onClick={jumpToLatest}
          data-testid="chat-jump-latest"
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-foreground shadow-soft-sm transition-colors hover:bg-muted"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** Three bubbles while a conversation's transcript is on its way. */
export function TranscriptSkeleton() {
  // Said in words: a label on a role-less box is not read out (History's
  // skeletons do the same), and the bubbles are for the eye only.
  return (
    <div data-testid="chat-transcript-loading" className="flex flex-col gap-4 px-5 pt-3">
      <span className="sr-only">Loading conversation…</span>
      <div aria-hidden className="h-9 w-3/5 self-end rounded-2xl bg-muted motion-safe:animate-pulse" />
      <div aria-hidden className="h-14 w-11/12 rounded-2xl bg-muted motion-safe:animate-pulse" />
      <div aria-hidden className="h-9 w-2/5 self-end rounded-2xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
