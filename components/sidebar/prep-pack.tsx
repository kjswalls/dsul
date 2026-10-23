'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import {
  packApplies,
  packAction,
  packHref,
  packKindName,
  packSends,
  packLabel,
  packIsQuestion,
  packIsStale,
  packQuestions,
  packReading,
  packText,
  siteOf,
  type Pack,
  type PackQuestion,
  type PrepPack,
} from '@/lib/prep-packs';
import { UNDO_MS, usePrepPacksStore } from '@/lib/prep-packs-store';
import { doneNext } from '@/lib/do-stuff';
import { answerLearnStyle, noteTaken } from '@/lib/learn-style';
import { cn } from '@/lib/utils';

/**
 * A prep pack in the braindump (lib/prep-packs.ts): the chip on a "done for
 * you" row that says what is ready, and the card it opens. On desktop the card
 * peeks out beside the row (memory/plans/power-mode.md: roomy, editable,
 * ↑ ↓ between packs, the primary action on Enter); on the phone it opens in
 * place under the row, full width.
 *
 * Edits stay in the card: they shape what Copy and Open take with them, and
 * are never written back (the pack is the AI's draft, the sent thing is the
 * user's). Nothing leaves the app without the user's own tap.
 */

/** The row's trailing chip: what is ready. Opens (or closes) the card. */
export function PackChip({
  stored,
  open,
  onToggle,
}: {
  stored: PrepPack;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onKeyDown={(e) => e.stopPropagation()}
      aria-expanded={open}
      aria-label={`${packIsQuestion(stored.pack) ? 'Your AI has a question' : `${packKindName(stored.pack)} ready`}. ${open ? 'Close' : 'Open'} it`}
      data-testid="prep-pack-chip"
      // The ready words (components/ai/ai-work-badge.tsx): aurora text, no fill.
      data-ai-chip={packIsQuestion(stored.pack) ? 'question' : 'ready'}
      className="-my-1.5 cursor-pointer"
    >
      {packLabel(stored.pack)}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

/** The pack's fields, editable in place. */
function PackFields({ pack, onChange }: { pack: Pack; onChange: (next: Pack) => void }) {
  switch (pack.kind) {
    case 'email':
      return (
        <>
          <Field label="To">
            <Input value={pack.to ?? ''} placeholder="who it goes to" onChange={(e) => onChange({ ...pack, to: e.target.value })} />
          </Field>
          <Field label="Subject">
            <Input value={pack.subject} onChange={(e) => onChange({ ...pack, subject: e.target.value })} />
          </Field>
          <Field label="Message">
            <Textarea value={pack.body} rows={7} onChange={(e) => onChange({ ...pack, body: e.target.value })} />
          </Field>
        </>
      );
    case 'message':
      return (
        <>
          {pack.to !== undefined && (
            <Field label="To">
              <Input value={pack.to} onChange={(e) => onChange({ ...pack, to: e.target.value })} />
            </Field>
          )}
          <Field label="Message">
            <Textarea value={pack.body} rows={4} onChange={(e) => onChange({ ...pack, body: e.target.value })} />
          </Field>
        </>
      );
    case 'call':
      return (
        <>
          <Field label="Who">
            <Input value={pack.who} onChange={(e) => onChange({ ...pack, who: e.target.value })} />
          </Field>
          <Field label="Number">
            <Input
              value={pack.number ?? ''}
              inputMode="tel"
              placeholder="add the number"
              onChange={(e) => onChange({ ...pack, number: e.target.value })}
            />
          </Field>
          <Field label="What to say">
            <Textarea
              value={pack.script.map((s) => `- ${s}`).join('\n')}
              rows={5}
              onChange={(e) => onChange({ ...pack, script: lines(e.target.value) })}
            />
          </Field>
        </>
      );
    case 'steps':
      return (
        <Field label="Steps">
          <Textarea
            value={pack.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
            rows={5}
            onChange={(e) => onChange({ ...pack, steps: lines(e.target.value) })}
          />
        </Field>
      );
    case 'question':
      return null;
    case 'options':
      return (
        <div className="flex flex-col gap-2" data-testid="prep-pack-options">
          {pack.intro && <p className="text-[13px] text-muted-foreground">{pack.intro}</p>}
          {pack.options.map((o, i) => (
            <div key={i} className="rounded-[10px] border border-border px-3 py-2">
              <div className="text-[14px] leading-snug font-medium">{o.title}</div>
              {(o.when || o.price) && (
                <div className="font-num mt-0.5 text-xs text-muted-foreground">
                  {[o.when, o.price].filter(Boolean).join(' · ')}
                </div>
              )}
              {o.detail && <p className="mt-1 text-[13px] leading-snug">{o.detail}</p>}
              {o.url && <SiteLink url={o.url} className="mt-1.5" />}
            </div>
          ))}
        </div>
      );
    case 'list':
      return (
        <Field label="List">
          <Textarea
            value={pack.items.map((s) => `- ${s}`).join('\n')}
            rows={Math.min(10, Math.max(4, pack.items.length + 1))}
            onChange={(e) => onChange({ ...pack, items: lines(e.target.value) })}
          />
        </Field>
      );
    case 'form':
      return (
        <>
          {pack.fields.map((f, i) => (
            <Field key={i} label={f.label}>
              <div className="flex items-center gap-1.5">
                <Input
                  value={f.value}
                  placeholder="you fill this in"
                  onChange={(e) =>
                    onChange({ ...pack, fields: pack.fields.map((g, j) => (j === i ? { ...g, value: e.target.value } : g)) })
                  }
                />
                <CopyButton text={f.value} label={`Copy ${f.label}`} />
              </div>
            </Field>
          ))}
        </>
      );
    case 'draft':
      return (
        <>
          {pack.title !== undefined && (
            <Field label="Title">
              <Input value={pack.title} onChange={(e) => onChange({ ...pack, title: e.target.value })} />
            </Field>
          )}
          <Field label="Draft">
            <Textarea value={pack.body} rows={9} onChange={(e) => onChange({ ...pack, body: e.target.value })} />
          </Field>
        </>
      );
    case 'subtasks':
      return (
        <Field label="Subtasks, one a line">
          <Textarea
            value={pack.subtasks.map((s) => `- ${s}`).join('\n')}
            rows={Math.min(9, Math.max(3, pack.subtasks.length + 1))}
            onChange={(e) => onChange({ ...pack, subtasks: lines(e.target.value) })}
          />
        </Field>
      );
    case 'answer':
      return (
        <Field label="What your AI found">
          <Textarea value={pack.answer} rows={5} onChange={(e) => onChange({ ...pack, answer: e.target.value })} />
        </Field>
      );
    case 'place':
      return (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3 py-2" data-testid="prep-pack-place">
          <div className="text-[14px] leading-snug font-medium">{pack.name}</div>
          {pack.address && (
            <div className="flex items-center gap-1.5 text-[13px]">
              <span className="min-w-0 flex-1 select-text">{pack.address}</span>
              <CopyButton text={pack.address} label="Copy the address" />
            </div>
          )}
          {pack.hours && <div className="text-[13px] text-muted-foreground">{pack.hours}</div>}
          {pack.phone && (
            <div className="font-num flex items-center gap-1.5 text-[13px]">
              <span className="min-w-0 flex-1 select-text">{pack.phone}</span>
              <CopyButton text={pack.phone} label="Copy the number" />
            </div>
          )}
          {pack.url && <SiteLink url={pack.url} title="Their site" />}
        </div>
      );
    case 'time':
      return (
        <div className="flex flex-col gap-2" data-testid="prep-pack-time">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Day">
              <Input
                type="date"
                value={pack.date ?? ''}
                className="w-[150px]"
                onChange={(e) => onChange({ ...pack, date: e.target.value || undefined })}
              />
            </Field>
            <Field label="At">
              <Input
                type="time"
                value={pack.time}
                className="w-[110px]"
                onChange={(e) => e.target.value && onChange({ ...pack, time: e.target.value })}
              />
            </Field>
            <Field label="Minutes">
              <Input
                type="number"
                min={5}
                max={480}
                step={5}
                value={pack.duration ?? ''}
                className="w-[84px]"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onChange({ ...pack, duration: n >= 5 && n <= 480 ? Math.round(n) : undefined });
                }}
              />
            </Field>
          </div>
          {pack.why && <p className="text-[13px] leading-snug text-muted-foreground">{pack.why}</p>}
        </div>
      );
    case 'pick':
      return (
        <div className="flex flex-col gap-2" data-testid="prep-pack-pick">
          {pack.question && <p className="text-[13px] text-muted-foreground">{pack.question}</p>}
          {pack.choices.map((c, i) => (
            <div
              key={i}
              data-recommended={i === pack.recommended || undefined}
              className={cn(
                'rounded-[10px] border px-3 py-2',
                i === pack.recommended ? 'border-foreground/40' : 'border-border'
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-[14px] leading-snug font-medium">{c.name}</span>
                {i === pack.recommended && <span className="text-[11.5px] font-medium">Your AI&rsquo;s pick</span>}
                {c.price && <span className="font-num text-xs text-muted-foreground">{c.price}</span>}
              </div>
              {(c.pros.length > 0 || c.cons.length > 0) && (
                <ul className="mt-1 flex flex-col gap-0.5 text-[13px] leading-snug">
                  {c.pros.map((p, j) => (
                    <li key={`p${j}`}>+ {p}</li>
                  ))}
                  {c.cons.map((p, j) => (
                    <li key={`c${j}`} className="text-muted-foreground">
                      − {p}
                    </li>
                  ))}
                </ul>
              )}
              {c.url && <SiteLink url={c.url} className="mt-1.5" />}
            </div>
          ))}
          <p className="text-[13px] leading-snug">{pack.why}</p>
        </div>
      );
  }
}

/**
 * A link the AI found, with the site it goes to written out: the page came
 * from the web, so the person sees where a tap leads before they tap.
 */
function SiteLink({ url, title, className }: { url: string; title?: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn('inline-flex max-w-full items-center gap-1 text-[12.5px] text-foreground underline underline-offset-2', className)}
    >
      <span className="truncate">{title || 'Open'}</span>
      <span className="shrink-0 text-muted-foreground no-underline">{siteOf(url)}</span>
    </a>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      disabled={!text.trim()}
      className="shrink-0 text-muted-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch {
          toast("Couldn't copy that.");
        }
      }}
    >
      Copy
    </Button>
  );
}

