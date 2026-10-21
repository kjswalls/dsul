/**
 * The commands Settings → AI → OpenClaw → Connect shows, to paste into the
 * machine OpenClaw runs on (app/docs/openclaw says the same in prose).
 *
 * A plugin-free connection is three things OpenClaw already does by itself:
 *
 *   1. The key goes in a file only its owner can read, so the commands read
 *      it from there rather than spelling it out (MCP's config stores the
 *      header it is given, like any other OpenClaw secret).
 *   2. dsul's tools, over MCP (`openclaw mcp add`, which probes the server and
 *      refuses to save one that does not answer, so a bad key fails here). It
 *      refuses a name it already has, so a reconnect unsets the old one first.
 *   3. A stream automation that holds dsul's work feed open
 *      (/api/agent/events) and starts an agent turn on each `data: work` line.
 *      The connection goes OUT from OpenClaw, so a gateway on a tailnet or
 *      behind NAT needs nothing exposed. The loop reconnects when dsul closes
 *      the feed, which it does every few minutes.
 *
 * Pure and client-safe: the key is only ever passed in, never stored.
 */

/** Where the key lives on the OpenClaw machine. */
export const OPENCLAW_KEY_FILE = '~/.openclaw/dsul.key';

/**
 * The automation's name and declaration key: adding it again with the same key
 * replaces it (`--declaration-key`), so pasting a later Connect's commands
 * leaves one listener, never two.
 */
export const OPENCLAW_AUTOMATION = 'dsul';

/** What the agent is told each time the feed says it has work. */
export const OPENCLAW_WORK_BRIEF = [
  'dsul has work for you.',
  'Call dsul_my_work to see your queue. For each item: mark it working with dsul_report_progress, ' +
    "do the work, then report the outcome with dsul_report_progress (status 'done', or 'failed' with why).",
  'If you are blocked on something only the user can answer, ask with dsul_ask_user and move on.',
  "An item with aiMode 'prepare' is only to get ready: read dsul_prep_brief once, hand back what you prepared with dsul_save_prep, " +
    "report done, and never send anything or complete the item.",
  'If dsul_my_work lists nothing new, do nothing.',
].join(' ');

/** Single-quotes a string for sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface OpenClawSetup {
  /** Each step: what it does, and the command. */
  steps: { label: string; command: string }[];
  /** All of it, to paste in one go. */
  script: string;
}

export function openClawSetup(origin: string, key: string): OpenClawSetup {
  const base = origin.replace(/\/+$/, '');
  const readKey = `$(cat ${OPENCLAW_KEY_FILE})`;
  const listen = `while :; do curl -sN -H "Authorization: Bearer ${readKey}" ${base}/api/agent/events; sleep 5; done`;
  const steps = [
    {
      label: 'Save the key where only you can read it',
      command: `mkdir -p ~/.openclaw && (umask 077 && printf '%s' ${sq(key)} > ${OPENCLAW_KEY_FILE})`,
    },
    {
      label: "Give OpenClaw dsul's tools",
      command:
        `openclaw mcp unset dsul >/dev/null 2>&1; ` +
        `openclaw mcp add dsul --url ${base}/api/mcp --transport streamable-http ` +
        `--header "Authorization=Bearer ${readKey}"`,
    },
    {
      label: 'Let dsul tell it when there is work',
      command:
        `openclaw automations add --name ${OPENCLAW_AUTOMATION} --declaration-key ${OPENCLAW_AUTOMATION} ` +
        `--stream-command ${sq(JSON.stringify(['sh', '-c', listen]))} ` +
        `--stream-mode match --stream-match '^data: work' --session isolated ` +
        `--message ${sq(OPENCLAW_WORK_BRIEF)}`,
    },
  ];
  return { steps, script: steps.map((s) => s.command).join('\n') };
}
