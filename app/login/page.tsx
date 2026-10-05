'use client';

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ExternalLink, MailCheck } from 'lucide-react';
import { Wordmark } from '@/components/primitives/wordmark';
import { createClient } from '@/lib/supabase';
import { loginErrorMessage, loginRedirectTarget } from '@/lib/auth-redirect';
import { getDesktopBridge, type DsulDesktop } from '@/lib/desktop';
// Restored after the parallax-hero pass dropped it: lib/relay-config.ts still
// declares an `auth` flag, so ungating this surface left that entry dead while
// reading as live. Every other relay placement is switchable from there; this
// one should be too.
import { RELAY } from '@/lib/relay-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RelayField } from '@/components/primitives/relay-field';

export const dynamic = 'force-dynamic';

const BROWSER_UNOPENED = 'Couldn’t open your browser to sign in. Try again.';

const noopSubscribe = () => () => {};
const isDesktopApp = () => getDesktopBridge() !== null;

/**
 * How far the frost reaches from the focal point before it dissolves, as a
 * fraction of the window. Deliberately wider than it is… well, wide: the
 * sign-in column is left of centre, so a symmetric falloff would run off the
 * left edge at full strength and fade only on the right. These numbers land it
 * so the glass thins on BOTH sides within a normal window, and the open right
 * half — the half with nothing in it — is where the tiles come back crisp.
 */
const FROST_RX = 48;
const FROST_RY = 76;

/**
 * The ripple's origin, the frost's centre and the sign-in column all share one
 * point: the column's own centre, measured rather than assumed.
 *
 * This layout is left-aligned, so the inherited 50%/42% would have put the
 * wave's source in the empty half of the page — the one place where nothing is
 * happening. Measuring also means the composition survives every breakpoint
 * without a second set of hard-coded numbers: on a phone the column is nearly
 * centred and the focal point follows it there on its own.
 */
