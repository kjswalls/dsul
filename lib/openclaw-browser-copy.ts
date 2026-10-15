import type { SetupFailure } from './openclaw-browser-store';

/**
 * The words for setting up OpenClaw chat in this browser, in one place, so the
 * setup dialog, Settings and the docs page say the same thing about what an
 * approved browser can do (memory/plans/openclaw-browser-chat.md, "What we
 * tell people"). No em dashes.
 *
 * The capability lines are measured, not hoped: against a real gateway, the
 * `operator.write` grant this browser asks for read sessions, logs and
 * redacted config and called tools, and was refused config changes, device
 * approvals and exec approvals.
 */

/** What an approved browser can do. Shown before the token is asked for, and again once set up. */
export const BROWSER_CAN = Object.freeze([
  'Chat with your agent, and see its other chats',
  'Use the tools you have given your agent',
  'Read your gateway’s logs and settings (secrets stay hidden)',
]);

export const BROWSER_CANNOT = Object.freeze([
  'Change your gateway’s settings',
  'Approve other devices',
  'Answer exec approvals',
]);

/** The honest line about dsul itself. */
export const IF_DSUL_IS_COMPROMISED =
  'If dsul were ever compromised, whoever controlled it could do the same, but only while dsul is open in this browser. If your agent can run commands on your computer, that includes your computer. Give chat an agent with only the tools you’re comfortable with, or turn on exec approvals so it asks before running commands.';

/** Where the shared token goes, and where it never goes. */
export const TOKEN_NOTE =
  'Your gateway token is used once, here, to introduce this browser. It’s never saved and never sent to dsul’s servers. After you approve, this browser signs in with its own key, which can’t be copied off it.';

/** Step 1's command: let this site ask to connect. */
export function allowOriginCommand(origin: string): string {
  return `openclaw config set gateway.controlUi.allowedOrigins '${JSON.stringify([origin])}' --strict-json`;
}

/** Step 3's command. */
export function approveCommand(requestId: string | null): string {
  return requestId ? `openclaw devices approve ${requestId}` : 'openclaw devices list';
}

/** To take this browser off the gateway as well as forgetting it here. */
export function removeCommand(deviceId: string): string {
  return `openclaw devices remove ${deviceId}`;
}

export const SETUP_FAILURE_COPY: Readonly<Record<SetupFailure, string>> = Object.freeze({
  address: 'That doesn’t look like a gateway address. It usually starts with wss://.',
  insecure:
    'From this page the address has to start with wss://. Put your gateway behind https, for example with Tailscale Serve.',
  unreachable:
    'Couldn’t reach that address from this browser. Check that the gateway is running and that this device can reach it, for example on your tailnet.',
  origin:
    'Your gateway turned dsul away. Run the command from the first step, restart the gateway if it asks, then try again.',
  token: 'That token didn’t work. Check it with openclaw config get gateway.auth.token.',
  unpaired: 'Your gateway didn’t recognise this browser. Try again.',
  unsupported: 'This browser can’t keep a device key. Try a current Chrome, Safari, Edge or Firefox.',
  other: 'Your gateway refused the connection. Check its logs, then try again.',
});
