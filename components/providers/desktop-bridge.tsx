'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { getDesktopBridge, type DsulDesktop } from '@/lib/desktop';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useSessionUserStore } from '@/lib/session-user-store';
import { isSignedOutPath } from '@/lib/signed-out-redirect';
import { openQuickCapture } from '@/lib/ui-store';

/**
 * Where the launcher lives. OmniLauncher is mounted by AppShell, which only
 * app/page.tsx renders, so on any other route the launcher slot is read by
 * nothing (the same shape as the Organize console; see lib/console-door.ts).
 */
const LAUNCHER_HOME = '/';

const noopSubscribe = () => () => {};

/**
 * The web side of the desktop app's bridge (window.dsulDesktop, set only by
 * electron/preload.cjs). In a browser it renders nothing and subscribes to
 * nothing. See memory/plans/desktop-app.md.
 *
 * Route-level, next to ConsoleSlotGuard, because a quick-capture press can
 * arrive on any route and the sign-in notice lands on whichever page the
 * handoff loads.
 *
 * The bridge is read through a server-null snapshot, the same trick as
 * hooks/use-media-query.ts: the server has no window, so the first client
 * render must agree with it, and the live half mounts one commit later.
 */
export function DesktopBridge() {
  const bridge = useSyncExternalStore(noopSubscribe, getDesktopBridge, () => null);
  return bridge ? <DesktopBridgeLive bridge={bridge} /> : null;
}

/**
 * A capture press, still on its way to the launcher. `from` is the path it was
 * pressed on, so a trip that ends anywhere else can drop it.
 */
type PendingCapture = { from: string };

function DesktopBridgeLive({ bridge }: { bridge: DsulDesktop }) {
  const router = useRouter();
  const pathname = usePathname();
  const settled = usePlannerStore(selectPlannerSettled);
  const email = useSessionUserStore((s) => s.user?.email ?? null);

  // The press handler outlives renders, so it reads the route through a ref
  // rather than re-subscribing on every navigation: each subscription sends
  // main a ready message, and those are for page loads, not route changes.
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  // The capture waiting for the launcher lives in a ref, and `presses` is only
  // the render it needs to be looked at again.
  const pending = useRef<PendingCapture | null>(null);
  const [presses, setPresses] = useState(0);

  useEffect(
    () =>
      bridge.onQuickCapture(() => {
        const here = pathRef.current;
        // /login and /auth/* have no launcher, and pushing home from there
        // would walk away from a sign-in in progress (or be bounced straight
        // back to /login by the auth gate).
        if (isSignedOutPath(here)) return;
        pending.current = { from: here };
        setPresses((n) => n + 1);
        // Home first and never wait for the planner here: a lean route never
        // settles (lib/planner-ready.ts), so waiting would hold the press
        // forever, and opening the slot away from home would leave it armed
        // for whenever the user next goes there.
        if (here !== LAUNCHER_HOME) router.push(LAUNCHER_HOME);
      }),
    [bridge, router]
  );

  // Opened from here rather than from the press so it waits for the two things
  // the launcher needs: AppShell on screen, and a loaded planner, since the add
  // it is about to make would otherwise be written into a store the load is
  // about to replace.
  useEffect(() => {
    const capture = pending.current;
    if (!capture) return;
    if (pathname === LAUNCHER_HOME) {
      if (!settled) return;
      pending.current = null;
      openQuickCapture();
      return;
    }
    // The trip went somewhere other than home: a sign-out bounce to /login, or
    // the user navigating before the push landed. Either way the capture is
    // dropped, so it cannot spring the launcher open on some later trip home.
    if (pathname !== capture.from) pending.current = null;
  }, [presses, pathname, settled]);

  // Asked once per mount, not once per effect run. Main's flag is one-shot, so
  // under StrictMode's mount, cleanup, mount a second ask would get false, and
  // a first ask cancelled by the cleanup would throw the true away.
  const askedNotice = useRef(false);
  const [noticeWanted, setNoticeWanted] = useState(false);
  useEffect(() => {
    if (askedNotice.current) return;
    askedNotice.current = true;
    bridge.takeSignInNotice().then(
      (yes) => {
        if (yes) setNoticeWanted(true);
      },
      // Main refuses a frame that is not the app's; that is simply no notice.
      () => {}
    );
  }, [bridge]);

  // "Signed in as" names the account the session actually holds, which is the
  // point: a sign-in handoff can be completed with a code minted for someone
  // else's account, and this is where that becomes visible. It waits for the
  // provider to adopt the session, which can land after the notice answers.
  const noticeShown = useRef(false);
  useEffect(() => {
    if (!noticeWanted || !email || noticeShown.current) return;
    noticeShown.current = true;
    toast(`Signed in as ${email}`);
  }, [noticeWanted, email]);

  return null;
}
