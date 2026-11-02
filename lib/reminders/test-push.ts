'use client';

import { toast } from 'sonner';

/**
 * Settings → Rituals → Send a test: one notification to every device on the
 * account, through the same-user form of POST /api/push/send, and a toast
 * that says how many devices took it. "Took" is the push service's word, not
 * the phone's: a device that is off gets it when it comes back (up to six
 * hours, DEFAULT_TTL_S), so the copy says where to look rather than promising.
 */
export const TEST_PUSH_COPY = {
  title: 'dsul test',
  body: 'This is how a reminder will look. If you can read this, reminders reach this device.',
  sent: (n: number) =>
    n === 1
      ? 'Sent to 1 device. It should show up in a few seconds.'
      : `Sent to ${n} devices. They should show up in a few seconds.`,
  none: 'No device took it. Turn on Push notifications on the phone or browser you want reminders on.',
  failed: 'Couldn’t send the test. Try again in a moment.',
} as const;

export async function sendTestPush(userId: string | null): Promise<void> {
  if (!userId) return;
  try {
    const res = await fetch('/api/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        title: TEST_PUSH_COPY.title,
        body: TEST_PUSH_COPY.body,
        url: '/',
        tag: 'dsul-test',
      }),
    });
    if (!res.ok) {
      toast.error(TEST_PUSH_COPY.failed);
      return;
    }
    const { sent } = (await res.json()) as { sent?: number };
    if (sent && sent > 0) toast.success(TEST_PUSH_COPY.sent(sent));
    else toast(TEST_PUSH_COPY.none);
  } catch {
    toast.error(TEST_PUSH_COPY.failed);
  }
}
