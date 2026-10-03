'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { User, Settings, LogOut, Undo2, Redo2, ChevronDown, Flame, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RelayField } from '@/components/primitives/relay-field';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { RELAY } from '@/lib/relay-config';
import { createClient } from '@/lib/supabase';
import { useSessionUserStore } from '@/lib/session-user-store';
import { flushSettings } from '@/lib/settings-service';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { cn } from '@/lib/utils';

function getInitials(email: string, name?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

/**
 * Sidebar footer row: identity + streak on the left, session history
 * (label + undo/redo) on the right. Replaces user-profile-dropdown in the
 * desktop chrome and absorbs action-feed's history list.
 *
 * The action log is in-memory per session, so the whole list is "this
 * session" — the divider renders at the bottom. If the log ever persists,
 * record a session-start index in planner-store and move the divider there.
 */
export function UserCard() {
  const router = useRouter();
  const { habits, actionLog, historyIndex, undo, redo, canUndo, canRedo } = usePlannerStore();
  const openDialog = useUIStore((s) => s.openDialog);
  const streaksOn = useStreaksEnabled();

  // Off the session the provider already adopted — no getUser() round trip
  // per mount. Display only (lib/session-user-store.ts).
  const sessionUser = useSessionUserStore((s) => s.user);
  const email = sessionUser?.email ?? null;
  const displayName = sessionUser?.displayName ?? null;
  const avatarUrl = sessionUser?.avatarUrl ?? null;
  const prevStreak = useRef<number | null>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [burst, setBurst] = useState(false);

  const handleSignOut = async () => {
    // Settings writes are debounced 500ms. Anything still buffered has to land
    // while the session is alive, or RLS rejects it and the change is lost.
    await flushSettings();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  const initials = email ? getInitials(email, displayName) : '??';
  const label = displayName ?? email ?? 'User';
  const firstName = (displayName ?? email ?? 'You').split(/[\s@]/)[0];
  const bestStreak = habits.reduce((max, h) => Math.max(max, h.streak ?? 0), 0);

  useEffect(() => {
    if (prevStreak.current !== null && bestStreak > prevStreak.current) {
      setBurst(true);
      if (burstTimer.current) clearTimeout(burstTimer.current);
      burstTimer.current = setTimeout(() => setBurst(false), 1200);
    }
    prevStreak.current = bestStreak;
  }, [bestStreak]);

  // Clear the pending burst timer only on unmount. The detection effect above
  // deliberately does NOT clear it on re-run, so a later bestStreak *decrease*
  // (e.g. undo right after a streak tick) can't cancel an in-flight burst and
  // leave the field stuck lit.
  useEffect(
    () => () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    },
    []
  );

  const displayActions = actionLog.slice(0, 10);
  const currentActionIndex = actionLog.length > 0 ? actionLog.length - historyIndex - 1 : -1;

  return (
    <div className="flex items-center gap-2 px-[11px]">
      {/* Identity dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 transition-colors hover:bg-accent"
            aria-label="User menu"
          >
            <Avatar className="h-5 w-5">
              <AvatarImage src={avatarUrl ?? ''} alt={label} />
              <AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
                {email ? initials : <User className="h-3 w-3" />}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-sm font-medium text-foreground">{firstName}</span>
            {/* flex-shrink-0: the badge is overflow-hidden (it clips the relay
                field to its pill), which zeroes its automatic minimum, so on a
                narrow column it shrank and cut its own flame and count. The
                name truncates instead. The braindump is narrow at rest beside
                a docked right rail (328 at a 1280 window, 280 below ~1232). */}
            {streaksOn && bestStreak > 0 && (
              <span
                data-testid="user-streak"
                className="relative isolate flex flex-shrink-0 items-center gap-0.5 overflow-hidden rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning-text"
              >
                {RELAY.streak && (
                  <RelayField
                    className="absolute inset-0 -z-10"
                    pitch={18}
                    period={2.4}
                    focalY={0.5}
                    idleIntensity={0}
                    activeIntensity={1}
                    active={burst}
                    mask="radial-gradient(closest-side, black, transparent)"
                  />
                )}
                <Flame className="h-3 w-3" />
                {bestStreak}
              </span>
            )}
            <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start" sideOffset={8}>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="truncate text-sm font-medium leading-none">{label}</p>
              {email && displayName && (
                <p className="truncate text-xs leading-none text-muted-foreground">{email}</p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* A Link, not a router.push: opening the menu mounts it, and a
              mounted Link is what gets the route chunk prefetched in prod —
              an imperative push always pays the fetch at click time. The
              canonical pane URL (not bare /settings) also skips the
              replace-to-/settings/day hop the page would otherwise do. */}
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link href="/settings/day">
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSignOut}
            className="cursor-pointer text-muted-foreground focus:bg-destructive/10 focus:text-destructive"
          >
            <LogOut className="mr-2 h-4 w-4" />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* History: session label + undo/redo (Figma 84:765 — ~24px gap between).
          min-w-0 shrink, on it and on the label: on a narrow column the label
          truncates ("Sessio…") rather than the group holding its full width
          and pushing the identity button's chevron out over it. */}
      <div data-testid="user-history" className="ml-auto flex min-w-0 shrink items-center gap-5">
        <Popover>
          <PopoverTrigger asChild>
            <button className="min-w-0 max-w-[110px] shrink truncate border-b border-dashed border-muted-foreground/40 pb-px font-mono text-xs text-muted-foreground transition-colors hover:text-foreground">
              {displayActions[0]?.label ?? 'Session start'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-64 p-2">
            <div className="mb-1.5 px-1 text-2xs font-medium text-muted-foreground">History</div>
            <div className="max-h-60 space-y-0.5 overflow-y-auto">
              {displayActions.map((action, idx) => {
                const isCurrentPosition = idx === currentActionIndex;
                const isUndone = idx < currentActionIndex;
                return (
                  <div
                    key={action.id}
                    className={cn(
                      'truncate rounded px-1.5 py-0.5 font-mono text-2xs leading-tight',
                      isCurrentPosition && 'bg-secondary/50 text-foreground',
                      !isCurrentPosition && !isUndone && 'text-muted-foreground/60',
                      isUndone && 'text-muted-foreground/30 line-through'
                    )}
                    title={action.label}
                  >
                    <span className="mr-1 opacity-40">{isCurrentPosition ? '>' : ' '}</span>
                    {action.label}
                  </div>
                );
              })}
              <div className="px-1.5 pt-1 font-mono text-2xs text-muted-foreground/50">
                Session start
              </div>
            </div>

            {/*
              THE TRASH'S DOOR, and its placement is the whole point.

              Every other way into the Organize console is a door you open on
              purpose. This one is for the moment you have lost something — and
              the place a user already goes in that moment is here, where the
              in-session undo lives. A recovery feature reachable only from a
              rail nobody has opened is not a recovery feature.

              Outside the scroller above, so it does not scroll away behind ten
              actions, and behind a rule so it reads as a different kind of
              thing from the log it sits under: the log is this session, this is
              the last thirty days.
            */}
            {/* NOT GATED, and that is deliberate rather than an oversight.
                This is the only door to the trash, and the trash is the only
                way back out of a delete — while deleting itself is not gated at
                all. A recovery route that a default-off extension can close is
                a way for the app's DEFAULT configuration to destroy work. So
                `extension: null` in console-rail.tsx keeps the Trash section
                alive whatever the toggles say, and this button stays live to
                match. */}
            <div className="mt-2 border-t border-border pt-1.5">
              <button
                type="button"
                onClick={() => openDialog({ type: 'organize', section: 'trash' })}
                data-testid="history-trash-door"
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Trash2 className="h-3 w-3 shrink-0" />
                Recently deleted
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={undo}
            disabled={!canUndo}
            className="h-6 w-6 text-muted-foreground transition-all hover:text-foreground disabled:opacity-30"
            title="Undo (⌘Z)"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={redo}
            disabled={!canRedo}
            className="h-6 w-6 text-muted-foreground transition-all hover:text-foreground disabled:opacity-30"
            title="Redo (⌘⇧Z)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
