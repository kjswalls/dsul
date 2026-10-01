import type { Metadata, Viewport } from 'next'
import { Geist, Inter, JetBrains_Mono, Nunito, Source_Serif_4 } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { ThemeProvider } from '@/components/theme-provider'
import { SupabaseProvider } from '@/components/providers/supabase-provider'
import { ConsoleSlotGuard } from '@/components/providers/console-slot-guard'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

// Variable font: full weight range + optical sizing; italic for serif microcopy
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
})

// Theme faces (lib/theme-looks.ts). Not preloaded: each is only used under
// its own theme, and a font-face nobody's styles reach is never downloaded, so
// Paper and Night pay nothing for them.
const geist = Geist({ subsets: ['latin'], variable: '--font-geist', preload: false })
const nunito = Nunito({ subsets: ['latin'], variable: '--font-nunito', preload: false })
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  preload: false,
})

export const metadata: Metadata = {
  title: 'dsul — Do Stuff Unlimited',
  description: 'A calm, minimal daily planner designed for neurodivergent minds. Plan your day with gentle structure.',
  generator: 'v0.app',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'dsul',
  },
  icons: {
    // The Wave mark (scripts/app-icon). Tabs follow the system theme; /favicon.ico is the
    // dark one for anything that asks for it by name.
    icon: [
      { url: '/icons/icon-16.png', sizes: '16x16', type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { url: '/icons/icon-16-light.png', sizes: '16x16', type: 'image/png', media: '(prefers-color-scheme: light)' },
      { url: '/icons/icon-32-light.png', sizes: '32x32', type: 'image/png', media: '(prefers-color-scheme: light)' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/icon-180.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  // Keep in sync with --surface-0 in app/globals.css (oklch → hex), AND with
  // the 'default' entry in lib/theme-palettes.ts — the palette sync effect
  // rewrites these metas per palette and restores this pair for the default.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1014' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${sourceSerif.variable} ${geist.variable} ${nunito.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {/* One-time key migration — anchor-* → dsul-* (the Anchor→dsul rename).
            MUST stay above the palette script and ahead of all hydration: an
            unstamped browser is an ORPHANED browser to lib/local-state.ts, so
            if `dsul-local-state-owner` were absent on the first load after the
            rename every store below it would be CLEARED as someone else's.
            Renaming the whole prefix in one pre-paint pass is what keeps the
            palette, the rebindings, the filters and every Beacon transcript.
            Prefix-wide (not a key list) so the per-item chat threads
            (`anchor-item-chat-<id>`) travel with the fixed keys; an existing
            dsul-* value always wins, so a second run is a no-op. The owner
            stamp moves FIRST and every key is moved under its own try: a
            storage quota error partway through must not be the thing that
            leaves the browser unstamped, and one failed write must cost only
            its own key rather than every key after it. (That key is not
            reliably recoverable on the next load — its store will have written
            a fresh dsul-* default by then, and an existing value wins — so the
            stamp going first is what keeps the failure to one store.) Safe to
            delete once every browser has loaded the app once after the
            rename. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var P='anchor-',Q='dsul-',O=P+'local-state-owner',M=function(s){var k=[],i,n,v;for(i=0;i<s.length;i++){n=s.key(i);if(n&&n.lastIndexOf(P,0)===0)k.push(n)}k.sort(function(a,b){return a===O?-1:b===O?1:0});for(i=0;i<k.length;i++){try{v=s.getItem(k[i]);n=Q+k[i].slice(P.length);if(v!==null&&s.getItem(n)===null)s.setItem(n,v);s.removeItem(k[i])}catch(e){}}};try{M(localStorage)}catch(e){}try{M(sessionStorage)}catch(e){}}catch(e){}",
          }}
        />
        {/* Palette and theme pre-hydration: stamp <html data-theme> (the
            palette) and data-look-light / data-look-dark (the theme picked for
            each mode, lib/theme-looks.ts LOOK_STORAGE_KEYS) from the raw
            localStorage key before first paint, the way next-themes pre-applies
            the .dark class — without this a non-default palette flashes the
            stock ground on every hard load. The key literal and slug grammar
            mirror lib/theme-palettes.ts (PALETTE_STORAGE_KEY); `?reset-theme`
            is the escape hatch for a palette bad enough to hide the UI that
            would undo it. The reset also sets a one-shot sessionStorage flag —
            hydrateSettings consumes it and persists 'default' server-side,
            otherwise the server row would re-apply the broken palette one
            settings round-trip later. Unknown slugs stamp harmlessly (no CSS
            block answers) and the provider effect re-syncs them after mount. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var r=document.documentElement,S=/^[a-z][a-z0-9-]{0,31}$/,K=[['dsul-look-light','data-look-light'],['dsul-look-dark','data-look-dark']],i,v;if(/[?&]reset-theme\\b/.test(location.search)){localStorage.removeItem('dsul-palette');for(i=0;i<K.length;i++)localStorage.removeItem(K[i][0]);sessionStorage.setItem('dsul-palette-reset','1')}else{var p=localStorage.getItem('dsul-palette');if(p&&p!=='default'&&S.test(p)){r.dataset.theme=p}for(i=0;i<K.length;i++){v=localStorage.getItem(K[i][0]);if(v&&S.test(v))r.setAttribute(K[i][1],v)}}}catch(e){}",
          }}
        />
        {/* No `disableTransitionOnChange`: it injected `transition: none` across
            the document and repainted every colour in one frame, which reads as
            a page reload. lib/theme-transition.ts + the `data-theme-changing`
            rule in globals.css grant a short, colour-only transition instead. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SupabaseProvider>
            {/* Route-level, not shell-level, because its whole job is to notice
                that you have LEFT the shell. See the component. */}
            <ConsoleSlotGuard />
            {children}
          </SupabaseProvider>
          {/* Bottom-left, above the sidebar history controls. Exact placement
              (clear of the dock on either shell) is a
              globals.css override — sonner 1.x only takes a single offset. */}
          <Toaster position="bottom-left" closeButton />
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  )
}
