'use client';

import { useMemo } from 'react';
import { Check, Search, X } from 'lucide-react';
import { DoStuffKey } from '@/components/sidebar/do-stuff';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { commitCount, commitLines, finishRun, useDoStuffStore } from '@/lib/do-stuff';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useUIStore } from '@/lib/ui-store';

/**
 * The dock's keys, in place of the capture bar (Kirby's pick, 2026-10-13;
 * memory/plans/power-mode.md, round 5): the do stuff key, wide, and beside it
 * a small key that opens the ⌘K launcher, where search, add, commands and chat
 * all live, for anyone who would rather click than press a chord.
 *
 * While doing stuff the same place holds "make it so": a plain keycap (the do
 * stuff key's shape with no light in its rim), so the key you pressed to plan
 * is the key you press to commit, with the same chord. Hovering it says what
 * it will do. ✕ takes the launcher key's place and stops without writing.
 * With nothing left to move, the key reads "finish" and stops.
 */
export function DoStuffDockKeys() {
  const on = useDoStuffStore((s) => s.on);
  if (on) return <MakeItSoKeys />;
  return (
    <div className="flex items-center gap-1.5" data-testid="do-stuff-dock">
      <DoStuffKey place="dock" />
      <LauncherKey />
    </div>
  );
}

function useChord(id: string): string {
  const keys = useShortcutKeys(id);
  const isMac = useMemo(() => isApplePlatform(), []);
  return chordLabel(keys, isMac);
}

/** The ⌘K launcher, as a keycap with no light in its rim (globals.css, the dock's keys). */
function LauncherKey() {
  const chord = useChord('system_search');
  return (
    <button
      type="button"
      data-do-key=""
      data-do-key-place="launcher"
      data-testid="dock-launcher-key"
      aria-label="Search, add, commands and chat"
      title={`Search, add, commands and chat (${chord})`}
      onClick={() => useUIStore.getState().openDialog({ type: 'launcher' })}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-[6px] rounded-[9px] text-[13px] font-medium text-foreground"
    >
      <Search aria-hidden data-do-key-glyph="" className="size-3.5 shrink-0" />
      <kbd
        aria-hidden
        data-do-key-chord=""
        className="inline-flex h-4 items-center rounded-[4px] px-[4px] pt-px font-sans text-[10.5px] leading-none font-medium tabular-nums"
      >
        {chord}
      </kbd>
    </button>
  );
}

function MakeItSoKeys() {
  const commit = useDoStuffStore((s) => s.commit);
  const stop = useDoStuffStore((s) => s.stop);
  const chord = useChord('do_stuff');
  const pending = commitCount(commit);
  const lines = commitLines(commit);

  const key = (
    <button
      type="button"
      data-do-key=""
      data-do-key-place="dock"
      data-do-key-plain=""
      data-testid={pending > 0 ? 'do-stuff-make-it-so' : 'do-stuff-finish'}
      aria-label={pending > 0 ? `Make it so: ${lines.join(', ')}` : 'Finish doing stuff'}
      onClick={finishRun}
      className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-[7px] rounded-[9px] text-[13px] leading-[18px] font-medium whitespace-nowrap text-foreground"
    >
      <Check aria-hidden className="size-3.5 shrink-0" />
      <span>{pending > 0 ? 'make it so' : 'finish'}</span>
      {pending > 0 && <span className="font-num text-muted-foreground">{pending}</span>}
      <kbd
        aria-hidden
        data-do-key-chord=""
        className="inline-flex h-4 items-center rounded-[4px] px-[4px] pt-px font-sans text-[10.5px] leading-none font-medium tabular-nums"
      >
        {chord}
      </kbd>
    </button>
  );

  return (
    <div className="flex items-center gap-1.5" data-testid="do-stuff-dock">
      {pending > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>{key}</TooltipTrigger>
          <TooltipContent side="top" className="flex flex-col gap-0.5" data-testid="do-stuff-make-it-so-plan">
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
            <span className="opacity-70">everything can be undone</span>
          </TooltipContent>
        </Tooltip>
      ) : (
        key
      )}
      <button
        type="button"
        onClick={stop}
        aria-label="Stop doing stuff"
        data-testid="do-stuff-stop"
        className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
