"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  Calendar,
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
 * glance, and edits nothing itself: every property is one tap away, open.
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
        "group/rail flex w-full flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