function useContentFocal() {
  const ref = useRef<HTMLDivElement>(null);
  const [focal, setFocal] = useState({ x: 0.5, y: 0.5 });

  // Layout effect, not a passive one: this runs before paint, so the field
  // mounts with the right origin instead of visibly re-striking its wave once
  // the measurement lands.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      const x = (r.left + r.width / 2) / window.innerWidth;
      const y = (r.top + r.height / 2) / window.innerHeight;
      // Changing the focal point re-inits the field — sprites and the whole
      // cell grid are rebuilt — so ignore the sub-pixel churn a scrollbar or a
      // zoom step produces and only move when it would actually be visible.
      setFocal((prev) =>
        Math.abs(prev.x - x) < 0.004 && Math.abs(prev.y - y) < 0.004 ? prev : { x, y }
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);

  return { ref, focal };
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // After auth, come back through /auth/callback and on to the requested page
  // (e.g. /connect?code=...). lib/auth-redirect.ts says why it is always the callback.
  const redirectParam = searchParams.get('redirect');
  const postAuthUrl = () =>
    `${window.location.origin}${loginRedirectTarget(redirectParam, window.location.origin)}`;
  // In the desktop app the sign-in finishes in the system browser and is handed
  // back through /auth/desktop, and the page's own redirect is dropped.
  const desktopAuthUrl = () =>
    `${window.location.origin}${loginRedirectTarget(null, window.location.origin, { desktop: true })}`;

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  // Desktop only: a sign-in the app handed back as /login?error=… opens on
  // dsul's own words for it. Only known values are read, never text from the
  // URL, and a browser keeps the bare form it has always had there. The server
  // has no bridge, so it is read through a snapshot that is false there (as in
  // components/providers/desktop-bridge.tsx) and hydration agrees.
  const inDesktopApp = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  const returnedError = inDesktopApp ? loginErrorMessage(searchParams.get('error')) : null;
  // Undefined until a sign-in starts on this page, which always sets it, so the
  // returned error shows only until then.
  const [error, setError] = useState<string | null | undefined>(undefined);
  const shownError = error === undefined ? returnedError : error;
  // Desktop only. The Google URL the system browser was sent to, kept so
  // "Open again" can send it there a second time with the same verifier.
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  // Desktop only. The link has to be opened on this computer, where the app
  // is waiting for it, so the sent copy says so.
  const [sentToDesktop, setSentToDesktop] = useState(false);
  // A token, not a counter of anything meaningful: every change re-strikes the
  // field's ripple from the focal point. See RelayField's `burst` docs.
  const [burst, setBurst] = useState(0);

  const { ref: columnRef, focal } = useContentFocal();

  const frostMask =
    `radial-gradient(ellipse ${FROST_RX}% ${FROST_RY}% at ` +
    `${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(1)}%, ` +
    `black 0%, black 34%, transparent 100%)`;

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    const desktop = getDesktopBridge();
    if (desktop) return sendDesktopLink(desktop);
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: postAuthUrl(),
      },
    });

    if (error) {
      setError(error.message);
    } else {
      setSent(true);
      // The link is gone and there is nothing left to click — so the
      // confirmation is a wave leaving from under the form rather than a
      // message that simply replaces it.
      setBurst((b) => b + 1);
    }
    setLoading(false);
  }

  async function handleGoogle() {
    const desktop = getDesktopBridge();
    if (desktop) return startDesktopGoogle(desktop);
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: postAuthUrl(),
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  // The desktop app's email sign-in. Main only accepts the dsul:// link the
  // email ends on while it is expecting one, so it is told once the email is
  // on its way. Not before: the PKCE verifier is written inside signInWithOtp,
  // and arming flushes the cookie store to disk.
  async function sendDesktopLink(desktop: DsulDesktop) {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: desktopAuthUrl(),
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    try {
      await desktop.armEmailSignIn();
    } catch {
      // The email is out, but the app would drop the link it ends on.
      setError('dsul couldn’t get ready for the link. Try again.');
      setLoading(false);
      return;
    }
    setSentToDesktop(true);
    setSent(true);
    setBurst((b) => b + 1);
    setLoading(false);
  }

  // The desktop app's Google sign-in. Google refuses to sign in inside an
  // embedded window, so the URL goes to the system browser instead of this
  // window navigating to it. The verifier is stored before signInWithOAuth
  // resolves, so the app can exchange the code when it comes back.
  async function startDesktopGoogle(desktop: DsulDesktop) {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: desktopAuthUrl(),
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url) {
      setError(error?.message ?? BROWSER_UNOPENED);
      setLoading(false);
      return;
    }

    const opened = await openInBrowser(desktop, data.url);
    // Nothing on this page finishes the sign-in, so the buttons come back now
    // rather than spinning until the app is handed the code.
    setLoading(false);
    if (opened) setHandoffUrl(data.url);
  }

  async function handleOpenAgain() {
    const desktop = getDesktopBridge();
    if (!desktop || !handoffUrl) return;
    setLoading(true);
    setError(null);
    await openInBrowser(desktop, handoffUrl);
    setLoading(false);
  }

  // Main checks the URL before opening it and answers false when it refuses,
  // so a false is shown rather than left as a page that never moves.
  async function openInBrowser(desktop: DsulDesktop, url: string) {
    let opened = false;
    try {
      opened = await desktop.openAuthUrl(url);
    } catch {
      opened = false;
    }
    if (!opened) setError(BROWSER_UNOPENED);
    return opened;
  }

  return (
    <div className="relative flex min-h-[100dvh] items-center overflow-hidden bg-background px-6 sm:px-10">
      {/* Tuning inherited from the parallax-hero pass, which this page's frost
          is layered over rather than replacing:

          radialGain 0.2 starts the ring calm at the focal and lets it grow
          hotter outward. Under the frost that is exactly the right shape — the
          field is quietest under the glass, where the copy sits, and hottest
          out at the margins where the tiles come back crisp.

          pointerFocus leans the focal a fraction of the way toward the cursor,
          and it leans away from focalX/focalY — which this page has moved onto
          the sign-in column. So the field tilts around the content rather than
          around the middle of the window. The frost does NOT follow: the glass
          stays put while the wave shifts under it, which is what makes it read
          as glass rather than as a spotlight.

          The denser pitch is deliberate under a 26px blur — 44px tiles blurred
          that far lose their identity and go to soup, while 30px ones stay a
          legible texture through it. */}
      {RELAY.auth && (
        <RelayField
          className="absolute inset-0 z-0"
          focalX={focal.x}
          focalY={focal.y}
          pitch={30}
          period={3.2}
          idleIntensity={0.85}
          radialGain={0.2}
          pointerFocus
          pointerBurst
          pointerEase={0.04}
          pointerParallax={0.15}
          burst={burst}
          mask="radial-gradient(130% 130% at 50% 50%, black 60%, transparent 100%)"
        />
      )}

      {/* The frost pane — full-bleed, not a card. The field's focal point sits
          behind it on purpose: the ripple is born under the glass and the rings
          only sharpen once they've travelled out past the falloff.

          Tint + blur + saturate are one recipe, not three options. The BLUR is
          what quiets the field: at this radius the tiles dissolve into soft
          bloom and the layer reads as a glass lens laid on the page, which is
          the whole effect. The tint only keeps type off the field's brightest
          crests, and the saturate stops the lime going grey once the blur has
          spread it thin.

          The inverse — a light blur under a heavy tint — was tried and
          rejected. It leaves the tiles' rounded-square shape legible through
          the veil, so the field reads as merely dimmed, and it costs the
          falloff its edge: a blur boundary announces itself as a lens, where a
          tint gradient can only dim. If this ever needs to be quieter, widen
          the mask's opaque core before reaching for the tint.

          --modal, not --card: per the ramp note in globals.css, --card is the
          top of the dark ramp and reads as a lamp at any real size.

          The mask and the backdrop-filter MUST sit on the SAME element. A mask
          on an ancestor makes that ancestor a "backdrop root", which empties
          the backdrop a nested backdrop-filter would sample — the blur then
          silently renders nothing while the tint still looks fine, so it fails
          as a subtle wash rather than as an obvious break. */}
      {RELAY.auth && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] bg-modal/45 backdrop-blur-[26px] backdrop-saturate-[1.25] dark:bg-modal/34"
          style={{ maskImage: frostMask, WebkitMaskImage: frostMask }}
        />
      )}

      <div className="relative z-10 mx-auto flex w-full max-w-3xl">
        <div
          ref={columnRef}
          className="w-full max-w-xs space-y-7 duration-700 animate-in fade-in fill-mode-both motion-reduce:animate-none"
        >
          {/* Identity — see components/primitives/wordmark.tsx. The fixed
              height keeps the form still while a larger hover flavor is up. */}
          <div className="space-y-1.5">
            <Wordmark className="h-[13px]" />
            <p className="text-[11.5px] text-muted-foreground">like vin diesel w/out the vin :)</p>
          </div>

          {handoffUrl ? (
            <div className="space-y-3 duration-500 animate-in fade-in slide-in-from-bottom-1 fill-mode-both motion-reduce:animate-none">
              <ExternalLink
                className="size-6 text-muted-foreground"
                strokeWidth={1.6}
                aria-hidden
              />
              <h1 className="text-[22px] font-semibold leading-[1.15] tracking-[-0.028em]">
                Finish signing in in your browser.
              </h1>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                Google is open in your browser. Once you&rsquo;re through,
                dsul picks up here.
              </p>
              <div className="space-y-3 pt-2">
                <Button
                  variant="outline"
                  className="h-10 w-full rounded-[10px] bg-card/55 text-[13.5px]"
                  onClick={handleOpenAgain}
                  disabled={loading}
                >
                  Open again
                </Button>
                {/* The app has no address bar, so without a way back a closed
                    browser tab would leave the email sign-in out of reach. */}
                <Button
                  variant="ghost"
                  className="h-9 w-full rounded-[10px] text-[12.5px] text-muted-foreground"
                  onClick={() => {
                    setHandoffUrl(null);
                    setError(null);
                  }}
                  disabled={loading}
                >
                  Sign in another way
                </Button>
                {shownError && (
                  <p className="text-[12.5px] leading-relaxed text-destructive">
                    {shownError}
                  </p>
                )}
              </div>
            </div>
          ) : sent ? (
            <div className="space-y-3 duration-500 animate-in fade-in slide-in-from-bottom-1 fill-mode-both motion-reduce:animate-none">
              <MailCheck
                className="size-6 text-success-text"
                strokeWidth={1.6}
                aria-hidden
              />
              <h1 className="text-[22px] font-semibold leading-[1.15] tracking-[-0.028em]">
                Check your email.
              </h1>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                We sent a sign-in link to{' '}
                <span className="text-foreground">{email}</span>.{' '}
                {sentToDesktop ? (
                  <>Open the link on this computer and you&rsquo;re in.</>
                ) : (
                  <>Open it on this device and you&rsquo;re in.</>
                )}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3 delay-100 duration-700 animate-in fade-in slide-in-from-bottom-2 fill-mode-both motion-reduce:animate-none">
                {/* Negative tracking is doing real work here — Inter sets loose
                    at display sizes and the two lines won't lock up without it. */}
                <h1 className="text-[27px] font-semibold leading-[1.12] tracking-[-0.032em] text-balance">
                  Plan the day you actually want.
                </h1>
                <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                  Sign in and pick up where the week left off.
                </p>
              </div>

              <div className="space-y-3 delay-200 duration-700 animate-in fade-in slide-in-from-bottom-2 fill-mode-both motion-reduce:animate-none">
                {/* bg-card/55 replaces the outline variant's opaque
                    `bg-background`, which was the one solid patch on the whole
                    frost — the glass died inside the button's rectangle, which
                    is exactly where the eye lands first. Dark already ships a
                    translucent `dark:bg-input/30`, so only light needs saying. */}
                <Button
                  variant="outline"
                  className="h-10 w-full gap-2 rounded-[10px] bg-card/55 text-[13.5px]"
                  onClick={handleGoogle}
                  disabled={loading}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Continue with Google
                </Button>

                {/* Two hairlines, not the usual rule-with-a-knockout: the
                    knockout is an opaque `bg-background` chip, which on a
                    translucent pane stamps a solid patch over the frost. */}
                <div className="flex items-center gap-3 text-[11px] uppercase text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>

                <form onSubmit={handleMagicLink} className="space-y-3">
                  {/* No label: the placeholder, the button beside it and the
                      type=email keyboard all say the same thing, and a lone
                      "Email" above a lone field is a caption for an audience of
                      one. aria-label keeps it named for assistive tech. */}
                  <Input
                    id="email"
                    type="email"
                    aria-label="Email address"
                    placeholder="you@example.com"
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                    className="h-10 rounded-[10px] text-[13.5px]"
                  />
                  <Button
                    type="submit"
                    className="h-10 w-full rounded-[10px] text-[13.5px]"
                    disabled={loading || !email}
                  >
                    {loading ? 'Sending…' : 'Continue with email'}
                  </Button>
                </form>

                {shownError && (
                  <p className="text-[12.5px] leading-relaxed text-destructive">
                    {shownError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[100dvh] bg-background" />
    }>
      <LoginPageInner />
    </Suspense>
  );
}
