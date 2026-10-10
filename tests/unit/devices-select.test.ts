import { describe, expect, it } from 'vitest';
import { inQuietHours, prefsOf, selectDevices } from '@/lib/devices/select';
import { STALE_DAYS, isStale } from '@/lib/devices/prune';
import type { DeviceRow, DeviceSendKind } from '@/lib/devices/types';

/**
 * selectDevices: which of a user's devices a send goes to
 * (memory/plans/reminders-platforms.md §5.2). Pure, so every rule is a row
 * here, and the first rule that holds a device names why.
 */

const NOW = Date.parse('2026-10-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const row = (extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id: `row-${++n}`,
  user_id: 'u1',
  device_id: `device-${n}-000`,
  platform: 'web',
  transport: 'webpush',
  delivery: 'push',
  os: 'macos',
  form: 'desktop',
  token: `https://push.example/${n}`,
  keys: { p256dh: 'p', auth: 'a' },
  timezone: 'Europe/London',
  prefs: {},
  registered_at: new Date(NOW - DAY).toISOString(),
  last_seen_at: new Date(NOW - DAY).toISOString(),
  ...extra,
});

const why = (rows: DeviceRow[], kind: DeviceSendKind, target = rows[0]) => {
  const { eligible, held } = selectDevices(rows, kind, NOW);
  if (eligible.includes(target)) return 'sent';
  return held.find((h) => h.row === target)?.reason;
};

const iphonePwa = () => row({ os: 'ios', form: 'phone' });
const iphoneApp = (transport: DeviceRow['transport'] = 'none') =>
  row({ platform: 'ios', transport, delivery: 'local', os: 'ios', form: 'phone', token: transport === 'none' ? null : 'a'.repeat(64), keys: null });

describe('selectDevices', () => {
  it('sends to an ordinary browser, for every kind', () => {
    for (const kind of ['cue', 'snooze', 'last-call', 'eod', 'pledge', 'other'] as const) {
      expect(why([row()], kind)).toBe('sent');
    }
  });

  it('never pushes to a tokenless device', () => {
    expect(why([row({ transport: 'none', token: null, keys: null })], 'last-call')).toBe('no_transport');
  });

  it('a device that schedules its own cues takes no cue, snooze or eod, but still takes the rest', () => {
    const local = row({ delivery: 'local' });
    expect(why([local], 'cue')).toBe('local');
    expect(why([local], 'snooze')).toBe('local');
    expect(why([local], 'eod')).toBe('local');
    expect(why([local], 'last-call')).toBe('sent');
    expect(why([local], 'pledge')).toBe('sent');
  });

  describe('native wins on the iPhone', () => {
    it('holds the Home Screen app for cue, snooze and eod while the app is on the phone', () => {
      const pwa = iphonePwa();
      for (const kind of ['cue', 'snooze', 'eod'] as const) {
        expect(why([pwa, iphoneApp()], kind, pwa)).toBe('native_wins');
      }
    });

    it('still pushes last call while the app has no push of its own, and holds it once it does', () => {
      const pwa = iphonePwa();
      expect(why([pwa, iphoneApp('none')], 'last-call', pwa)).toBe('sent');
      expect(why([pwa, iphoneApp('apns')], 'last-call', pwa)).toBe('native_wins');
    });

    it('keeps the iPad, which is not the phone the app is on', () => {
      const ipad = row({ os: 'ios', form: 'tablet' });
      expect(why([ipad, iphoneApp()], 'cue', ipad)).toBe('sent');
    });

    it('lets a stale app row cover nothing', () => {
      const pwa = iphonePwa();
      const gone = { ...iphoneApp(), last_seen_at: new Date(NOW - 200 * DAY).toISOString() };
      expect(why([pwa, gone], 'cue', pwa)).toBe('sent');
    });

    it('gives way to a per-device override', () => {
      const pwa = row({ os: 'ios', form: 'phone', prefs: { kinds: { cue: true } } });
      expect(why([pwa, iphoneApp()], 'cue', pwa)).toBe('sent');
      expect(why([pwa, iphoneApp()], 'eod', pwa)).toBe('native_wins');
    });

    it('holds nothing without the app', () => {
      expect(why([iphonePwa()], 'cue')).toBe('sent');
    });
  });

  it('a muted device takes nothing', () => {
    expect(why([row({ prefs: { muted: true } })], 'other')).toBe('muted');
  });

  it('a kind switched off is held, an absent kind is on', () => {
    const r = row({ prefs: { kinds: { 'last-call': false } } });
    expect(why([r], 'last-call')).toBe('kind_off');
    expect(why([r], 'cue')).toBe('sent');
  });

  it('a device unseen past its transport’s limit is held, as tonight’s prune would delete it', () => {
    expect(why([row({ last_seen_at: new Date(NOW - 181 * DAY).toISOString() })], 'cue')).toBe('stale');
    expect(why([row({ last_seen_at: new Date(NOW - 179 * DAY).toISOString() })], 'cue')).toBe('sent');
    expect(why([row({ transport: 'fcm', last_seen_at: new Date(NOW - 61 * DAY).toISOString() })], 'cue')).toBe('stale');
  });

  it('quiet hours hold a send in the device’s own zone', () => {
    // 12:00 UTC is 21:00 in Tokyo and 13:00 in London.
    const quiet = { quiet: { start: '20:00', end: '07:00' } };
    expect(why([row({ timezone: 'Asia/Tokyo', prefs: quiet })], 'cue')).toBe('quiet');
    expect(why([row({ timezone: 'Europe/London', prefs: quiet })], 'cue')).toBe('sent');
    // No zone, no clock to read them on.
    expect(why([row({ timezone: null, prefs: quiet })], 'cue')).toBe('sent');
    expect(why([row({ timezone: 'Not/AZone', prefs: quiet })], 'cue')).toBe('sent');
  });

  it('reads a malformed prefs blob as no prefs at all', () => {
    expect(prefsOf({ kinds: 'nope' })).toEqual({});
    expect(prefsOf(null)).toEqual({});
    expect(why([row({ prefs: { kinds: 'nope', muted: true } })], 'cue')).toBe('sent');
  });
});

describe('inQuietHours', () => {
  it.each([
    ['22:00', '07:00', '23:30', true],
    ['22:00', '07:00', '06:59', true],
    ['22:00', '07:00', '07:00', false],
    ['13:00', '14:00', '13:30', true],
    ['13:00', '14:00', '14:00', false],
    ['09:00', '09:00', '09:00', false],
  ])('%s–%s at %s → %s', (start, end, at, expected) => {
    const [h, m] = at.split(':').map(Number);
    expect(inQuietHours(h * 60 + m, { start, end })).toBe(expected);
  });
});

describe('isStale', () => {
  it('uses each transport’s limit, and calls an unreadable stamp stale', () => {
    for (const [transport, days] of Object.entries(STALE_DAYS)) {
      const at = (d: number) => new Date(NOW - d * DAY).toISOString();
      expect(isStale({ transport: transport as DeviceRow['transport'], last_seen_at: at(days - 1) }, NOW)).toBe(false);
      expect(isStale({ transport: transport as DeviceRow['transport'], last_seen_at: at(days + 1) }, NOW)).toBe(true);
    }
    expect(isStale({ transport: 'webpush', last_seen_at: 'never' }, NOW)).toBe(true);
  });
});
