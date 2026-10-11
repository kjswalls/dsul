'use client';

import { useEffect, useMemo, useState } from 'react';
import { Palmtree } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { addDays, EMPTY_KEEP, type AwayKeep } from '@/lib/away';
import { formatAwayDay, shortAwayDay } from '@/lib/away-dates';
import {
  activeTrip,
  awayInputsNow,
  beeminderHeld,
  defaultKeep,
  endVacation,
  keepChoices,
  keepSentence,
  startVacation,
} from '@/lib/away-actions';
import { toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * Vacation mode's card: one date, one sentence about what keeps going, and a
 * picker behind "Change what's paused". Opened from the user menu, the ⌘K
 * line's chip, the toast and the line beside the date.
 *
 * Before a trip it starts one; on a trip it says until when and ends it. The
 * keep list it starts with is the month's every-day habits (suggestKeeps), and
 * anything added in the app while away keeps going on its own (planner-store's
 * persistNewItem), which is why the picker says so instead of asking.
 */
export function VacationDialog({
  open,
  editKeep,
  onOpenChange,
}: {
  open: boolean;
  editKeep?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const periods = useAwayStore((s) => s.periods);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  const trip = activeTrip(periods, todayStr);

  const [backOn, setBackOn] = useState('');
  const [keep, setKeep] = useState<AwayKeep>(EMPTY_KEEP);
  const [picking, setPicking] = useState(false);

  // Seeded each time the card opens, from the trip if there is one.
  useEffect(() => {
    if (!open) return;
    const now = awayInputsNow();
    const t = activeTrip(useAwayStore.getState().periods, now.todayStr);
    setBackOn(t?.endsOn ?? addDays(now.todayStr, 7));
    setKeep(t?.keep ?? defaultKeep(now.items, now.todayStr));
    setPicking(!!editKeep);
  }, [open, editKeep]);

  const choices = useMemo(() => keepChoices(items), [items]);
  const sentence = keepSentence(keep, items, routines);
  const staked = useMemo(() => beeminderHeld(keep, items, routines), [keep, items, routines]);
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(backOn) && backOn > todayStr;
  const changed =
    !!trip &&
    (trip.endsOn !== backOn ||
      JSON.stringify(trip.keep.itemIds) !== JSON.stringify(keep.itemIds) ||
      JSON.stringify(trip.keep.routineIds) !== JSON.stringify(keep.routineIds));

  const toggle = (field: 'itemIds' | 'routineIds', id: string, on: boolean) =>
    setKeep((k) => ({ ...k, [field]: on ? [...k[field], id] : k[field].filter((x) => x !== id) }));

  const submit = () => {
    if (!validDay) return;
    if (trip) {
      if (changed) startVacation(backOn, keep, trip.startsOn);
    } else {
      startVacation(backOn, keep);
    }
    onOpenChange(false);
  };

  const title = trip
    ? trip.startsOn > todayStr
      ? `Vacation from ${formatAwayDay(trip.startsOn)}`
      : `Vacation until ${trip.endsOn ? shortAwayDay(trip.endsOn, todayStr) : 'you’re back'}`
    : 'Vacation mode';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border sm:max-w-md" data-testid="vacation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Palmtree className="h-5 w-5" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>
            Pauses your habits and dated tasks while you’re away, then brings them back gently.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="vacation-back-on" className="text-sm">
              Back on
            </Label>
            <Input
              id="vacation-back-on"
              type="date"
              value={backOn}
              min={addDays(todayStr, 1)}
              onChange={(e) => setBackOn(e.target.value)}
              className="w-44 text-sm"
              data-testid="vacation-back-on"
            />
          </div>

          <p className="text-sm text-foreground" data-testid="vacation-keep-sentence">
            {sentence}
            {!trip && ' It comes back gently after.'}
          </p>

          {picking ? (
            <div className="space-y-2" data-testid="vacation-keep-picker">
              <div>
                <p className="text-sm font-medium text-foreground">What keeps going on vacation</p>
                {!trip && (
                  <p className="text-xs text-muted-foreground">
                    Picked from what you’ve done every day this month.
                  </p>
                )}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {routines.map((r) => (
                  <KeepRow
                    key={`r:${r.id}`}
                    id={`keep-r-${r.id}`}
                    label={r.name}
                    hint="Routine"
                    checked={keep.routineIds.includes(r.id)}
                    onChange={(on) => toggle('routineIds', r.id, on)}
                  />
                ))}
                {choices.map((i) => (
                  <KeepRow
                    key={i.id}
                    id={`keep-${i.id}`}
                    label={i.title}
                    checked={keep.itemIds.includes(i.id)}
                    onChange={(on) => toggle('itemIds', i.id, on)}
                  />
                ))}
                {choices.length === 0 && routines.length === 0 && (
                  <p className="text-sm text-muted-foreground">No habits yet. Everything rests.</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Anything you add while you’re away keeps going on its own.
              </p>
            </div>
          ) : null}

          {staked.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="vacation-beeminder">
              {staked.length === 1 ? `${staked[0]} is` : `${staked.length} paused habits are`} on Beeminder, which
              needs 7 days’ notice for a break. Schedule one there, or keep {staked.length === 1 ? 'it' : 'them'} going.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              aria-expanded={picking}
              className={cn(
                'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground',
                picking && 'text-foreground',
              )}
              data-testid="vacation-change-paused"
            >
              Change what’s paused
            </button>
            <div className="flex gap-2">
              {trip && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    endVacation();
                    onOpenChange(false);
                  }}
                  data-testid="vacation-end"
                >
                  {trip.startsOn > todayStr ? 'Cancel vacation' : 'End vacation'}
                </Button>
              )}
              <Button type="submit" disabled={!validDay || (!!trip && !changed)} data-testid="vacation-submit">
                {trip ? 'Save' : 'Start vacation'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeepRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="hover-wash flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span className="min-w-0 flex-1 truncate font-content text-sm text-foreground">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
