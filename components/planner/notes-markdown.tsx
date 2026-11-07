'use client';

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { notesCaretFor, notesLineCount } from '@/lib/notes-markdown';
import { cn } from '@/lib/utils';

/**
 * An item's notes, rendered (lib/notes-markdown.ts). Headings, lists, bold,
 * italic, links and inline code. Every heading is one small bold line: the
 * title is the item's one heading. Line breaks are kept as typed
 * (`whitespace-pre-line`), so a plain note reads exactly as it always did.
 * No raw HTML (react-markdown escapes it), no task boxes (subtasks do that),
 * no tables, and no images: an image would fetch its address the moment the
 * note opens, so it is a link to it instead, as in chat replies.
 */
export const NOTES_PROSE = [
  'break-words text-sm leading-relaxed text-foreground/80',
  '[&>*]:my-0 [&>*+*]:mt-1.5 [&_p]:whitespace-pre-line',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:text-sm [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:text-foreground',
  '[&_:is(h1,h2,h3,h4,h5,h6)+:is(ul,ol)]:mt-0.5',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0 [&_li::marker]:text-muted-foreground',
  '[&_:is(ul,ol)_:is(ul,ol)]:mt-0',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_a]:text-foreground [&_a]:underline [&_a]:decoration-muted-foreground/60 [&_a]:underline-offset-2 hover:[&_a]:decoration-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.9em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:px-2 [&_pre]:py-1.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:border-border',
].join(' ');

const REMARK = [remarkGfm];
/** Unwrapped, so their words still show as text. */
const DROPPED = ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'];

const COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? src : '';
    const label = alt?.trim() || href;
    if (!label) return null;
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      <>{label}</>
    );
  },
};

/** Just the markdown, no fold or editing: the Do stuff desk and Trash. */
export function NotesProse({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn(NOTES_PROSE, className)}>
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} disallowedElements={DROPPED} unwrapDisallowed>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Notes folded open this session, by item, so reopening an item keeps it. */
const unfolded = new Set<string>();

/** About six lines of text-sm leading-relaxed. */
const FOLD_PX = 140;

/**
 * The notes under an item's title, at rest: rendered, folded at about six
 * lines with a fade and "Show all · N lines". A click anywhere but a link opens
 * the editor with the caret where the click was; Enter does it from the
 * keyboard with the caret at the end. A drag that selects text stays a
 * selection, so words can be copied without starting an edit.
 */
export function NotesMarkdown({
  source,
  foldKey,
  onEdit,
}: {
  source: string;
  /** The item's id: what remembers an unfolded note. Also give it as the `key`. */
  foldKey: string;
  /** Opens the editor with the caret at this offset into `source`. */
  onEdit: (caret: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => unfolded.has(foldKey));
  const [overflows, setOverflows] = useState(false);

  // Whether the full note is taller than the fold: only then is there a fold.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > FOLD_PX + 24);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  const folded = overflows && !open;

  const toggle = () => {
    const next = !open;
    if (next) unfolded.add(foldKey);
    else unfolded.delete(foldKey);
    setOpen(next);
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('a')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && bodyRef.current?.contains(sel.anchorNode)) return;
    onEdit(caretFromPoint(bodyRef.current, source, e.clientX, e.clientY));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onEdit(source.length);
  };

  return (
    <div className="flex flex-col items-start gap-0.5" data-testid="item-notes-view">
      <div
        ref={bodyRef}
        tabIndex={0}
        aria-label="Notes. Press Enter to edit."
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-folded={folded || undefined}
        className={cn(
          NOTES_PROSE,
          '-mx-1 w-[calc(100%+0.5rem)] cursor-text rounded-md px-1 outline-none',
          'hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          folded &&
            'max-h-[140px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]'
        )}
      >
        <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} disallowedElements={DROPPED} unwrapDisallowed>
          {source}
        </ReactMarkdown>
      </div>
      {overflows && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          data-testid="item-notes-more"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          {open ? (
            'Show less'
          ) : (
            <>
              Show all <span className="text-muted-foreground/70">· {notesLineCount(source)} lines</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** The source offset under a point in the rendered note (see notesCaretFor). */
function caretFromPoint(root: HTMLElement | null, source: string, x: number, y: number): number {
  if (!root) return source.length;
  let node: Node | null = null;
  let offset = 0;
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) ({ offsetNode: node, offset } = pos);
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return source.length;
  const total = root.textContent?.length ?? 0;
  let before = 0;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) before += n.textContent?.length ?? 0;
  const ratio = total ? (before + offset) / total : 1;
  return notesCaretFor(source, node.textContent ?? '', offset, ratio);
}
