/**
 * How OpenClaw's device list names a paired browser
 * (lib/openclaw-browser/device-name.ts): browser and OS from the user agent,
 * so two paired browsers can be told apart.
 */
import { describe, expect, it } from 'vitest';
import { browserDeviceName } from '@/lib/openclaw-browser/device-name';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  chromeIpad:
    'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  desktopApp:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) dsul/1.4.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
};

describe('browserDeviceName', () => {
  it.each([
    ['chromeMac', 'dsul · Chrome on macOS'],
    ['safariMac', 'dsul · Safari on macOS'],
    ['safariIphone', 'dsul · Safari on iPhone'],
    ['chromeIpad', 'dsul · Chrome on iPad'],
    ['edgeWindows', 'dsul · Edge on Windows'],
    ['firefoxLinux', 'dsul · Firefox on Linux'],
    ['chromeAndroid', 'dsul · Chrome on Android'],
    ['operaWindows', 'dsul · Opera on Windows'],
    ['chromebook', 'dsul · Chrome on ChromeOS'],
    ['desktopApp', 'dsul · desktop app on macOS'],
  ] as const)('%s → %s', (ua, name) => {
    expect(browserDeviceName(UA[ua])).toBe(name);
  });

  it('falls back to plain "dsul" with nothing to go on', () => {
    expect(browserDeviceName(undefined)).toBe('dsul');
    expect(browserDeviceName('')).toBe('dsul');
    expect(browserDeviceName('curl/8.0')).toBe('dsul');
  });
});
