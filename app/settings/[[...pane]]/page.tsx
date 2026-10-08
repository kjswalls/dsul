'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useTheme } from 'next-themes';

import { SettingsShell } from '@/components/settings/settings-shell';
import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { Button } from '@/components/ui/button';

import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useMorningStore } from '@/lib/morning-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useEODStore } from '@/lib/eod-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useModsStore } from '@/lib/mods-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useGatewayStore } from '@/lib/gateway-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { useUIStore } from '@/lib/ui-store';
import { flushSettings } from '@/lib/settings-service';
import { settingsBelongToUser } from '@/lib/settings/hydration';
import { resetOnboardingComplete } from '@/lib/user-profile';
import { createClient } from '@/lib/supabase';
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { applyThemeChange } from '@/lib/theme-transition';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  extensionPaneId,
  isExtensionPane,
  isPaneId,
  paneHref,
  resolvePaneSlug,
  settingById,
  type PaneId,
  type SettingCtx,
  type DestinationRecord,
} from '@/lib/settings/manifest';
import { consoleSectionExtension } from '@/components/planner/organize/console-rail';
import { extensionEnabled } from '@/lib/extension-gates';

/**
 * Settings, as a route.
 *
 * Follows the /item/[id] precedent — no AppShell, no canvas-container, the
 * root layout's SupabaseProvider supplying hydration and theme. Which means
 * this page has to do, by hand, the four things AppShell was doing for free:
 *
 *   1. The <html data-type-mode> stamp. AppShell is its ONLY writer, so without
 *      this the Typeface row would appear to save and change nothing — the
 *      worst failure shape available.
 *   2. flushSettings() on pagehide AND on unmount. Writes are debounced 500ms
 *      and a Next client-side navigation fires no pagehide at all, so leaving
 *      via the breadcrumb inside that window would silently drop the patch.
 *      The dialog literally could not do this; a route can.
 *   3. The modals the settings surface hands off to. ConfirmDialog and
 *      BugReportDialog are mounted only by AppShell, so dispatching to them
 *      through ui-store from here would set state that nothing renders. The one
 *      the surface opens BY NAME is lazy — see `openLocalDialog`; ConfirmDialog
 *      stays eager because it is answered by a store, not by this component,
 *      and a confirm that arrives before its dialog has downloaded is a prompt
 *      nobody sees.
 *   4. The hydration gate. Every store here is localStorage-persisted under a
 *      browser-global key, so before Supabase settles this page would render
 *      the PREVIOUS account's values as live controls — and a click inside that
 *      window writes someone else's preference to this user's row. The gate is
 *      `settingsBelongToUser` (lib/settings/hydration.ts), and it waits for the
 *      SETTINGS request only: it used to also wait on planner-store's
 *      `isLoading`, which is the seven-table item load this route never reads,
 *      and which the settings request usually beats anyway.
 */

/** The modals this page owns and opens by name (see the dynamic imports below). */
type LocalDialog = 'bug' | 'deleteAccount';

/** Where an unrecognised path goes. Nearest real pane, never a blank page. */
function fallbackPane(path: string | undefined): PaneId {
  return path && isExtensionPane(path) ? 'extensions' : 'day';
}

/* ── The modals this page opens by name, deferred ──────────────────────────
   Reached only from a row the user clicks: dsul → Send feedback, and dsul →
   Delete account, which is the same shape for the same reasons. Deferring it
   takes weight off this route's first load — measured across the PR that
   introduced the split at 40.6 kB gzip for the two modals that were deferred
   together, spent on surfaces most visits never open.

   THE SECOND ONE IS GONE, and that is the better outcome than deferring it:
   the keyboard shortcuts table used to be a modal this route summoned from an
   `action` row, so /settings/keyboard was a room whose only furniture was a
   door. The bindings are settings records now (SHORTCUT_RECORDS in
   lib/settings/manifest.ts) and the pane renders them itself, so there is no
   modal here to split off — the same table is still summonable with ⌘/ over the
   planner, from the shell that mounts it there.

   `ssr: false` because it has nothing to say before hydration and is already
   client-only (it captures a screenshot of the live document).

   next/dynamic fetches a chunk the first time the component RENDERS, not the
   first time it is opened, so this must not be left permanently mounted at
   `open={false}` — that downloads it on mount and the split buys nothing.
   `openLocalDialog` below is the other half: it latches a mount flag that is
   never cleared, so the chunk is fetched on the first open and the modal then
   STAYS mounted, keeping the close animation Radix needs a live subtree for. */
