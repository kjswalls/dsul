"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  Calendar,
  Clock,
  ListChecks,
  Repeat,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ItemTick, springItemCheck } from "@/components/primitives/item-check";

/**
 * The item's details folded to one plain line while its conversation has the
 * panel (components/planner/item-dialog.tsx, AI on, docked): where the item
 * lives, then its day and time, steps and repeat, as text with small icons,
 * never pills or a card (the rail reads as one surface, like Claude Code's
 * thread rail; Kirby's pick on 2026-10-24). The title is not here: it is the
 * rail header's crumb, which also folds and unfolds. A tap anywhere on the
 * line opens the details again. It edits nothing itself; the tick is the
 * header's (RailDoneCheck below).
 */
export type RailChipKind = "date" | "time" | "steps" | "repeat";

export interface RailChip {
  kind: RailChipKind;
  label: string;
}

const CHIP_ICON: Record<RailChipKind, ReactNode> = {
  date: <Calendar className="size-3" aria-hidden />,
  time: <Clock className="size-3" aria-hidden />,
  steps: <ListChecks className="size-3" aria-hidden />,
  repeat: <Repeat className="size-3" aria-hidden />,
};

export function ItemRail({
  title,
  container,
  chips,
  onExpand,
  className,
}: {
  /** Names the line for a screen reader ("Show details for …"); not drawn. */
  title: string;
  /** The project (or other container) the item sits in, when it has one. */
  container?: string;
  chips: readonly RailChip[];
  onExpand: (e: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="item-rail"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`Show details for ${title || "this item"}`}
      className={cn(
        "-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {container && (
        <span data-rail-chip="container" className="max-w-[40%] truncate">
          {container}
        </span>
      )}
      {chips.map((c) => (
        <span
          key={c.kind}
          data-rail-chip={c.kind}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
        >
          {CHIP_ICON[c.kind]}
          {c.label}
        </span>
      ))}
      {!container && chips.length === 0 && <span>Show details</span>}
    </button>
  );
}

/**
 * The item's tick, in the rail header's icons (item-dialog.tsx places it),
 * where Claude Code's thread rail keeps "resolve". Never inside the fold: the
 * fold clips, and the lime mark keeps its own element (CLAUDE.md), so nothing
 * it lives in can dim or cut it. The same box a row draws
 * (task-row.tsx): lime when done, a lime fill rising for a counted habit's
 * partial day. What a press means is the caller's (lib/item-verbs.ts `tick`).
 */
export function RailDoneCheck({
  done,
  partial = 0,
  label,
  onToggle,
  className,
}: {
  done: boolean;
  /** A counted habit's progress on the day, 0 to 1; 0 draws no fill. */
  partial?: number;
  /** The verb's own label for this item on this day ("Done today", "Count one (1/3)"). */
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  const filling = !done && partial > 0;
  return (
    <button
      type="button"
      data-testid="item-rail-check"
      data-checked={done ? "true" : filling ? "partial" : "false"}
      aria-label={label}
      aria-pressed={done}
      onClick={(e) => {
        if (!done) springItemCheck(e.currentTarget);
        onToggle();
      }}
      className={cn(
        "relative flex size-4 items-center justify-center overflow-hidden rounded-[5px] inset-ring transition-[background-color,box-shadow]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
        done
          ? "inset-ring-primary bg-primary"
          : filling
            ? "inset-ring-primary/60 bg-surface-3 hover:inset-ring-primary"
            : "inset-ring-muted-foreground/45 bg-surface-3 hover:inset-ring-primary",
        className,
      )}
    >
      {filling && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 bg-primary transition-[height] duration-150"
          style={{ height: `${Math.round(partial * 100)}%` }}
        />
      )}
      {done && <ItemTick />}
    </button>
  );
}
