'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { BucketCard } from '@/components/primitives/bucket-card';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { cn } from '@/lib/utils';


/**
 * A miniature dsul that redraws as you change the rows beneath it.
 *
 * WHAT IS REAL AND WHAT IS NOT, and why. The bucket is the actual `BucketCard`
 * — it imports no dnd and reads only view-store, so mounting it outside the
 * planner is safe, and it is the component the Buckets setting actually
 * selects between. So that row previews itself honestly and cannot drift.
 *
 * The ROWS inside it are hand-built. The real `TaskRow` is fully live-wired:
 * a click calls `useSelectionStore.replace()` and `openEditFor()`, the checkbox
 * calls `toggleTaskStatus`, and delete raises `useUIStore.confirm()` — all of
 * which target dialogs that only AppShell mounts, so on this route they would
 * set state nothing renders and then pop a docked editor open on a fixture id
 * the moment you navigated home. The same goes for the schedule grid:
 * `HourSlot` isn't exported and registers a droppable, and `BlockCorners` /
 * `HandleGrip` aren't exported and are `opacity-0` until hover — so mounting
 * ScheduleBlock would preview the handles setting as a blank rectangle anyway.
 *
 * The whole card is inert and aria-hidden regardless: it is a specimen, not a
 * control surface, and it must never become a second way to mutate real data.
 */

/** Item titles ride --font-content / --text-content, which the utilities read
 *  via var(). The `data-type-mode` attribute itself only works on <html> —
 *  `:root[data-type-mode='serif'] body` matches nothing on a subtree — so a
 *  local override has to set the tokens directly. */
const SERIF_VARS: React.CSSProperties = {
  ['--font-content' as string]: 'var(--font-serif)',
  ['--font-content-weight' as string]: '600',
};

function PreviewRow({ title, done }: { title: string; done?: boolean }) {
  return (
    <div className="flex h-[26px] items-center gap-2 px-1.5">
      <span
        className={cn(
          'grid size-3 shrink-0 place-items-center rounded-[3.5px] border',
          done ? 'bg-primary border-primary' : 'border-input'
        )}
      >
        {done && <Check className="text-primary-foreground size-2" strokeWidth={3} aria-hidden />}
      </span>
      <span
        className={cn(
          'font-content text-content truncate',
          done ? 'text-muted-foreground line-through' : 'text-foreground'
        )}
      >
        {title}
      </span>
    </div>
  );
}

export function LookPreview() {
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);
  const showTimeLine = usePlannerStore((s) => s.showCurrentTimeIndicator);

  // Rendered client-side only: the fixture reads the current wall clock for the
  // time line's position, which would mismatch between server and client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-[188px]" aria-hidden />;

  const rows = [
    { title: 'Draft the brief', done: false },
    { title: 'Walk', done: false },
    { title: 'Vitamins', done: true },
  ].filter((r) => showCompleted || !r.done);

  return (
    <div className="mt-1">
      <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
        Preview
      </p>
      <div
        // inert keeps the whole specimen out of the tab order and unclickable;
        // aria-hidden keeps it out of the accessibility tree. The visible
        // "Preview" label above is what announces it.
        inert
        aria-hidden
        className={cn(
          'border-border bg-canvas pointer-events-none overflow-hidden rounded-lg border p-4',
          'shadow-[var(--shadow-elev-sm)]'
        )}
        // The bucket cards float on --canvas in the real views, so the
        // specimen sits on bg-canvas to show them on the same ground.
        style={typeMode === 'serif' ? SERIF_VARS : undefined}
      >
        <div className="flex gap-4">
          <div className="w-[190px] shrink-0">
            <BucketCard
              bucket="morning"
              count={rows.length}
              variant={bucketStyle}
              density="mini"
              // The specimen must not inherit whether you shut Morning on the
              // grid — that flag is persisted and shared.
              collapsible={false}
              isCurrent
            >
              <div className="flex flex-col">
                {rows.map((r) => (
                  <PreviewRow key={r.title} title={r.title} done={r.done} />
                ))}
              </div>
            </BucketCard>
          </div>

          {/* A three-hour slice. Hand-built — see the note at the top. */}
          <div className="relative min-w-0 flex-1">
            {[9, 10, 11, 12].map((hour) => (
              <div key={hour} className="flex h-[34px] items-center gap-2">
                <span className="text-muted-foreground font-num w-5 text-right text-[10px]">
                  {hour}
                </span>
                <span className="bg-border h-px flex-1" />
              </div>
            ))}
            <div
              className={cn(
                'border-border bg-card absolute right-1 left-7 rounded-lg border px-2 py-1.5',
                'shadow-[var(--shadow-elev-sm)]'
              )}
              style={{ top: 38, height: 40 }}
            >
              <div className="flex items-start gap-1.5">
                <span className="font-content text-content text-foreground truncate">
                  Draft the brief
                </span>
                <span className="text-muted-foreground font-num ml-auto text-[10px]">45m</span>
              </div>
            </div>
            {showTimeLine && (
              <div className="absolute right-0 left-6" style={{ top: 92 }}>
                <span className="bg-primary block h-px w-full" />
                <span className="bg-primary absolute -top-[2.5px] -left-[3px] size-1.5 rounded-full" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
