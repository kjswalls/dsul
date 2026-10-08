'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUpRight, CircleAlert, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { detectKeyProvider, isPlausibleKey, mismatchedKey, type DetectedProvider } from '@/lib/ai-key-prefix';
import { PROVIDER_META, type ApiErrorCode, type ConnectRequest, type ModelProviderId } from '@/lib/ai-types';
import { cn } from '@/lib/utils';
import type { KeyFieldHandle } from './key-field';
import {
  KEY_STARTS,
  NOT_A_WHOLE_KEY,
  checkFailureCopy,
  companyName,
  keyPageLabel,
  spendFlowResult,
  sendToLabel,
  useResetsAt,
  withArticle,
  wrongKindCopy,
  type Elsewhere,
} from './connect-shared';

/**
 * Sending a pasted key to be checked, and what each answer says: the one
 * mechanism behind every key box in the connect card, its folds and the fix
 * home (connect-ai.tsx, connect-fix.tsx).
 *
 * The key is read out of the box at send time and goes nowhere but the PUT
 * (lib/ai-connection-store.ts `connect`). A key that fails stays in the box,
 * and the note says why; one that works is emptied out of it at once.
 */

/** What the box's last key said, in a note under it. */
export type CheckNote =
  /** Too short, or with spaces in it: refused here, before anything is sent. */
  | { kind: 'invalid' }
  /** A paste no company's prefix matches: it waits for Connect, and this says so quietly. */
  | { kind: 'undetected'; provider: DetectedProvider }
  /** Another company's key in this one's box: nothing was sent. */
  | { kind: 'wrong'; detected: DetectedProvider; provider: ModelProviderId; baseUrl: string | null }
  /** The check's answer. */
  | {
      kind: 'failure';
      code: ApiErrorCode;
      provider: ModelProviderId;
      baseUrl: string | null;
      limitedUntil: string | null;
      field: string | null;
    };

/** Where a key is out being checked, for "Checking your key with Google…". */
export interface CheckTarget {
  provider: ModelProviderId;
  baseUrl: string | null;
}

/**
 * Answers checking again cannot change: they need a wait, an edit, or another
 * service. Every other failure note offers [Check again].
 */
const NO_RETRY: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'busy',
  'region',
  'invalid',
  'blocked_url',
  'model_required',
  'conflict',
  'unavailable',
  'wrong_provider',
  'too_large',
  'unsupported_media',
]);

/** A note that carries its own actions: the box's own [Connect] steps aside for them. */
export function noteHasActions(note: CheckNote | null): boolean {
  if (!note) return false;
  if (note.kind === 'wrong') return true;
  return note.kind === 'failure' && !NO_RETRY.has(note.code);
}

export function useKeyCheck({
  field,
  onChecking,
  onOk,
  onNote,
}: {
  field: RefObject<KeyFieldHandle | null>;
  /** A check went out (its target) or came back (null). */
  onChecking?: (target: CheckTarget | null) => void;
  /** It worked. The box is already empty. */
  onOk: (o: { freeTier: boolean }) => void;
  /** Something was said about the box's key. */
  onNote?: (note: CheckNote) => void;
}) {
  const [note, setNote] = useState<CheckNote | null>(null);
  // Bumped with every note an action brings, so the same refusal twice still
  // scrolls into view the second time.
  const [said, setSaid] = useState(0);
  // Where the box's key is out being checked, while it is.
  const [target, setTarget] = useState<CheckTarget | null>(null);
  const inFlight = useRef(false);
  const noteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (said > 0) noteRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [said]);

  const say = (next: CheckNote) => {
    setNote(next);
    setSaid((n) => n + 1);
    onNote?.(next);
  };

  /**
   * Sends the box's key to `provider`. Checked here first, so nothing that
   * can't be a key leaves the page and nothing detected as another company's
   * goes to this one (the route refuses both again). Focus goes back to the
   * box whatever pressed this, since that control may be about to go.
   */
  const send = async (provider: ModelProviderId, extra: { baseUrl?: string; model?: string } = {}) => {
    field.current?.focus();
    if (inFlight.current || useAIConnectionStore.getState().busy === 'connect') return;
    spendFlowResult();
    const key = field.current?.read() ?? '';
    const baseUrl = extra.baseUrl ?? null;
    if (!isPlausibleKey(key)) {
      say({ kind: 'invalid' });
      return;
    }
    const mismatch = mismatchedKey(provider, key);
    if (mismatch) {
      say({ kind: 'wrong', detected: mismatch, provider, baseUrl });
      return;
    }
    const guess = detectKeyProvider(key);
    const req: ConnectRequest = { provider, apiKey: key };
    if (extra.baseUrl) req.baseUrl = extra.baseUrl;
    if (extra.model) req.model = extra.model;
    const out: CheckTarget = { provider, baseUrl };
    inFlight.current = true;
    setNote(null);
    setTarget(out);
    onChecking?.(out);
    const result = await useAIConnectionStore.getState().connect(req);
    inFlight.current = false;
    setTarget(null);
    onChecking?.(null);
    if (result.ok) {
      field.current?.clear();
      onOk({ freeTier: result.freeTier === true });
      return;
    }
    const detected = result.code === 'wrong_provider' ? (result.detected ?? guess) : null;
    if (detected && detected !== provider) {
      say({ kind: 'wrong', detected, provider, baseUrl });
      return;
    }
    say({
      kind: 'failure',
      code: result.code,
      provider,
      baseUrl,
      limitedUntil: result.limitedUntil ?? null,
      field: result.field ?? null,
    });
  };

  return {
    note,
    /** Says something about the box without sending (a paste the prefix table can't place). */
    say,
    /** The box changed: whatever was said about the last key no longer applies. */
    forget: () => setNote(null),
    target,
    send,
    noteRef,
  };
}

