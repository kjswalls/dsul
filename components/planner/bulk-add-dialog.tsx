'use client';

import { useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { FileUp, X } from 'lucide-react';
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
} from '@/components/ui/responsive-modal';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemTypeConfig } from '@/lib/item-registry';
import {
  MAX_BULK_ITEMS,
  parseImportFile,
  splitBulkLinesWithMeta,
  type BulkDraft,
  type BulkTableResult,
} from '@/lib/bulk-add';
import type { ActiveDialog } from '@/lib/ui-store';
import type { TimeBucket } from '@/lib/planner-types';

/**
 * The bulk-add dialog: paste a list (or import a file), see the split, add
 * every line as its own item in one gesture. Reached by pasting multi-line
 * text into any single-item add surface — braindump quick-add, omnibar, item
 * dialog title — or via the palette's "Add many items…".
 *
 * Two editing states, one at a time:
 *  · text — the default. A textarea, one item per line, re-parsed on every
 *    keystroke so the count is always the truth about what Add will create.
 *  · table — a structured import (.csv/.tsv with notes/date columns) shows a
 *    read-only preview instead, because a textarea can't represent per-row
 *    notes without inventing a syntax the user would then have to learn.
 *    "Edit as text" is the escape hatch and says what it drops.
 *
 * Everything here lands through addTasksBulk: one set(), one history entry,
 * one ⌘Z for the whole paste.
 */

type BulkSeed = Extract<ActiveDialog, { type: 'bulk-add' }>;

const IMPORT_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,text/plain,text/csv,text/markdown';

const prettyDate = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return format(new Date(y, m - 1, d), 'EEE, MMM d');
};

