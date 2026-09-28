'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { CONSOLE_HOME } from '@/lib/console-door';
import { useUIStore } from '@/lib/ui-store';

/**
 * Drops a stranded Organize slot when you leave the route that mounts the
 * console.
 *
 * `OrganizeConsole` lives in AppShell, which only `app/page.tsx` renders, and
 * `ui-store` is a module singleton — so a console left OPEN when you navigate
 * away keeps its slot armed at a surface that no longer exists, and the next
 * trip home springs it open unasked. lib/console-door.ts stops a DOOR arming a
 * slot it cannot open; this stops an already-open console outliving its route.
 *
 * The console's own outward links close it themselves (organize/sections/goals.tsx, and
 * every "Open as page" via OpenAsPageLink in organize/detail-parts.tsx),
 * which covers the deliberate exits. This covers the one the user brings: browser
 * Back, the Android hardware button, the iOS edge swipe — on mobile the console
 * is a bottom sheet and back-to-dismiss is the reflex.
 *
 * KEYED ON A PATHNAME CHANGE, NOT ON UNMOUNT. The tempting version — clear it
 * when the host unmounts — is wrong in development: Next 16 leaves
 * `reactStrictMode` on for the App Router, so a mount effect's cleanup fires
 * once immediately after the first mount, and that would wipe the slot the
 * arm-then-push path had just armed to open the console in the first place. A
 * pathname change cannot fire on arrival, so it has no such window.
 *
 * Only ever clears the ORGANIZE slot. The shell's other dialogs are equally
 * unmounted off `/`, but none of them has a link that leaves the route, so none
 * can be stranded this way — and clearing a slot nothing stranded is how a
 * dialog starts closing itself for reasons nobody can find.
 */
export function ConsoleSlotGuard() {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    const from = previous.current;
    previous.current = pathname;
    // First render is an arrival, not a departure — and an arrival AT the
    // console's home is exactly what a door off-shell just asked for.
    if (from === pathname || pathname === CONSOLE_HOME) return;
    if (useUIStore.getState().activeDialog?.type === 'organize') {
      useUIStore.getState().closeDialog();
    }
  }, [pathname]);

  return null;
}