/** Where the facts came from, when the AI looked them up. */
function Sources({ sources }: { sources?: { title: string; url: string }[] }) {
  if (!sources?.length) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="prep-pack-sources">
      <span className="text-[11.5px] font-medium text-muted-foreground">Found on</span>
      {sources.map((src) => (
        <SiteLink key={src.url} url={src.url} title={src.title} />
      ))}
    </div>
  );
}

/**
 * A question pack: what the AI needs to know before it can get the item
 * ready, up to three questions (pick C, 2026-10-23). With one plain
 * question a tap on a likely answer is the send; otherwise taps select (several
 * for a "multi" one, like "What's settled already?") and "Get it ready" sends
 * them all. The answers go into the item's notes and the AI tries again
 * (prep-packs-store's `answer`).
 */
function QuestionBody({ itemId, questions }: { itemId: string; questions: readonly PackQuestion[] }) {
  const quick = questions.length === 1 && !questions[0].multi;
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''));
  // What your AI knows (lib/ai-knows.ts): off until ticked, for each answer.
  const [remember, setRemember] = useState(false);
  const answerOf = (i: number) => [...picked[i], ...(typed[i].trim() ? [typed[i].trim()] : [])].join(', ');
  const send = () => {
    const answers = questions.map((q, i) => ({ question: q.question, answer: answerOf(i) }));
    if (!answers.some((a) => a.answer)) return;
    usePrepPacksStore.getState().answer(itemId, answers, { remember });
  };
  const tap = (i: number, option: string) => {
    if (quick) return usePrepPacksStore.getState().answer(itemId, option, { remember });
    setPicked((all) =>
      all.map((list, at) => {
        if (at !== i) return list;
        if (questions[i].multi) return list.includes(option) ? list.filter((o) => o !== option) : [...list, option];
        return list[0] === option ? [] : [option];
      })
    );
  };
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="prep-pack-question"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {questions.map((q, i) => (
        <div key={i} className="flex flex-col gap-2">
          <p className="text-[14px] leading-snug">{q.question}</p>
          {q.multi && <p className="-mt-1 text-xs text-muted-foreground">Pick all that apply.</p>}
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question}>
              {q.options.map((o) => {
                const on = picked[i].includes(o);
                return (
                  <Button
                    key={o}
                    type="button"
                    size="sm"
                    variant={on ? 'default' : 'outline'}
                    {...(quick ? {} : q.multi ? { 'aria-pressed': on } : { role: 'radio', 'aria-checked': on })}
                    onClick={() => tap(i, o)}
                    data-testid="prep-pack-option"
                  >
                    {o}
                  </Button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              value={typed[i]}
              placeholder={q.options?.length ? 'Or say it your way' : 'Your answer'}
              aria-label={`Your answer: ${q.question}`}
              onChange={(e) => setTyped((all) => all.map((t, at) => (at === i ? e.target.value : t)))}
              data-testid="prep-pack-answer"
            />
            {quick && (
              <Button size="sm" type="submit" disabled={!typed[0].trim()}>
                Answer
              </Button>
            )}
          </div>
        </div>
      ))}
      <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Checkbox
          checked={remember}
          onCheckedChange={(v) => setRemember(v === true)}
          data-testid="prep-pack-remember"
        />
        Remember for other tasks
      </label>
      {!quick && (
        <div>
          <Button
            size="sm"
            type="submit"
            disabled={!questions.some((_, i) => answerOf(i))}
            data-testid="prep-pack-answer-all"
          >
            Get it ready
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * What the AI took the item to mean, when it was only fairly sure: one line
 * on top of the card. "Not quite?" offers the other likely meanings and a box;
 * either goes into the notes as "I meant: …" and the AI tries again
 * (prep-packs-store's `reread`).
 */
function ReadingLine({ itemId, reading, alternates }: { itemId: string; reading: string; alternates: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const reread = (meant: string) => {
    if (meant.trim()) usePrepPacksStore.getState().reread(itemId, meant);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-muted/60 px-3 py-2" data-testid="prep-pack-reading">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        <span className="min-w-0 flex-1">
          I took this as: <span className="font-medium text-foreground">{reading}</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="cursor-pointer text-[13px] underline decoration-border underline-offset-[3px] hover:text-foreground"
          data-testid="prep-pack-not-quite"
        >
          {open ? 'Close' : 'Not quite?'}
        </button>
      </div>
      {open && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reread(text);
          }}
        >
          {alternates.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Did you mean">
              {alternates.map((a) => (
                <Button key={a} type="button" size="sm" variant="outline" onClick={() => reread(a)} data-testid="prep-pack-alternate">
                  {a}
                </Button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              value={text}
              placeholder="Or say what you meant"
              aria-label="What you meant"
              onChange={(e) => setText(e.target.value)}
              data-testid="prep-pack-meant"
            />
            <Button size="sm" type="submit" disabled={!text.trim()}>
              Redo
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The card's header line for a question: one thing, a few, or a plan's shape. */
function questionHeading(questions: readonly PackQuestion[]): string {
  if (questions[0]?.multi) return 'Your AI wants to know what is settled';
  return questions.length === 1 ? 'Your AI needs one thing first' : 'Your AI needs a few things first';
}

interface CardProps {
  itemId: string;
  title: string;
  stored: PrepPack;
  /** "2 of 3" and the ↑ ↓ between packs; absent with only one. */
  nav?: { index: number; count: number; go: (dir: -1 | 1) => void };
  onClose: () => void;
  /**
   * The phone's deck: a swipe right takes the pack out (its primary action),
   * a swipe left leaves it for later (the next one). Never from inside a field.
   */
  swipe?: boolean;
  /** After Done or Discard; the deck stays open to deal the next. Defaults to onClose. */
  onSettled?: () => void;
  /**
   * Inside the item panel (PackInPanel): the panel already names the item and
   * has its own close, so the card drops its title and ✕.
   */
  embedded?: boolean;
}

/** The pack itself: a header, the fields, and the one tap that takes it out. */
/** How far a finger travels sideways before the deck acts on a swipe. */
const SWIPE_PX = 80;

export function PackCard({ itemId, title, stored, nav, onClose, swipe, onSettled = onClose, embedded }: CardProps) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  // Keyed by the caller on the pack (packKey), so ↑ ↓ or a fresh pack landing
  // starts again from what the AI wrote.
  const [pack, setPack] = useState<Pack>(stored.pack);
  const href = packHref(pack);
  const reading = packReading(stored.pack);

  // A draft leaving the card, changed by the person, is how the AI learns how
  // they write (lib/learn-style.ts). The first time, it asks.
  const taken = () => {
    if (noteTaken(stored.pack, pack) !== 'ask') return;
    const before = stored.pack;
    const after = pack;
    answerLearnStyle(false);
    toast('Want your AI to learn how you write from changes like this?', {
      action: { label: 'Learn', onClick: () => answerLearnStyle(true, before, after) },
      duration: 10_000,
    });
  };
  // The one-tap finish: once a message has gone to the mail or messages app
  // (or the share sheet), coming back asks "Sent it?" and Done ticks it off.
  const askSent = () => {
    const finish = () =>
      toast('Sent it?', {
        action: {
          label: 'Done',
          onClick: () => {
            onSettled();
            doneNext(itemId);
          },
        },
        duration: 15_000,
      });
    onReturn(finish);
  };
  const share = async () => {
    try {
      await navigator.share({ text: packText(pack) });
      taken();
      askSent();
    } catch (err) {
      // Closing the sheet is a choice; anything else falls back to Copy.
      if ((err as { name?: string })?.name !== 'AbortError') void copy();
    }
  };
  const canShare =
    !href && (pack.kind === 'message' || pack.kind === 'draft') && typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(packText(pack));
      toast('Copied');
      taken();
    } catch {
      toast("Couldn't copy that.");
    }
  };
  const apply = () => {
    const said = usePrepPacksStore.getState().apply(itemId, pack);
    if (!said) return;
    toast(said);
    onSettled();
  };
  const primary = () => {
    if (pack.kind === 'question') return;
    if (packApplies(pack)) return apply();
    // A web page (a form's link) opens beside dsul; mail and phone links hand off.
    if (href?.startsWith('https:')) window.open(href, '_blank', 'noopener,noreferrer');
    else if (href) window.location.assign(href);
    else if (canShare) return void share();
    else return void copy();
    taken();
    if (packSends(pack)) askSent();
  };

  const endSwipe = () => {
    start.current = null;
    setDx(0);
  };
  const swipeHandlers = swipe
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          const t = e.target as HTMLElement;
          if (e.pointerType !== 'touch' || t.closest('input, textarea, button, a')) return;
          start.current = { x: e.clientX, y: e.clientY };
        },
        onPointerMove: (e: React.PointerEvent) => {
          const st = start.current;
          if (!st) return;
          const x = e.clientX - st.x;
          if (Math.abs(e.clientY - st.y) > 32 && Math.abs(e.clientY - st.y) > Math.abs(x)) return endSwipe();
          setDx(Math.max(-140, Math.min(140, x)));
        },
        onPointerUp: () => {
          if (dx >= SWIPE_PX) primary();
          else if (dx <= -SWIPE_PX) nav?.go(1);
          endSwipe();
        },
        onPointerCancel: endSwipe,
      }
    : {};

  return (
    <div
      data-testid="prep-pack-card"
      {...swipeHandlers}
      style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)` } : undefined}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter' && !typing) {
          e.preventDefault();
          primary();
        } else if (nav && !typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          nav.go(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
      className={cn('flex max-h-[min(560px,80vh)] flex-col', swipe && 'touch-pan-y')}
    >
      <div className={cn('flex items-start gap-2', embedded ? 'px-3 pt-3 pb-1' : 'px-4 pt-4 pb-2')}>
        <div className="min-w-0 flex-1">
          {!embedded && <div className="text-[15px] leading-snug font-semibold">{title}</div>}
          <div className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', !embedded && 'mt-0.5')}>
            <AskMark tone="ink" className="size-3" />
            {pack.kind === 'question' ? questionHeading(packQuestions(pack)) : `${packKindName(pack)} · written by your AI`}
          </div>
        </div>
        {nav && (
          <div className="flex items-center" aria-label="Other things ready">
            <button
              type="button"
              aria-label="Previous"
              aria-keyshortcuts="ArrowUp"
              onClick={() => nav.go(-1)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ChevronUp className="size-4" />
            </button>
            <span className="font-num px-1 text-xs text-muted-foreground">
              {nav.index + 1} of {nav.count}
            </span>
            <button
              type="button"
              aria-label="Next"
              aria-keyshortcuts="ArrowDown"
              onClick={() => nav.go(1)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        )}
        {!embedded && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className={cn('flex min-h-0 flex-col gap-3 overflow-y-auto pb-3', embedded ? 'px-3' : 'px-4')}>
        {reading && <ReadingLine itemId={itemId} reading={reading.reading} alternates={reading.alternates} />}
        {pack.kind === 'question' ? (
          <QuestionBody itemId={itemId} questions={packQuestions(pack)} />
        ) : (
          <PackFields pack={pack} onChange={setPack} />
        )}
        {'sources' in pack && <Sources sources={pack.sources} />}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2.5">
        {pack.kind === 'question' ? null : packApplies(pack) ? (
          <Button size="sm" onClick={apply} data-testid="prep-pack-primary">
            {packAction(pack)}
          </Button>
        ) : href ? (
          <Button size="sm" asChild data-testid="prep-pack-primary">
            <a
              href={href}
              onClick={() => {
                taken();
                if (packSends(pack)) askSent();
              }}
              {...(href.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
            >
              {packAction(pack)}
            </a>
          </Button>
        ) : canShare ? (
          <Button size="sm" onClick={() => void share()} data-testid="prep-pack-primary">
            Share
          </Button>
        ) : (
          <Button size="sm" onClick={() => void copy()} data-testid="prep-pack-primary">
            {packAction(pack)}
          </Button>
        )}
        {(href || canShare) && pack.kind !== 'question' && (
          <Button size="sm" variant="ghost" onClick={() => void copy()} className="text-muted-foreground">
            Copy
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onSettled();
            dismissWithUndo(itemId);
          }}
          data-testid="prep-pack-dismiss"
          className="text-muted-foreground"
        >
          Discard
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onSettled();
            doneNext(itemId);
          }}
          data-testid="prep-pack-done"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Runs `then` when the person comes back to the page: the mail or messages
 * app took the screen and gave it back. On a desktop the page often never
 * hides (the mail app opens beside it), so it runs after a moment instead.
 */
function onReturn(then: () => void): void {
  let hidden = false;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    document.removeEventListener('visibilitychange', onChange);
    then();
  };
  const onChange = () => {
    if (document.visibilityState === 'hidden') hidden = true;
    else if (hidden) run();
  };
  document.addEventListener('visibilitychange', onChange);
  setTimeout(() => {
    if (!hidden) run();
  }, RETURN_GRACE_MS);
  // Gone for good (never came back this session): stop listening.
  setTimeout(() => {
    done = true;
    document.removeEventListener('visibilitychange', onChange);
  }, 30 * 60_000);
}

/** How long a page that never hid waits before asking "Sent it?". */
const RETURN_GRACE_MS = 1500;

const packKey = (card: CardProps) => `${card.itemId}:${card.stored.updatedAt}`;

/**
 * Discard, with an undo: the pack leaves at once and the toast can put it
 * back for as long as it shows (lib/prep-packs-store.ts holds the delete
 * until then). Every surface's Discard goes through here.
 */
function dismissWithUndo(itemId: string): void {
  const undo = usePrepPacksStore.getState().dismiss(itemId);
  if (!undo) return;
  toast('Discarded', { action: { label: 'Undo', onClick: undo }, duration: UNDO_MS });
}

/**
 * The pack in the item panel (item-detail-sections.tsx): where a ready chip
 * on any row leads. Nothing when the item has no pack, or one written for an
 * older title.
 */
export function PackInPanel({ itemId, title }: { itemId: string; title: string }) {
  const stored = usePrepPacksStore((s) => s.packs[itemId]);
  if (!stored || packIsStale(stored, title)) return null;
  return (
    <section
      data-testid="item-pack"
      className="rounded-[12px] border border-border bg-surface-2 shadow-[var(--shadow-elev-sm)]"
    >
      <PackCard key={`${itemId}:${stored.updatedAt}`} itemId={itemId} title={title} stored={stored} onClose={() => {}} embedded />
    </section>
  );
}

/**
 * The card beside its row on desktop. Anchored to the row (the wrapper the
 * caller passes as children), so it peeks out to the braindump's right.
 */
export function PackPeek({
  open,
  children,
  ...card
}: CardProps & { open: boolean; children: React.ReactNode }) {
  return (
    <Popover open={open} onOpenChange={(o) => !o && card.onClose()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[440px] max-w-[calc(100vw-24px)] rounded-[16px] border-border p-0 shadow-[var(--shadow-elev-lg)]"
      >
        <PackCard key={packKey(card)} {...card} />
      </PopoverContent>
    </Popover>
  );
}

/** The card in place under its row, on the phone. */
export function PackInline(card: CardProps) {
  return (
    <div className="my-1 rounded-[12px] border border-border bg-surface-2 shadow-[var(--shadow-elev-sm)]">
      <PackCard key={packKey(card)} {...card} />
    </div>
  );
}

/**
 * The phone's review deck: every pack ready, dealt one at a time in a sheet.
 * Swipe right or tap to take one out, swipe left (or "Later") for the next.
 * "Done" and "Discard" deal the next one in its place.
 */
export function PackDeck({
  open,
  onOpenChange,
  cards,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: readonly Omit<CardProps, 'nav' | 'onClose' | 'swipe' | 'onSettled'>[];
}) {
  const [index, setIndex] = useState(0);
  const count = cards.length;
  const at = count > 0 ? Math.min(index, count - 1) : 0;
  const card = cards[at];
  return (
    <Drawer open={open && count > 0} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="prep-pack-deck">
        <DrawerTitle className="sr-only">Things ready</DrawerTitle>
        {card && (
          <div className="px-3 pb-4">
            <PackCard
              key={`${card.itemId}:${card.stored.updatedAt}`}
              {...card}
              swipe
              nav={count > 1 ? { index: at, count, go: (dir) => setIndex((at + dir + count) % count) } : undefined}
              onClose={() => onOpenChange(false)}
              onSettled={() => {
                if (count <= 1) onOpenChange(false);
              }}
            />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