export function BulkAddDialog({
  open,
  seed,
  onOpenChange,
}: {
  open: boolean;
  seed: BulkSeed | null;
  onOpenChange: (open: boolean) => void;
}) {
  const addTasksBulk = usePlannerStore((s) => s.addTasksBulk);
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const projects = usePlannerStore((s) => s.projects);

  const [text, setText] = useState('');
  const [table, setTable] = useState<BulkTableResult | null>(null);
  const [itemType, setItemType] = useState('task');
  const [project, setProject] = useState('none');
  const [date, setDate] = useState<string | undefined>(undefined);
  const [bucket, setBucket] = useState<TimeBucket | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  /** A flat CSV import caps at parse time, before the textarea can show the
   *  tail — this keeps the cap notice honest for that one path. */
  const [importTruncated, setImportTruncated] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-seed during render, not in an effect: openDialog mints a fresh seed
  // object per open, so its identity is exactly "a new opening" — the
  // adjust-state-when-props-change pattern, no cascading second render.
  const [seededFor, setSeededFor] = useState<BulkSeed | null>(null);
  if (open && seed && seed !== seededFor) {
    setSeededFor(seed);
    setText(seed.text ?? '');
    setTable(null);
    // 'habit' can't arrive by construction (no surface hands it off), but a
    // stale caller must not make this dialog mint habit rows through the
    // task-shaped pipeline.
    setItemType(seed.itemType && seed.itemType !== 'habit' ? seed.itemType : 'task');
    setProject(seed.project ?? 'none');
    setDate(seed.date);
    setBucket(seed.bucket);
    setFileError(null);
    setImportTruncated(false);
  }

  const parsed = useMemo(() => splitBulkLinesWithMeta(text), [text]);
  const drafts: BulkDraft[] = table
    ? table.drafts
    : parsed.titles.map((title) => ({ title }));
  const truncated = table ? table.truncated : parsed.truncated;
  const count = drafts.length;

  const typeConfig = getItemTypeConfig(itemType);

  const handleImportFile = async (file: File) => {
    setFileError(null);
    try {
      const raw = await file.text();
      const ext = file.name.toLowerCase().split('.').pop() ?? '';
      // Whatever the user is currently looking at — typed lines, or the
      // titles of a previewed table — survives a flat import as text. Losing
      // the visible preview because a second file arrived would be silent
      // data loss.
      const carried = table ? table.drafts.map((d) => d.title).join('\n') : text;
      const appendAsText = (addition: string) => {
        setTable(null);
        setText(carried.trim() ? `${carried.replace(/\n$/, '')}\n${addition}` : addition);
      };

      if (ext === 'csv' || ext === 'tsv') {
        const result = parseImportFile(file.name, raw);
        if (result.drafts.length === 0) {
          setFileError('Nothing usable in that file. It has no non-empty lines or title column.');
          return;
        }
        if (result.structured) {
          // Structure replaces, never merges: mixing typed lines with a
          // mapped table would need a merged editing surface neither state
          // has. The replacement is visible (the table takes the textarea's
          // place), and the text is cleared so nothing stale resurfaces from
          // under the preview later.
          setTable(result);
          setText('');
          setImportTruncated(false);
        } else {
          appendAsText(result.drafts.map((d) => d.title).join('\n'));
          // The flat-CSV path capped at parse time, so the re-parse of the
          // textarea can't see the tail — carry the flag or the drop is
          // silent, against the parser's own contract.
          if (result.truncated) setImportTruncated(true);
        }
      } else {
        // Plain text lands RAW: the textarea keeps every line, the live parse
        // strips markers and applies the cap, and the cap notice derives from
        // what is actually in the box — nothing is dropped at import time.
        if (splitBulkLinesWithMeta(raw).titles.length === 0) {
          setFileError('Nothing usable in that file. It has no non-empty lines or title column.');
          return;
        }
        appendAsText(raw.replace(/\n$/, ''));
      }
    } catch {
      setFileError('Could not read that file.');
    }
  };

  const handleSubmit = () => {
    if (count === 0) return;
    addTasksBulk(
      itemType,
      drafts.map((draft) => {
        const startDate = draft.startDate ?? date;
        return {
          title: draft.title,
          notes: draft.notes,
          project: project === 'none' ? undefined : project,
          startDate,
          // Mirrors the item dialog's save: a dated item needs a bucket to be
          // visible on its day, and 'anytime' is the unopinionated one.
          timeBucket: startDate ? (bucket ?? 'anytime') : undefined,
        };
      })
    );
    onOpenChange(false);
  };

  const editAsText = () => {
    if (!table) return;
    setText(table.drafts.map((d) => d.title).join('\n'));
    setTable(null);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent
        data-testid="bulk-add-dialog"
        className="top-[14vh] w-[calc(100vw-2rem)] translate-y-0 sm:max-w-[520px] max-h-[80vh] overflow-y-auto overflow-x-hidden"
      >
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Add many items</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            One item per line. Paste a list, or import a text or CSV file.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="flex flex-col gap-3">
          {table ? (
            <>
              {/* Plain overflow-y-auto, never <ScrollArea> — the Radix wrapper
                  silently drops max-h. */}
              <div
                data-testid="bulk-add-preview"
                className="max-h-[40vh] overflow-y-auto rounded-md border border-border"
              >
                {table.drafts.map((draft, i) => (
                  <div
                    key={i}
                    className="flex items-baseline gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-content text-content text-foreground">
                      {draft.title}
                    </span>
                    {draft.notes && (
                      <span className="max-w-[35%] truncate text-xs text-muted-foreground">
                        {draft.notes}
                      </span>
                    )}
                    {draft.startDate && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {draft.startDate}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Imported with{' '}
                  {table.drafts.some((d) => d.notes) && 'notes'}
                  {table.drafts.some((d) => d.notes) &&
                    table.drafts.some((d) => d.startDate) &&
                    ' and '}
                  {table.drafts.some((d) => d.startDate) && 'dates'} from the file.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={editAsText}
                  data-testid="bulk-add-edit-as-text"
                >
                  Edit as text (drops notes & dates)
                </Button>
              </div>
            </>
          ) : (
            <Textarea
              autoFocus
              data-testid="bulk-add-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={'Buy milk\nCall the bank\n- Markdown lists work too'}
              className="min-h-[160px] max-h-[40vh] font-content text-content"
            />
          )}

          {/* Shared fields — applied to every line. Kept to the two that make
              sense for a whole batch; per-item detail is what the item dialog
              is for. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={itemType} onValueChange={setItemType}>
              <SelectTrigger size="sm" data-testid="bulk-add-type" className="w-auto gap-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="task">Task</SelectItem>
                {/* Custom types are task-shaped and braindump-eligible; habits
                    are neither, so they don't appear here. */}
                {itemTypes.map((def) => (
                  <SelectItem key={def.name} value={def.name}>
                    {getItemTypeConfig(def.name).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={project} onValueChange={setProject}>
              <SelectTrigger size="sm" data-testid="bulk-add-project" className="w-auto gap-1.5">
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* A date only ever arrives via hand-off (pasting into an add
                dialog that was opened on a day). Display + clear, no picker:
                clearing sends the batch to the braindump, which is the
                default everywhere else. */}
            {date && (
              <button
                type="button"
                onClick={() => setDate(undefined)}
                data-testid="bulk-add-date-chip"
                className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-secondary px-2.5 text-xs font-medium text-foreground"
                aria-label={`Remove date ${prettyDate(date)}`}
              >
                {prettyDate(date)}
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}

            <input
              ref={fileRef}
              type="file"
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                // Allow re-picking the same file after an edit elsewhere.
                e.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1.5 text-xs"
              onClick={() => fileRef.current?.click()}
              data-testid="bulk-add-import"
            >
              <FileUp className="h-3.5 w-3.5" />
              Import from file
            </Button>
          </div>

          {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          {(truncated || importTruncated) && (
            <p className="text-xs text-muted-foreground">
              Capped at {MAX_BULK_ITEMS} items. The rest of the paste was left off.
            </p>
          )}
        </div>

        <ResponsiveModalFooter className="items-center sm:justify-between">
          <span data-testid="bulk-add-count" className="text-xs tabular-nums text-muted-foreground">
            {count === 0 ? 'Nothing to add yet' : `${count} ${count === 1 ? 'item' : 'items'}`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={count === 0} data-testid="bulk-add-submit">
              Add {count > 0 ? `${count} ${count === 1 ? (typeConfig.label?.toLowerCase() ?? 'item') : 'items'}` : 'items'}
            </Button>
          </div>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