const BugReportDialog = dynamic(
  () => import('@/components/bug-report/bug-report-dialog').then((m) => m.BugReportDialog),
  { ssr: false }
);
const DeleteAccountDialog = dynamic(
  () => import('@/components/settings/delete-account-dialog').then((m) => m.DeleteAccountDialog),
  { ssr: false }
);

/**
 * What stands where the settings surface will be, while the settings request
 * is in flight.
 *
 * It is a SKELETON and not a message on purpose. The screen this replaces led
 * with "Loading…" over "If nothing loads, you may need to sign in", which read
 * as an auth check on a route the proxy has already refused to serve to a
 * signed-out visitor — the app asking, every single time, whether you were
 * really logged in. The escape hatch it existed for is kept below and shown
 * only when this has been on screen long enough to count as stuck.
 */
function SettingsSkeleton({ userId }: { userId: string | null }) {
  // Not a state machine — one timer, one boolean. Long enough that a normal
  // load never reaches it (the settings read is a single indexed row), short
  // enough to be an answer rather than an abandonment.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setStuck(true), 5000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <main
      // Mirrors SettingsShell's own container exactly, so the real surface
      // lands where the skeleton stood instead of jumping under the cursor.
      className="mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-8 pt-[max(2rem,env(titlebar-area-height,0px))]"
      data-testid="settings-page"
      data-settings-state="loading"
    >
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link
          href="/"
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          dsul
        </Link>
        <span aria-hidden>/</span>
        <span className="text-foreground font-medium">Settings</span>
      </nav>

      <h1 className="text-foreground text-2xl font-semibold tracking-tight">Settings</h1>

      {/* `animate-pulse` and not a bespoke shimmer: globals.css already clamps
          every animation to nothing under [data-reduce-motion], which
          SupabaseProvider stamps from the (browser-persisted, so immediately
          available) animations setting. A skeleton that sits perfectly still
          reads as broken; one that ignores that setting reads as rude. */}
      <div className="flex animate-pulse flex-col gap-8 md:flex-row md:gap-10" aria-hidden>
        <div className="flex shrink-0 gap-1 md:w-[184px] md:flex-col">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="bg-secondary h-8 w-full min-w-[92px] rounded-sm" />
          ))}
        </div>
        <div className="min-w-0 flex-1 md:max-w-[600px]">
          <div className="bg-secondary h-9 w-full rounded-md" />
          <div className="divide-border mt-6 divide-y">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex h-14 items-center justify-between gap-6">
                <div className="bg-secondary h-3 w-40 rounded-sm" />
                <div className="bg-secondary h-7 w-24 rounded-sm" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The old screen's whole point, kept and demoted: if this is still here
          after five seconds something is genuinely wrong, and a visitor with no
          usable session needs a way out that isn't the back button. Not one with
          NO session: proxy.ts sends that to /login (and reads an unreachable
          Supabase as one), and so does the provider for a page the server let
          through. This is for a stored session the browser could not refresh,
          or a cookie the proxy could not decode and so let through; the
          provider keeps both here on purpose (see its mount check). */}
      <p role="status" aria-live="polite" className="text-muted-foreground min-h-5 text-sm">
        {stuck ? 'Still loading your settings.' : ''}
      </p>
      {stuck && (
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
          {!userId && (
            <Button asChild variant="outline" size="sm">
              <Link href="/login?redirect=/settings">Sign in</Link>
            </Button>
          )}
        </div>
      )}
    </main>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const params = useParams<{ pane?: string[] }>();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const { theme, setTheme } = useTheme();
  const userId = usePlannerStore((s) => s.userId);
  const hydratedUserId = useMorningStore((s) => s.settingsHydratedUserId);
  const push = usePushSubscription();

  const [localDialog, setLocalDialog] = useState<LocalDialog | null>(null);
  // Whether each deferred modal has ever been opened. Latched, never cleared —
  // see the note on the dynamic import above for both halves of why: mounting
  // it unopened downloads it, unmounting it on close takes the exit animation
  // with it.
  const [everOpened, setEverOpened] = useState<Record<LocalDialog, boolean>>({
    bug: false,
    deleteAccount: false,
  });
  const openLocalDialog = useCallback((which: LocalDialog) => {
    setEverOpened((prev) => (prev[which] ? prev : { ...prev, [which]: true }));
    setLocalDialog(which);
  }, []);

  /* ── The pane is the WHOLE path, not the first segment ──────────────────
     An extension's settings live at /settings/extensions/<slug>, which the
     optional catch-all already captures as two segments. Joining them is what
     makes a sub-pane a real deep link rather than a URL that silently renders
     the extensions index — and it costs nothing for the one-segment panes,
     whose join is themselves. */
  const path = params?.pane?.join('/');
  // An alias (`ai`) is the pane it stands for, and stays in the address bar.
  const pane: PaneId = resolvePaneSlug(path) ?? fallbackPane(path);
  const focusId = searchParams?.get('focus') ?? undefined;

  /* ── 1. The type-mode stamp ───────────────────────────────────────────── */
  const typeMode = useViewStore((s) => s.typeMode);
  useEffect(() => {
    document.documentElement.dataset.typeMode = typeMode;
  }, [typeMode]);

  /* ── 2. Exit-save, both ways out ──────────────────────────────────────── */
  useEffect(() => {
    // pagehide, not beforeunload — it's the one that fires on mobile Safari.
    const onPageHide = () => void flushSettings();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Soft navigation away fires no pagehide, so the unmount is the only
      // hook a debounced write has left.
      void flushSettings();
    };
  }, []);

  /* ── A bare /settings is the day, not a blank "pick something" ───────────
     A path that names no pane is corrected in the URL too, rather than left
     pointing at something that isn't what rendered. An unknown extension slug
     lands on the extensions index — the list it was probably reached from, and
     the one page that can say which extensions exist.

     The ?focus= rides along. This replace is the ONLY navigation a bare
     /settings?focus=<id> gets — the self-routing effect below fires only when
     the record's home pane differs from the one rendering, so for every day.*
     record (home === the 'day' fallback) it correctly does nothing. Dropping
     the query here therefore dropped the deep link outright: on a cold load the
     hydration gate means SettingsShell is not mounted yet, so nothing has
     consumed focusId by the time this runs.

     An alias is left alone, query and all: `/settings/ai` is what the address
     bar is meant to say, and the AI pane reads its own `?start=` and
     `?connect=`, which a replace here would drop. */
  useEffect(() => {
    if (resolvePaneSlug(path)) return;
    const query = focusId ? `?focus=${encodeURIComponent(focusId)}` : '';
    router.replace(`${paneHref(fallbackPane(path))}${query}`);
  }, [path, focusId, router]);

  /* ── A ?focus= always lands on the pane that actually holds the row ───────
     The shell finds the row by querying the DOM, so a focus id belonging to
     another pane silently does nothing — and every extension field moved down
     a level when extensions got panes of their own, which would have turned
     every /settings/extensions?focus=extensions.<slug>.<field> link written
     before that into exactly that silent nothing. Sending the browser to the
     record's own pane keeps those links working and, more usefully, makes
     ?focus= self-routing: the id is enough, the pane no longer has to be
     right. It settles in one hop — after the replace the panes agree.

     `isPaneId(home)` is not belt-and-braces: PaneId is an open template literal
     now, so `pane: extensionPaneId('beemindr')` type-checks. Without the gate a
     single typo in a record would put this and the normalising effect above in
     a two-replace-per-render argument over the URL. */
  useEffect(() => {
    if (!focusId) return;
    const home = settingById(focusId)?.pane;
    if (!home || home === pane || !isPaneId(home)) return;
    router.replace(`${paneHref(home)}?focus=${encodeURIComponent(focusId)}`);
  }, [focusId, pane, router]);

  /* ── Subscriptions that keep record.read() fresh ──────────────────────────
     The manifest reads through getState() so it stays a plain module. These
     selectors are what make this component re-render when a value changes;
     without them a toggle would flip the store and not the screen. */
  const plannerTick = usePlannerStore(
    (s) =>
      `${s.timeFormat}|${s.weekStartDay}|${s.defaultTimeBucket}|${s.showCompletedTasks}|` +
      `${s.animationsEnabled}|${s.showCurrentTimeIndicator}|${s.showPausedOnGrid}|${s.userTimezone}`
  );
  const viewTick = useViewStore((s) => `${s.typeMode}|${s.bucketStyle}|${s.scheduleMarkStyle}`);
  const sidebarTick = useSidebarStore((s) => s.leftSidebarHoverEnabled);
  const morningTick = useMorningStore(
    (s) => `${s.morningCheckEnabled}|${s.morningAutoAgeEnabled}|${s.morningAutoAgeDays}`
  );
  const eodTick = useEODStore((s) => `${s.eodReviewEnabled}|${s.eodReviewTime}`);
  const reminderTick = useReminderStore(
    (s) =>
      `${s.remindersEnabled}|${s.lastCallEnabled}|${s.lastCallTime}|` +
      `${s.stakesEnabled}|${s.stakesSettleTime}`
  );
  // systemPrompt rides the tick VERBATIM: the text controls commit on blur by
  // comparing their draft against the last RENDERED value, so a stale value
  // prop silently drops the next edit. JSON.stringify rather than a '|' join
  // because it is free text and can contain the separator.
  const aiTick = useAISettingsStore((s) => JSON.stringify([s.chatTarget, s.systemPrompt]));
  // What the server last said is connected. The AI pane's rows read it through
  // getState() (who answers, the status words on the panel-owned records), so
  // it has to move the ctx like every other store. Never a key: the store
  // cannot hold one.
  const aiConnTick = useAIConnectionStore(
    (s) =>
      `${s.phase}|${s.available}|${s.model?.provider}|${s.model?.model}|${s.model?.status}|` +
      `${s.model?.authMethod}|${s.openclaw.gateway}|${s.openclaw.pluginChat}`
  );
  const paletteTick = usePaletteStore((s) => s.palette);
  const lookTick = useLookStore((s) => `${s.light}|${s.dark}|${s.layout}|${s.appIcon}`);
  // JSON.stringify because `enabled` is an object; `available` rides along so
  // the unavailable() reason appears without a reload once hydration settles.
  const extensionsTick = useExtensionsStore(
    // `configsLoaded` is NOT redundant with the two objects beside it: an
    // account that has never toggled an extension resolves to `{}` and `{}`,
    // which is exactly what the store started at — so without it the rows that
    // render `pending` off this flag would sit at "Still loading…" for the rest
    // of the session on precisely the accounts with nothing to load.
    //
    // configs rides along VERBATIM, for the aiTick reason: the text controls
    // commit on blur by comparing their draft against the last RENDERED value,
    // so a stale value prop silently drops the next edit.
    (s) =>
      `${s.available}|${s.configsLoaded}|${JSON.stringify(s.enabled)}|${JSON.stringify(s.configs)}`
  );
  // Only which keys are set — the store cannot hold a value to leak.
  const channelSecretsTick = useChannelSecretsStore(
    (s) => `${s.available}|${JSON.stringify(s.setKeys)}`
  );
  // The URL is readable state and the text control compares against the last
  // RENDERED value, so it has to ride the tick or the next edit is dropped.
  const gatewayTick = useGatewayStore(
    (s) => `${s.available}|${s.gatewayUrl}|${s.hasToken}|${s.error ?? ''}`
  );
  // The Keyboard pane's own rows subscribe directly (ShortcutsPanel), so this
  // is for the OTHER path a binding is drawn on: a search result, which goes
  // through the generic rowFor and reads record.read(ctx) non-reactively.
  const shortcutsTick = useKeyboardShortcutsStore((s) => JSON.stringify(s.overrides));
  // make.allOff's unavailable() reads `available`, which MakePane's hydrate can
  // latch false after the row first renders.
  const modsTick = useModsStore((s) => s.available);

  const signOut = useCallback(async () => {
    // Anything still buffered has to land while the session is alive, or RLS
    // rejects it and the change is lost.
    await flushSettings();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }, [router]);

  const replayTour = useCallback(async () => {
    await flushSettings();
    // The account the provider already stamped — no getUser() round trip.
    const uid = userId;
    if (uid) await resetOnboardingComplete(uid);
    // The tour's steps target shell-only DOM and OnboardingTour mounts inside
    // AppShell, so the only way to replay it is to go where it lives —
    // AppShell's onboarding watcher (lib/onboarding-watch.ts) re-checks once
    // the planner is loaded and opens it.
    router.push('/');
  }, [router, userId]);

  // Wrapped once here rather than inside the manifest record, so the palette
  // and the page cannot ease differently.
  const setThemeSmoothly = useCallback(
    (next: string) => applyThemeChange(() => setTheme(next)),
    [setTheme]
  );

  const ctx = useMemo<SettingCtx>(
    () => ({
      theme,
      setTheme: setThemeSmoothly,
      userId,
      push,
      actions: {
        openBugReport: () => openLocalDialog('bug'),
        replayTour: () => void replayTour(),
        signOut: () => void signOut(),
        openLedger: () => router.push('/ledger'),
        deleteAccount: () => openLocalDialog('deleteAccount'),
      },
    }),
    // The ticks are the point: they are not read here, they are what makes this
    // memo (and therefore every record.read()) recompute on a store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      theme,
      setThemeSmoothly,
      userId,
      push,
      router,
      replayTour,
      signOut,
      openLocalDialog,
      plannerTick,
      viewTick,
      sidebarTick,
      morningTick,
      eodTick,
      reminderTick,
      aiTick,
      aiConnTick,
      paletteTick,
      lookTick,
      extensionsTick,
      channelSecretsTick,
      gatewayTick,
      shortcutsTick,
      modsTick,
    ]
  );

  const openDestination = useCallback(
    (record: DestinationRecord) => {
      if (record.action === 'connect-openclaw') {
        router.push('/connect');
        return;
      }
      if (record.action === 'openclaw-docs') {
        router.push('/docs/openclaw');
        return;
      }
      if (record.action === 'ledger') {
        router.push('/ledger');
        return;
      }
      // Every remaining destination is a console section, and a section rides
      // an extension (console-rail.tsx). With that extension off the console
      // closes itself on arrival, so the row would look broken — send the user
      // to the switch instead, which is both the truthful answer and the one
      // click that makes the destination work. The ROW stays in the search
      // index either way: off is findable.
      //
      // `null` is a section that rides nothing and may never be gated — today
      // that is Trash, which someone reaches for from a different emotional
      // place than the rest of this list and must never be redirected to a
      // settings switch on the way. It falls straight through to the open below.
      const slug = consoleSectionExtension(record.section);
      if (slug !== null && !extensionEnabled(slug)) {
        router.push(`/settings/${extensionPaneId(slug)}`);
        return;
      }
      // ui-store is a module singleton and survives client-side navigation, so
      // arming the dialog before pushing lands on the planner with it already
      // open — no new prop threading through AppShell.
      useUIStore.getState().openDialog({ type: 'organize', section: record.section });
      router.push('/');
    },
    [router]
  );

  /* ── 4. The hydration gate ────────────────────────────────────────────── */
  // `userId` alone is not "loaded" — initializeStore stamps it before anything
  // has been fetched. `settingsHydratedUserId` is the honest answer to "are
  // these values this account's yet": it is stamped in the same set() as the
  // server values, so it can never disagree with them. See
  // lib/settings/hydration.ts for the whole argument, including why
  // planner-store's `isLoading` — the seven-table item load — is deliberately
  // not part of it.
  const hydrated = settingsBelongToUser(userId, hydratedUserId);

  // Delete account sits OUTSIDE the gate, so it keeps its state when the gate
  // drops. A browser can switch accounts under an open dialog (an email link
  // for another account opened in a second tab): the gate goes to the skeleton
  // until the new account's settings land. Inside the gate the dialog would
  // unmount there and come back open by itself, asking about the NEW account.
  // Out here it keeps the account it was opened for, and the server answers a
  // delete with 409 changed (memory/plans/account-deletion.md).
  const deleteAccountDialog = everOpened.deleteAccount && (
    <DeleteAccountDialog
      open={localDialog === 'deleteAccount'}
      onOpenChange={(open) => setLocalDialog(open ? 'deleteAccount' : null)}
    />
  );

  return (
    <>
      {hydrated ? (
        <div data-testid="settings-page" data-settings-state="ready">
          <SettingsShell
            pane={pane}
            ctx={ctx}
            focusId={focusId}
            isMobile={isMobile}
            onOpenDestination={openDestination}
          />

          {/* Mounted here because AppShell isn't. */}
          <ConfirmDialog />
          {everOpened.bug && (
            <BugReportDialog
              open={localDialog === 'bug'}
              onOpenChange={(open) => setLocalDialog(open ? 'bug' : null)}
            />
          )}
        </div>
      ) : (
        <SettingsSkeleton userId={userId} />
      )}
      {deleteAccountDialog}
    </>
  );
}
