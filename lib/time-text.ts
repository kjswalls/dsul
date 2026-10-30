/**
 * Times as people type them, for the one time picker
 * (components/ui/time-picker.tsx). Every stored time in dsul is "HH:mm" on a
 * 24-hour clock; this module turns "930", "2pm", "noon" or "in 2h" into that,
 * and draws "HH:mm" back out in the user's own clock. Pure, so the picker's
 * rules are tested without a DOM.
 */

export type TimeFormat = '12h' | '24h';

/** Minutes after midnight for "HH:mm", or null for anything else. */
export function toMinutes(hhmm: string): number | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "HH:mm" for minutes after midnight, wrapping past either end of the day. */
export function fromMinutes(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * "HH:mm" in the user's clock: "9:30 AM" or "09:30". Capitals, as the picker's
 * rows and every menu value beside them read; the schedule's own lowercase
 * "9:30 am" is a different surface and keeps its own formatter.
 */
export function formatClock(hhmm: string, format: TimeFormat): string {
  const min = toMinutes(hhmm);
  if (min == null) return hhmm;
  if (format === '24h') return hhmm;
  const h = Math.floor(min / 60);
  return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What someone typed, as "HH:mm", or null when it is not a time.
 *
 * Takes "9", "930", "0930", "9:30", "9.30", "9a", "9:30 pm", "21:30", "noon",
 * "midnight", "in 45m" and "in 2h". A bare hour with no am/pm on a 12-hour
 * clock is the next one still ahead today ("9" at 3 PM is 9 PM), because the
 * time someone is choosing is almost always one that has not happened yet; a
 * leading zero ("09") or a 24-hour clock means exactly what it says.
 */
export function parseTimeText(raw: string, format: TimeFormat, nowMin: number): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';

  const rel = /^in (\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const mins = rel[2].startsWith('h') ? n * 60 : n;
    // To the next five minutes, the way a person would say it back.
    return fromMinutes(Math.round((nowMin + mins) / 5) * 5);
  }

  const t = /^(\d{1,2})(?:[:.]?(\d{2}))? ?(a|am|a\.m\.|p|pm|p\.m\.)?$/.exec(s);
  if (!t) return null;
  let h = Number(t[1]);
  const mm = t[2] ? Number(t[2]) : 0;
  if (mm > 59) return null;
  const ap = t[3]?.[0];
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
    return fromMinutes(h * 60 + mm);
  }
  if (h > 23) return null;
  if (format === '12h' && h >= 1 && h <= 11 && !t[1].startsWith('0')) {
    const am = h * 60 + mm;
    const pm = am + 720;
    return fromMinutes(am >= nowMin ? am : pm >= nowMin ? pm : am);
  }
  return fromMinutes(h * 60 + mm);
}

/** The picker's rows: every half hour of the day. */
export const TIME_STEPS: readonly string[] = Array.from({ length: 48 }, (_, i) => fromMinutes(i * 30));

/**
 * The rows for what has been typed. Empty: every step, plus the current value
 * when it falls between two. Otherwise the typed time first (it is what Enter
 * takes), then the steps whose digits start the same way, so "7" offers 7:00
 * and 7:30 in both halves of the day. Two or three digits that are not a time
 * yet ("94") are read as the start of one ("940").
 */
export function timeRows(
  query: string,
  value: string,
  format: TimeFormat,
  nowMin: number
): { rows: string[]; typed: string | null } {
  const q = query.trim();
  if (!q) {
    const rows = [...TIME_STEPS];
    if (toMinutes(value) != null && !rows.includes(value)) {
      rows.push(value);
      rows.sort();
    }
    return { rows, typed: null };
  }
  let typed = parseTimeText(q, format, nowMin);
  if (typed == null && /^\d{2,3}$/.test(q)) typed = parseTimeText(`${q}0`, format, nowMin);
  const digits = q.replace(/\D/g, '');
  const matches = digits
    ? TIME_STEPS.filter((step) => {
        if (step === typed) return false;
        const shown = formatClock(step, format).replace(/\D/g, '');
        return shown.startsWith(digits) || shown.startsWith(`0${digits}`);
      })
    : [];
  return { rows: typed ? [typed, ...matches] : matches, typed };
}
