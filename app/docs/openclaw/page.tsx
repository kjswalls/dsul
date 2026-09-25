import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { CopyableCommand } from '@/components/docs/copyable-command';

export const metadata: Metadata = {
  title: 'Connect OpenClaw — dsul',
  description:
    'How to connect your own OpenClaw instance to dsul so your agent knows what is on your plate.',
};

const PLUGIN_DOCS_URL =
  'https://github.com/kjswalls/dsul/tree/main/openclaw-plugin#readme';

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
    <div className="min-h-[100dvh] bg-background px-4 py-10">
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
            If you run your own OpenClaw gateway, the dsul plugin lets your agent see
            your tasks and habits from any channel — no copy-pasting your list into chat.
            Five minutes, mostly waiting.
          </p>
        </header>

        <ol className="space-y-6">
          <Step n={1} title="Install the plugin">
            <p>On the machine running your OpenClaw gateway:</p>
            <CopyableCommand command="openclaw plugins install @dsul/openclaw-context" />
          </Step>

          <Step n={2} title="Start the setup wizard">
            <CopyableCommand command="openclaw dsul-context setup" />
            <p>
              It prints a device code and a link to this app. Nothing to copy into
              dsul by hand — leave the terminal running and open the link.
            </p>
          </Step>

          <Step n={3} title="Authorize in your browser">
            <p>
              The link opens{' '}
              <Link href="/connect" className="text-primary hover:underline">
                the connect page
              </Link>
              . Log in if you are not already, check that the code on screen matches the
              one in your terminal, and press <span className="text-foreground">Authorize</span>.
            </p>
            <p>
              Your terminal picks it up within a few seconds and confirms how many tasks
              and habits it can see. The code is good for 15 minutes and works once —
              if it lapses, just run the setup command again. That happens to everyone.
            </p>
          </Step>

          <Step n={4} title="Answer the public URL prompt (optional)">
            <p>
              The wizard then asks for your gateway&apos;s public URL, something like{' '}
              <code className="font-mono text-xs text-foreground">
                https://your-gateway.ts.net
              </code>
              . With it, dsul pushes changes to the plugin the moment they happen, and
              the chat sidebar in dsul can talk to your agent.
            </p>
            <p>
              Leaving it blank is a perfectly fine choice. That is pull-only mode: the
              plugin still refreshes your context on its own, there is just no push and no
              sidebar chat. Settings will show{' '}
              <span className="text-foreground">Connected · pull-only</span> — still
              connected, still working. You can add{' '}
              <code className="font-mono text-xs text-foreground">publicUrl</code>{' '}
              to the <code className="font-mono text-xs text-foreground">dsul-context</code>{' '}
              config in <code className="font-mono text-xs text-foreground">openclaw.json</code>{' '}
              whenever you like.
            </p>
          </Step>

          <Step n={5} title="Restart the gateway">
            <CopyableCommand command="openclaw gateway restart" />
            <p>
              Then turn on <span className="text-foreground">OpenClaw</span> under
              Settings → Beacon. That is it — your agent now sees your day from
              wherever you talk to it.
            </p>
          </Step>
        </ol>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Re-running setup is safe</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The wizard merges into your existing config rather than replacing it, so
            hand-added keys stay put. Run it again any time something looks off.
          </p>
        </div>

        <a
          href={PLUGIN_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          Full plugin docs — config keys, webhooks, what gets injected
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}
