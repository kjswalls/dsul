import { createInterface } from 'node:readline/promises'
import { readConfigFileSnapshotForWrite, writeConfigFile } from 'openclaw/plugin-sdk/config-runtime'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime'

const DSUL_URL = 'https://do.dsul.app'
const POLL_INTERVAL_MS = 3000
const MAX_WAIT_MS = 15 * 60 * 1000 // 15 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ask for the gateway's public URL (issue #146). Without it the plugin runs in
 * pull-only mode — no webhook push, no chat from Ask in dsul — and the old wizard never
 * mentioned it, so users had to discover the key by reading a startup warning.
 *
 * Returns undefined when skipped, or when there's no TTY to prompt on (the
 * wizard can be driven from a non-interactive shell).
 */
async function promptPublicUrl(): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined

  console.log('\n  Gateway public URL — lets dsul push changes to the plugin and')
  console.log('  powers chat from Ask in dsul. Example:')
  console.log('    https://midgar-1b4eaa3.turkey-rockhopper.ts.net')
  console.log('  Leave blank for pull-only mode (no webhooks, no chat).\n')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question('  Public URL (optional): ')).trim()
    if (!answer) return undefined
    if (!/^https?:\/\//i.test(answer)) {
      console.log('  ⚠️  Not a http(s) URL — skipping. Add publicUrl to openclaw.json later.')
      return undefined
    }
    return answer.replace(/\/$/, '')
  } finally {
    rl.close()
  }
}

export async function runSetup(): Promise<void> {
  console.log('\n⚡  dsul — Device Authorization\n')

  // 1. Initialize session
  let sessionId: string
  let userCode: string
  let connectUrl: string
  try {
    const res = await fetch(`${DSUL_URL}/api/agent/connect/init`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.error(`❌  Failed to start session: ${body.error ?? res.statusText}`)
      process.exit(1)
    }
    const data = await res.json() as {
      sessionId: string
      userCode: string
      connectUrl: string
      expiresAt: string
    }
    sessionId = data.sessionId
    userCode = data.userCode
    connectUrl = data.connectUrl
  } catch (err) {
    console.error(`❌  Could not reach dsul: ${(err as Error).message}`)
    process.exit(1)
  }

  // 2. Print instructions — use OSC 8 hyperlink if the terminal supports it
  const link = process.env.TERM_PROGRAM || process.env.WT_SESSION || process.env.ITERM_SESSION_ID
    ? `\x1b]8;;${connectUrl}\x1b\\${connectUrl}\x1b]8;;\x1b\\`
    : connectUrl
  console.log('  Open this URL in your browser:')
  console.log(`  ${link}\n`)
  console.log('  Waiting for authorization...\n')

  // 3. Poll loop
  const deadline = Date.now() + MAX_WAIT_MS
  let dots = 0

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    let poll: { status: string; apiKey?: string; dsulUrl?: string; error?: string }
    try {
      const pollRes = await fetch(
        `${DSUL_URL}/api/agent/connect/poll?session=${encodeURIComponent(sessionId)}`
      )
      poll = await pollRes.json()
    } catch {
      // Network hiccup — retry on next interval
      process.stdout.write('.')
      dots++
      continue
    }

    if (poll.status === 'authorized' && poll.apiKey) {
      if (dots > 0) process.stdout.write('\n')

      // 4. Validate the key works
      try {
        const ctxRes = await fetch(`${DSUL_URL}/api/agent/context`, {
          headers: { Authorization: `Bearer ${poll.apiKey}` },
        })
        if (!ctxRes.ok) {
          console.error(`\n❌  Key validation failed: ${ctxRes.status} ${ctxRes.statusText}`)
          process.exit(1)
        }
        const ctx = await ctxRes.json() as { tasks?: unknown[]; habits?: unknown[] }
        console.log(`\n✅  Connected! Found ${ctx.tasks?.length ?? 0} tasks, ${ctx.habits?.length ?? 0} habits.`)
      } catch (err) {
        console.error(`\n❌  Could not validate connection: ${(err as Error).message}`)
        process.exit(1)
      }

      // 5. Collect the gateway public URL, then write config
      const publicUrl = await promptPublicUrl()
      await writePluginConfig(poll.dsulUrl ?? DSUL_URL, poll.apiKey, publicUrl)
      if (!publicUrl) {
        console.log('\n  Pull-only mode — webhook push and chat from Ask are off.')
        console.log('  Add publicUrl to the dsul-context config in openclaw.json to enable them.')
      }
      console.log('\nConfig saved. Restart the gateway: openclaw gateway restart\n')
      return
    }

    if (poll.status === 'expired') {
      if (dots > 0) process.stdout.write('\n')
      console.error('\n❌  Session expired. Run setup again.')
      process.exit(1)
    }

    if (poll.status === 'consumed') {
      if (dots > 0) process.stdout.write('\n')
      console.error('\n❌  Session already used. Run setup again.')
      process.exit(1)
    }

    // Still pending
    process.stdout.write('.')
    dots++
  }

  if (dots > 0) process.stdout.write('\n')
  console.error('\n❌  Timed out waiting for authorization.')
  process.exit(1)
}

async function writePluginConfig(
  dsulUrl: string,
  apiKey: string,
  publicUrl?: string
): Promise<void> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite()

  const config = snapshot.config as OpenClawConfig & Record<string, unknown>
  const plugins = ((config.plugins ?? {}) as Record<string, unknown>)

  // Add dsul-context to plugins.allow if not already present
  const allow = Array.isArray(plugins.allow) ? [...plugins.allow] : []
  if (!allow.includes('dsul-context')) {
    allow.push('dsul-context')
  }
  plugins.allow = allow

  const entries = ((plugins.entries ?? {}) as Record<string, unknown>)
  const existing = ((entries['dsul-context'] ?? {}) as Record<string, unknown>)

  // Merge into the existing plugin config rather than replacing it — re-running
  // setup used to silently drop hand-added keys like webhookSecret, agentId,
  // and cacheTtlMs. publicUrl is only overwritten when the wizard collected one,
  // so skipping the prompt keeps whatever is already configured.
  const existingConfig = ((existing.config ?? {}) as Record<string, unknown>)
  const existingDsulConfig = ((existingConfig['dsul-context'] ?? {}) as Record<string, unknown>)

  entries['dsul-context'] = {
    ...existing,
    enabled: true,
    config: {
      ...existingConfig,
      'dsul-context': {
        ...existingDsulConfig,
        dsulUrl,
        apiKey,
        ...(publicUrl ? { publicUrl } : {}),
      },
    },
  }
  plugins.entries = entries
  ;(config as Record<string, unknown>).plugins = plugins

  await writeConfigFile(config, writeOptions)
}
