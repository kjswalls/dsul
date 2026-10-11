'use client';

import { useEffect, useRef, useState } from 'react';
import { File as FileIcon, FileImage, FileText, Loader2, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fileLink, sizeLabel, type ItemFile } from '@/lib/item-files';
import { useItemFilesStore } from '@/lib/item-files-store';
import { usePlannerStore } from '@/lib/planner-store';
import { cn } from '@/lib/utils';

/**
 * Files kept on an item (lib/item-files.ts, migration 073), in two pieces:
 * the paperclip in the panel's header, which picks files, and the Files
 * section, which lists them. The section draws nothing while an item has no
 * files and none are uploading, so a panel without files looks exactly as it
 * did before files existed.
 */

const NO_FILES: ItemFile[] = [];

/** The hidden picker both pieces open. */
function usePicker(itemId: string) {
  const ref = useRef<HTMLInputElement>(null);
  const add = useItemFilesStore((s) => s.add);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      data-testid="item-files-input"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) void add(itemId, files);
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

export function AttachFileButton({ itemId }: { itemId: string }) {
  const available = useItemFilesStore((s) => s.available);
  const { open, input } = usePicker(itemId);
  if (available === false) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        data-testid="item-dialog-attach"
        className="text-muted-foreground size-7"
        onClick={open}
      >
        <Paperclip className="size-3.5" />
        <span className="sr-only">Attach a file</span>
      </Button>
      {input}
    </>
  );
}

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.startsWith('text/') || mime === 'application/pdf') return FileText;
  return FileIcon;
}

export function ItemFilesSection({ itemId }: { itemId: string }) {
  const files = useItemFilesStore((s) => s.byItem[itemId]?.files ?? NO_FILES);
  const uploading = useItemFilesStore((s) => s.uploading[itemId] ?? 0);
  const load = useItemFilesStore((s) => s.load);
  const remove = useItemFilesStore((s) => s.remove);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const { open: pick, input } = usePicker(itemId);

  useEffect(() => {
    void load(itemId);
  }, [itemId, load]);

  if (files.length === 0 && uploading === 0) return null;

  async function openFile(file: ItemFile) {
    const userId = usePlannerStore.getState().userId;
    if (!userId) return;
    // Opened before the link exists, so the popup blocker sees a click.
    const tab = window.open('', '_blank');
    setOpening(file.id);
    const url = await fileLink(file, userId);
    setOpening(null);
    if (!tab) {
      if (url) window.location.assign(url);
      return;
    }
    if (url) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      tab.close();
    }
  }

  return (
    <section data-testid="item-files" aria-labelledby={`item-files-${itemId}`} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h4 id={`item-files-${itemId}`} className="text-muted-foreground text-xs font-medium">
          Files
        </h4>
        <button
          type="button"
          onClick={pick}
          className="text-muted-foreground hover:text-foreground rounded text-xs"
          data-testid="item-files-add"
        >
          Add
        </button>
        {input}
      </div>
      <ul className="flex flex-col">
        {files.map((f) => {
          const Icon = iconFor(f.mime);
          return (
            <li
              key={f.id}
              data-testid="item-file"
              className="group/file hover:bg-secondary/60 flex items-center gap-2 rounded-md px-1.5 py-1"
            >
              <button
                type="button"
                onClick={() => void openFile(f)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                data-testid="item-file-open"
              >
                {opening === f.id ? (
                  <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                )}
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">{f.name}</span>
                <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">{sizeLabel(f.size)}</span>
              </button>
              {confirming === f.id ? (
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="text-destructive-text text-xs hover:underline"
                    data-testid="item-file-confirm"
                    onClick={async () => {
                      if (await remove(itemId, f)) setConfirming(null);
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete ${f.name}`}
                  data-testid="item-file-delete"
                  onClick={() => setConfirming(f.id)}
                  className={cn(
                    'text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5',
                    'opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'
                  )}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          );
        })}
        {uploading > 0 && (
          <li className="text-muted-foreground flex items-center gap-2 px-1.5 py-1 text-sm" data-testid="item-files-uploading">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Adding {uploading === 1 ? 'a file' : `${uploading} files`}…
          </li>
        )}
      </ul>
    </section>
  );
}
