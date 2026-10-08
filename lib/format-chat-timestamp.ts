/**
 * The one clock every chat surface reads a time by: a reply's time in a
 * transcript, a History row's (for today's conversations) and an activity
 * row's on Ask home. "8:02", or "08:02" under the 24-hour setting, in the
 * user's zone (the planner's `userTimezone`; the browser's while that is not
 * hydrated). No am/pm: the rail is narrow, and it reads "8:02"
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
 * When a limit lifts, as a sentence says it: "7 am", "5:52 pm", "midnight",
 * or "07:00" under the 24-hour setting, in the user's zone. Unlike
 * `clockTime` it keeps am/pm: it stands alone in a line of copy, where "7:00"
 * could be either.
 */
export function resetClock(at: number, timeZone: string | null | undefined, timeFormat: '12h' | '24h'): string {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone : undefined
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone })
  } catch {
    format = new Intl.DateTimeFormat('en-US', options)
  }
  const parts = format.formatToParts(new Date(at))
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return ''
  const mm = String(minute).padStart(2, '0')
  if (timeFormat === '24h') return `${String(hour).padStart(2, '0')}:${mm}`
  if (hour === 0 && minute === 0) return 'midnight'
  if (hour === 12 && minute === 0) return 'noon'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const suffix = hour < 12 ? 'am' : 'pm'
  return minute === 0 ? `${h12} ${suffix}` : `${h12}:${mm} ${suffix}`
}
