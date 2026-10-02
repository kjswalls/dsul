/**
 * The one clock every chat surface reads a time by: a reply's time in a
 * transcript, a History row's (for today's conversations) and an activity
 * row's on Ask home. "8:02", or "08:02" under the 24-hour setting, in the
 * user's zone (the planner's `userTimezone`; the browser's while that is not
 * hydrated). No am/pm: the rail is narrow, and the design reads "8:02"
 * wherever a conversation's time shows, so two rows of the same column never
 * disagree about the same minute ("8:02 AM" above "8:04").
 */
export function clockTime(at: number, timeZone: string | null | undefined, timeFormat: '12h' | '24h'): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: timeFormat === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle: timeFormat === '24h' ? 'h23' : 'h12',
  }
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone : undefined
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone })
  } catch {
    // A zone this engine does not know: the browser's, not a thrown render.
    format = new Intl.DateTimeFormat('en-US', options)
  }
  const parts = format.formatToParts(new Date(at))
  const hour = parts.find((p) => p.type === 'hour')?.value ?? ''
  const minute = parts.find((p) => p.type === 'minute')?.value ?? ''
  return `${hour}:${minute}`
}

/**
 * Format a chat message timestamp in the user's preferred time zone and 12h/24h style.
 * Uses DB `user_settings.timezone` when hydrated into the planner store; otherwise the browser zone.
 * `timeFormatPattern` is lib/use-time-format.ts's ('h:mm a' or 'HH:mm'); the clock is clockTime's.
 */
export function formatChatTimestamp(
  timestampMs: number,
  timeFormatPattern: string,
  userTimezone: string | null | undefined
): string {
  return clockTime(timestampMs, userTimezone, timeFormatPattern.includes('a') ? '12h' : '24h')
}