/** The honey note: something went wrong, the key is still in the box. Never lime. */
function HoneyNote({
  noteRef,
  testId,
  data,
  text,
  children,
}: {
  noteRef: RefObject<HTMLDivElement | null>;
  testId: string;
  data: Record<string, string>;
  text: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div ref={noteRef} data-testid={testId} {...data} className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2.5">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
      <div className="flex min-w-0 flex-col gap-2">
        <p role="alert" className="text-sm leading-snug text-foreground">
          {text}
        </p>
        {children}
      </div>
    </div>
  );
}

/** A company's key prefixes, in the mono face: "AQ. or AIza". */
export function KeyStarts({ provider }: { provider: DetectedProvider }) {
  const starts = KEY_STARTS[provider];
  return (
    <>
      {starts.map((s, i) => (
        <span key={s}>
          {i > 0 && ' or '}
          <code className="font-mono text-[0.95em]">{s}</code>
        </span>
      ))}
    </>
  );
}

const QUIET_ACTION =
  'rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * The note under a key box. Its buttons are outline or quiet, never lime: the
 * setup column has none (R19), and a note is never the page's main action.
 */
export function CheckNoteView({
  note,
  noteRef,
  elsewhere,
  testId = 'connect-note',
  onCheckAgain,
  onUseIt,
  onClear,
}: {
  note: CheckNote;
  noteRef: RefObject<HTMLDivElement | null>;
  /** Where a key from another service can go, for the region line. */
  elsewhere: Elsewhere;
  testId?: string;
  onCheckAgain: () => void;
  onUseIt: (provider: DetectedProvider) => void;
  onClear: () => void;
}) {
  const resetsAtOf = useResetsAt();

  switch (note.kind) {
    case 'undetected': {
      const company = companyName(note.provider);
      return (
        <div ref={noteRef} data-testid={testId} data-note="undetected">
          <p className="text-xs leading-snug text-muted-foreground">
            That doesn’t look like {withArticle(company)} key. {company}’s keys start with{' '}
            <KeyStarts provider={note.provider} />.
          </p>
        </div>
      );
    }
    case 'invalid':
      return <HoneyNote noteRef={noteRef} testId={testId} data={{ 'data-note': 'invalid' }} text={NOT_A_WHOLE_KEY} />;
    case 'wrong':
      return (
        <div
          ref={noteRef}
          data-testid={testId}
          data-note="wrong"
          data-detected={note.detected}
          className="flex gap-2 rounded-lg border border-border bg-background px-3 py-2.5"
        >
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-2">
            <p role="alert" className="text-sm leading-snug text-foreground">
              {wrongKindCopy(note.detected, note.provider, note.baseUrl)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onUseIt(note.detected)}>
                {sendToLabel(note.detected)}
              </Button>
              <button type="button" onClick={onClear} className={QUIET_ACTION}>
                Clear
              </button>
            </div>
          </div>
        </div>
      );
    case 'failure': {
      const text = checkFailureCopy(note.code, note.provider, {
        baseUrl: note.baseUrl,
        resetsAt: resetsAtOf(note.limitedUntil),
        elsewhere,
        field: note.field,
      });
      const keyPage = note.code === 'key_rejected' ? PROVIDER_META[note.provider].keyHelpUrl : null;
      const again = !NO_RETRY.has(note.code);
      return (
        <HoneyNote
          noteRef={noteRef}
          testId={testId}
          data={{ 'data-note': 'failure', 'data-code': note.code }}
          text={text}
        >
          {(again || keyPage) && (
            <div className="flex flex-wrap items-center gap-2">
              {again && (
                <Button type="button" variant="outline" size="sm" onClick={onCheckAgain}>
                  Check again
                </Button>
              )}
              {keyPage && <KeyPageLink href={keyPage} label={keyPageLabel(note.provider, note.baseUrl)} />}
            </div>
          )}
        </HoneyNote>
      );
    }
  }
}

/** Where a company's keys are made, in a new tab. */
export function KeyPageLink({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <Button asChild variant="outline" size="sm" className={cn('self-start', className)}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ArrowUpRight aria-hidden className="size-3.5" />
      </a>
    </Button>
  );
}
