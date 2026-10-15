import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { BROWSER_CAN, BROWSER_CANNOT, IF_DSUL_IS_COMPROMISED } from '@/lib/openclaw-browser-copy';

export const metadata: Metadata = {
  title: 'Connect OpenClaw - dsul',
  description:
    'How to connect your own OpenClaw agent to dsul, with nothing to install and your gateway kept private.',
};

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pb-1">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </li>
  );
}

export default function OpenClawDocsPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 pt-[max(2.5rem,env(titlebar-area-height,0px))]">
      <div className="mx-auto w-full max-w-xl space-y-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dsul
        </Link>

        <header className="space-y-2">
          <div className="text-3xl">⚡</div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Connect OpenClaw
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            If you run your own OpenClaw agent, dsul can hand it tasks and it can read and
            change your planner. There is nothing to install: it uses two things OpenClaw
            already has, dsul&apos;s MCP tools and an automation that listens for work.
            Your gateway stays private, even if it lives only on your tailnet.
          </p>
        </header>

        <ol className="space-y-6">
          <Step n={1} title="Press Connect in dsul">
            <p>
              Open{' '}
              <Link href="/settings/beacon" className="text-primary hover:underline">
                Settings → AI
              </Link>{' '}
              and press <span className="text-foreground">Connect</span> under OpenClaw. dsul
              makes a key for your agent and shows three commands with it filled in. The key
              is shown only then, so copy the commands before you close Settings.
            </p>
          </Step>

          <Step n={2} title="Paste them on the machine OpenClaw runs on">
            <p>In a terminal there, the three commands:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>save the key in a file only you can read,</li>
              <li>
                add dsul as an MCP server, so your agent has its dsul tools (OpenClaw checks the
                server answers before it saves it),
              </li>
              <li>
                add an automation named <code className="font-mono text-xs text-foreground">dsul</code>{' '}
                that keeps a connection open to dsul and starts your agent when dsul says it has
                work.
              </li>
            </ul>
            <p>
              Settings → AI then shows OpenClaw as{' '}
              <span className="text-foreground">Paired</span>, and says when it last heard from
              it.
            </p>
          </Step>

          <Step n={3} title="Hand it something">
            <p>
              Right-click a task and choose <span className="text-foreground">Hand off to OpenClaw</span>.
              Your agent starts on it within seconds, says it is working, and reports back on the
              item. If it needs you, the item shows its question; answer it there and the agent
              picks it up again straight away.
            </p>
          </Step>
        </ol>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Why your gateway can stay private</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            dsul never calls your gateway. Your agent calls dsul, the same way it calls any
            website, and keeps one connection open so dsul can say &ldquo;you have work&rdquo;.
            That message carries nothing else: your agent then asks dsul for its queue with its
            own tools. Nothing needs Tailscale Funnel, a tunnel or a public address.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Lost the key, or moving machines?</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Press <span className="text-foreground">Connect again</span> in Settings → AI and paste
            the new commands. The old key stops working, and the commands replace the old MCP
            server and automation rather than adding a second.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Unpairing</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Unpair under Settings → AI. dsul revokes your agent&apos;s key, so it can no longer read
            or change your planner and the automation hears nothing. To tidy OpenClaw too, run{' '}
            <code className="font-mono text-xs text-foreground">openclaw mcp unset dsul</code>{' '}
            and remove the <code className="font-mono text-xs text-foreground">dsul</code>{' '}
            automation. Your saved conversations stay.
          </p>
        </div>

        <section id="chat" className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Chat with it in Ask</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Under OpenClaw in Settings → AI, <span className="text-foreground">Set up chat</span> pairs this
            browser with your gateway, the way OpenClaw&apos;s own Control UI pairs. Three steps: allow dsul&apos;s
            address in <code className="font-mono text-xs text-foreground">gateway.controlUi.allowedOrigins</code>,
            enter your gateway&apos;s address and token, then approve the browser with{' '}
            <code className="font-mono text-xs text-foreground">openclaw devices approve</code>. Your messages go
            from this browser straight to your gateway, so it has to be reachable from this device (on your
            tailnet, say). Each browser and phone sets up its own.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The token is used once, in your browser, to introduce it. It is never saved and never sent to
            dsul&apos;s servers. After you approve, the browser signs in with its own key, which can&apos;t be
            copied off it. Changing your gateway token signs every browser out, and so does signing out of dsul; you set chat up again.
          </p>
          <p className="text-sm font-medium text-foreground">What an approved browser can do</p>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {BROWSER_CAN.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">It can&apos;t:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {BROWSER_CANNOT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            That is the narrowest access OpenClaw offers a chat client on a personal gateway. {IF_DSUL_IS_COMPROMISED}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            To stop, press <span className="text-foreground">Forget this browser</span>, and run{' '}
            <code className="font-mono text-xs text-foreground">openclaw devices remove</code> with its id to take it
            off your gateway too.
          </p>
        </section>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Needs <code className="font-mono text-foreground">curl</code> on the gateway machine and
          an OpenClaw with stream automations (tested with 2026.10.2). Set up the older dsul
          plugin before? Its chat in Ask has stopped, so set up chat above, and press Connect to
          move hand-offs over too.
        </p>
      </div>
    </div>
  );
}
