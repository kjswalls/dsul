import { describe, expect, it } from 'vitest';
import { isIosBrowserTab, reminderReach, REACH_COPY, type ReachInput } from '@/lib/reminders/reach';

const here: ReachInput['here'] = { isSupported: true, permissionState: 'default', iosTab: false, desktop: false };
const ask = (over: Partial<ReachInput> = {}, h: Partial<ReachInput['here']> = {}) =>
  reminderReach({ remindersOn: true, devicesWithCue: 0, ...over, here: { ...here, ...h } });

describe('reminderReach', () => {
  it('names the master switch first, whatever the devices say', () => {
    expect(ask({ remindersOn: false, devicesWithCue: 3 })).toBe('reminders_off');
    expect(ask({ remindersOn: false, devicesWithCue: null })).toBe('reminders_off');
  });

  it('says nothing once a device takes cues, or while that is unknown', () => {
    expect(ask({ devicesWithCue: 1 })).toBe('ok');
    expect(ask({ devicesWithCue: null })).toBe('ok');
  });

  it('with no device, picks the fix this browser can offer', () => {
    expect(ask()).toBe('no_device_here');
    expect(ask({}, { iosTab: true, isSupported: false })).toBe('install_first');
    expect(ask({}, { desktop: true })).toBe('no_device_elsewhere');
    expect(ask({}, { isSupported: false })).toBe('no_device_elsewhere');
    expect(ask({}, { permissionState: 'denied' })).toBe('blocked');
  });

  it('has words for every answer but ok, and a button only where one can act', () => {
    expect(REACH_COPY.reminders_off.action).toBeTruthy();
    expect(REACH_COPY.no_device_here.action).toBeTruthy();
    expect(REACH_COPY.install_first.action).toBeUndefined();
    expect(REACH_COPY.blocked.action).toBeUndefined();
    expect(REACH_COPY.no_device_elsewhere.action).toBeUndefined();
  });

  it('copy has no em dashes', () => {
    for (const c of Object.values(REACH_COPY)) expect(c.text + (c.action ?? '')).not.toMatch(/—/);
  });
});

describe('isIosBrowserTab', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';

  it('is an iPhone in a tab, not the Home Screen app', () => {
    expect(isIosBrowserTab(iphone, 5, false)).toBe(true);
    expect(isIosBrowserTab(iphone, 5, true)).toBe(false);
  });

  it('counts an iPad asking for the desktop site, but not a Mac', () => {
    expect(isIosBrowserTab(mac, 5, false)).toBe(true);
    expect(isIosBrowserTab(mac, 0, false)).toBe(false);
  });

  it('is never Android', () => {
    expect(isIosBrowserTab(android, 5, false)).toBe(false);
  });
});
