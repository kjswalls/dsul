'use client';

import { useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { openFile } from '@/components/planner/item-files';
import { TimelineAvatar } from '@/components/planner/item-timeline';
import { fileBadge, isThumbable, sizeLabel, type ItemFile } from '@/lib/item-files';
import { useItemFilesStore } from '@/lib/item-files-store';
import { ACTOR_LABEL, type FileEntry } from '@/lib/item-timeline';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * A file kept on an item, as its timeline shows it (lib/item-timeline.ts
 * `fileEntries`): who attached it and when, over a card per file. A picture
 * with a link in hand (item-files-store `thumbs`, a short-lived signed URL) is
 * drawn as itself; anything else, or a picture whose link failed twice, is a
 * card with its type and size. Either opens the file the way the Files
 * section does (`openFile`). An <img> runs nothing, and an SVG is never drawn.
 */

export function ItemFileCard({ file }: { file: ItemFile }) {
  const thumb = useItemFilesStore((s) => s.thumbs[file.id]?.url);
  const dropThumb = useItemFilesStore((s) => s.dropThumb);
  const [opening, setOpening] = useState(false);
  const picture = isThumbable(file.mime) && !!thumb;
  const badge = fileBadge(file.name, file.mime);
  const onClick = () => {
    const userId = usePlannerStore.getState().userId;
    if (!userId || opening) return;
    void openFile(file, userId, setOpening);
  };
  const spinner = opening && (
    <span className="absolute inset-0 grid place-items-center bg-background/60" aria-hidden>
      <Loader2 className="text-muted-foreground size-4 animate-spin" />
    </span>
  );

  if (picture) {
    return (
      <button
        type="button"
        data-testid="item-file-card"
        data-kind="image"
        aria-label={`Open ${file.name}`}
        title={file.name}
        onClick={onClick}
        className="border-border shadow-soft-sm relative size-[150px] shrink-0 overflow-hidden rounded-[14px] border text-left"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL, nothing to optimise */}
        <img
          src={thumb}
          alt={file.name}
          loading="lazy"
          className="size-full object-cover"
          onError={() => dropThumb(file.id)}
        />
        <span className="absolute top-1.5 left-1.5 grid size-[26px] place-items-center rounded-lg bg-black/70 text-white">
          <ImageIcon className="size-3.5" aria-hidden />
        </span>
        <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5">
          <span className="line-clamp-2 text-[12.5px] leading-tight font-medium break-words text-white">
            {file.name}
          </span>
        </span>
        {spinner}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="item-file-card"
      data-kind="file"
      aria-label={`Open ${file.name}`}
      title={file.name}
      onClick={onClick}
      className="border-border hover:bg-secondary/60 relative flex max-w-[16rem] min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors"
    >
      <span
        className="bg-muted text-muted-foreground grid size-[30px] shrink-0 place-items-center rounded-md font-mono text-[8.5px] uppercase"
        aria-hidden
      >
        {badge}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground truncate text-xs">{file.name}</span>
        <span className="text-muted-foreground text-2xs">
          {badge} · {sizeLabel(file.size)}
        </span>
      </span>
      {spinner}
    </button>
  );
}

/**
 * One file line on the timeline: who attached what, and when, with the cards
 * under it. Its own row (`item-timeline-file`), never a change line: the name
 * wraps rather than being cut away.
 */
export function TimelineFileRow({ entry }: { entry: FileEntry }) {
  return (
    <div data-testid="item-timeline-file" data-by={entry.by} className="flex flex-col">
      <div className="flex items-start gap-2">
        <TimelineAvatar who={entry.by} agent={entry.agent} />
        <span className="min-w-0 flex-1 text-xs break-words">
          <span className="text-foreground font-medium">
            {entry.by === 'agent' && entry.agent ? entry.agent : ACTOR_LABEL[entry.by]}
          </span>{' '}
          <span className="text-muted-foreground">{entry.text}</span>
        </span>
        <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px] leading-5">
          {new Date(entry.at).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </time>
      </div>
      <div className="my-1.5 flex flex-wrap gap-2 pl-7">
        {entry.files.map((f) => (
          <ItemFileCard key={f.id} file={f} />
        ))}
      </div>
    </div>
  );
}
