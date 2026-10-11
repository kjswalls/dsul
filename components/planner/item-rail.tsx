"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ListChecks,
  Repeat,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The item's details folded to one strip while its conversation has the panel
 * (components/planner/item-dialog.tsx, AI on, docked): where the item lives and
 * its title, then its day and time, steps and repeat as small chips. A tap
 * anywhere on it opens the details again. It shows nothing it cannot say in a
 * glance, and edits nothing itself: every property is one tap away, open. The
 * one thing it does is RailDoneCheck below, which sits over it, never in it.
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
  check = false,
  className,
}: {
  title: string;
  /** Leaves room at the start of the title row for a RailDoneCheck laid over it. */
  check?: boolean;
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
        "group/rail flex w-full flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        check && "pl-9",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {container && (
          <>
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
              {container}
            </span>
            <ChevronRight
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </>
        )}
        <span className="min-w-0 flex-1 truncate font-serif text-sm text-foreground">
          {title || "Untitled"}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/rail:translate-y-px"
          aria-hidden
        />
      </span>
      {chips.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {chips.map((c) => (
            <span
              key={c.kind}
              data-rail-chip={c.kind}
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-2xs text-muted-foreground"
            >
              {CHIP_ICON[c.kind]}
              {c.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * The item's tick, laid over the folded rail's title row (item-dialog.tsx
 * places it). A sibling of the fold, never inside it: the fold clips, and the
 * lime mark keeps its own element (CLAUDE.md), so it fades in on its own and
 * nothing it lives in can dim or cut it. The same box a row draws
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
      onClick={onToggle}
      className={cn(
        "relative flex size-4 items-center justify-center overflow-hidden rounded-[5px] border transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
        done
          ? "border-primary bg-primary"
          : filling
            ? "border-primary/60 bg-surface-3 hover:border-primary"
            : "border-muted-foreground/45 bg-surface-3 hover:border-primary",
        className,
      )}
    >
      {filling && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 bg-primary/70 transition-[height] duration-150"
          style={{ height: `${Math.round(partial * 100)}%` }}
        />
      )}
      {done && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
    </button>
  );
}
