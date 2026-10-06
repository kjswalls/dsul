import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The push channel's own transport. Only the push describes below reach it:
// everywhere else VAPID is unset, so push answers before it would send.
const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: () => {},
  },
}));

import { assertSafeUrl, isBlockedHost, requireString } from '@/lib/reminders/channels/http';
import { escapeXml } from '@/lib/reminders/channels/twilio';
import { callTwiml, callChannel } from '@/lib/reminders/channels/call';
import { dayTopic, pushChannel } from '@/lib/reminders/channels/push';
import { smsChannel } from '@/lib/reminders/channels/sms';
import { voiceChannel } from '@/lib/reminders/channels/voice';
import { channelIsOn, CHANNELS, deliverNudge } from '@/lib/reminders/deliver';
import { spokenLine, smsLine } from '@/lib/reminders/copy';
import { channelKinds, REMINDER_KINDS, type Nudge } from '@/lib/reminders/nudge';
import type { ChannelContext } from '@/lib/reminders/channels/types';
import { makeServiceFake } from './support/service-fake';

/**
 * The tick these nudges were built at: 07:35 in New York. Only the push
 * describes that read a TTL set the clock to it; a nudge's expiry is an
 * instant, and the TTL is what is left of it when the request leaves.
 */
const TICK = Date.parse('2026-08-10T11:35:00Z');

const cue = (over: Partial<Nudge> = {}): Nudge => ({
  kind: 'cue',
  title: 'Vitamins',
  body: 'you pour your coffee',
  url: '/item/h1',
  dateStr: '2026-08-10',
  itemId: 'h1',
  items: [{ id: 'h1', title: 'Vitamins', streak: 12 }],
  expiresAtMs: TICK + 1800_000,
  ...over,
});

const lastCall = (over: Partial<Nudge> = {}): Nudge => ({
  kind: 'last-call',
  title: '2 still open',
  body: 'Reading and Stretch · 12 days riding on it',
  url: '/',
  dateStr: '2026-08-10',
  items: [
    { id: 'a', title: 'Reading', streak: 12 },
    { id: 'b', title: 'Stretch', streak: 0 },
  ],
  expiresAtMs: TICK + 1800_000,
  ...over,
});

/** The end-of-day review's invitation, as the scan words it. */
const eod = (over: Partial<Nudge> = {}): Nudge => ({
  kind: 'eod',
  title: 'End of day 🌙',
  body: "How'd today go?",
  url: '/?eod=1',
  dateStr: '2026-08-10',
  items: [],
  expiresAtMs: TICK + 10500_000,
  ...over,
});

const ctx = (over: Partial<ChannelContext> = {}): ChannelContext => ({
  userId: 'u1',
  service: {} as never,
  timeFormat: '12h',
  timezone: 'America/New_York',
  config: {},
  secrets: {},
  ...over,
});

/* ── assertSafeUrl ────────────────────────────────────────────────────────── */

describe('assertSafeUrl', () => {
  it('accepts an ordinary https host', () => {
    expect(assertSafeUrl('https://home.example.com').hostname).toBe('home.example.com');
  });

  // Private LAN ranges stay allowed on purpose: Home Assistant lives on them,
  // a serverless function cannot reach them anyway, and blocking them would
  // break the honest self-hosted case for no gain.
  it('allows private LAN addresses', () => {
    expect(() => assertSafeUrl('http://192.168.1.40:8123')).not.toThrow();
    expect(() => assertSafeUrl('http://10.0.0.5:8123')).not.toThrow();
  });

  // The actual escalation this guard exists for: making dsul's own server
  // issue requests from inside the hosting provider's network.
  it('refuses loopback and link-local, where the metadata services answer', () => {
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => assertSafeUrl('http://127.0.0.1:8123')).toThrow();
    expect(() => assertSafeUrl('http://localhost:8123')).toThrow();
    expect(() => assertSafeUrl('http://[::1]:8123')).toThrow();
    expect(() => assertSafeUrl('http://0.0.0.0/')).toThrow();
  });

  it('refuses a non-http scheme', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrl('gopher://example.com')).toThrow();
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com')).toThrow(/credentials/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertSafeUrl('home.example.com')).toThrow();
  });

  // A guard that only matches the obvious spelling is a guard that looks
  // present and is not: [::ffff:169.254.169.254] is the same metadata endpoint
  // the dotted-quad check refuses.
  it('refuses loopback and link-local in their IPv6 spellings too', () => {
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
    // The form that actually arrives: the URL parser canonicalises a mapped
    // address to hex, so the dotted check alone never sees it.
    expect(isBlockedHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true);
    expect(isBlockedHost('::')).toBe(true);
    expect(isBlockedHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(() => assertSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow();
  });

  it('still lets ordinary hosts through', () => {
    expect(isBlockedHost('home.example.com')).toBe(false);
    expect(isBlockedHost('192.168.1.40')).toBe(false);
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
  });
});

describe('requireString', () => {
  it('treats blank and non-strings as absent', () => {
    expect(requireString({ a: '  x  ' }, 'a')).toBe('x');
    expect(requireString({ a: '   ' }, 'a')).toBeNull();
    expect(requireString({ a: 5 }, 'a')).toBeNull();
    expect(requireString({}, 'a')).toBeNull();
  });
});

/* ── TwiML ────────────────────────────────────────────────────────────────── */

describe('TwiML escaping', () => {
  it('escapes every XML metacharacter', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
  });

  // The spoken text is an item TITLE, which is free user input. A habit called
  // `Read <b>more</b>` must not produce malformed XML and a failed call.
  it('survives a habit title full of markup', () => {
    const nudge = cue({ title: 'Read <b>more</b> & "relax"', items: [{ id: 'h1', title: 'Read <b>more</b> & "relax"', streak: 0 }] });
    const xml = callTwiml(nudge, 'alice');
    expect(xml).not.toMatch(/<b>/);
    expect(xml).toContain('&lt;b&gt;');
    expect(xml).toContain('&amp;');
    // Still exactly the document we meant to emit.
    expect(xml.match(/<Say /g)).toHaveLength(2);
  });

  it('escapes the voice attribute too', () => {
    expect(callTwiml(cue(), 'a"lice')).toContain('voice="a&quot;lice"');
  });

  // Someone who answers a phone has usually missed the first second of it.
  it('says the line twice with a pause', () => {
    const xml = callTwiml(cue(), 'alice');
    expect(xml.match(/Vitamins/g)).toHaveLength(2);
    expect(xml).toContain('<Pause length="1"/>');
  });
});

/* ── Registers ────────────────────────────────────────────────────────────── */

describe('spokenLine', () => {
  it('leads with the item and drops the interpunct', () => {
    const line = spokenLine(cue());
    expect(line).toBe('Vitamins. After you pour your coffee. 12 days so far.');
    expect(line).not.toContain('·');
  });

  // The notification body already carries the streak after an interpunct;
  // reusing it verbatim said the streak twice and read the separator aloud.
  it('states the streak once, however the body was worded', () => {
    const line = spokenLine(cue({ body: 'you pour your coffee · 12 days' }));
    expect(line).toBe('Vitamins. After you pour your coffee. 12 days so far.');
    expect(line.match(/12 days/g)).toHaveLength(1);
    expect(line).not.toContain('·');
  });

  // "After 7:30 am" is not a sentence anyone says.
  it('does not say "After" in front of a time', () => {
    expect(spokenLine(cue({ body: '7:30 am' }))).toBe('Vitamins. 12 days so far.');
  });

  it('reads a last call as a list', () => {
    expect(spokenLine(lastCall())).toBe('Still open today: Reading and Stretch. 12 days on the line.');
  });
});

describe('smsLine', () => {
  it('is one line', () => {
    expect(smsLine(cue())).toBe('Vitamins: you pour your coffee');
    expect(smsLine(cue())).not.toContain('\n');
  });

  // A shortened-looking URL in an unexpected text is the shape of a phishing
  // message; training yourself to tap those is a bad habit to install.
  it('carries no link', () => {
    expect(smsLine(cue())).not.toMatch(/https?:/);
  });
});

/* ── Channel gating ───────────────────────────────────────────────────────── */

describe('channel gating', () => {
  it('every gated channel uses its extension slug as its own slug', () => {
    for (const channel of CHANNELS) {
      if (channel.extensionSlug === null) continue;
      expect(channel.slug, channel.slug).toBe(channel.extensionSlug);
    }
  });

  it('push is on without any extension; the rest are off until switched on', () => {
    const push = CHANNELS.find((c) => c.slug === 'push')!;
    expect(channelIsOn(push, {})).toBe(true);
    for (const channel of CHANNELS.filter((c) => c.extensionSlug)) {
      expect(channelIsOn(channel, {}), channel.slug).toBe(false);
      expect(channelIsOn(channel, { [channel.slug]: true }), channel.slug).toBe(true);
    }
  });
});

describe('channels decline rather than fail when unconfigured', () => {
  it('voice skips with no URL, token or speakers', async () => {
    const result = await voiceChannel.deliver(cue(), ctx());
    expect(result).toMatchObject({ ok: true, skipped: true });
  });

  it('sms skips without credentials', async () => {
    const result = await smsChannel.deliver(cue(), ctx({ config: { to: '+1', from: '+2' } }));
    expect(result).toMatchObject({ ok: true, skipped: true });
  });

  it('call skips without credentials', async () => {
    const result = await callChannel.deliver(lastCall(), ctx({ config: { to: '+1', from: '+2' } }));
    expect(result).toMatchObject({ ok: true, skipped: true });
  });
});

describe('the call channel declines ordinary cues by default', () => {
  const configured = ctx({
    config: { to: '+15551234567', from: '+15557654321' },
    secrets: { accountSid: 'AC1', authToken: 'tok' },
  });

  it('refuses a cue when kinds is unset', async () => {
    const result = await callChannel.deliver(cue(), configured);
    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(result.detail).toMatch(/declines cue/);
  });

  // Every blank form is the default, read the way voice and SMS read theirs.
  // An empty array used to be the one exception here: a list of nothing, so
  // the call declined even the last call.
  it.each([[''], ['  '], [[]]])('reads kinds %j as unset: no cue, and the last call', async (kinds) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const blank = ctx({ ...configured, config: { ...configured.config, kinds } });
    expect(await callChannel.deliver(cue(), blank)).toMatchObject({ ok: true, skipped: true, detail: 'call declines cue' });
    expect((await callChannel.deliver(lastCall(), blank)).skipped).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('takes the last call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callChannel.deliver(lastCall(), configured);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('will call for a cue if the user explicitly asks for it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callChannel.deliver(
      cue(),
      ctx({ ...configured, config: { ...configured.config, kinds: 'cue, last-call' } }),
    );
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});

/* ── The EOD review is push only ──────────────────────────────────────────── */

// Decision 12. A blank `kinds` on voice and SMS used to mean "every kind",
// which was harmless with two kinds and a trap with three: widening NudgeKind
// would have read "How'd today go?" aloud in every kitchen and texted it to
// every SMS user. Blank now means REMINDER_KINDS, the cue and the last call,
// and a list the user typed can narrow that and never add to it.
describe('the EOD review is push only', () => {
  const twilio = { to: '+15551234567', from: '+15557654321' };
  const twilioSecrets = { accountSid: 'AC1', authToken: 'tok' };
  const speakers = { baseUrl: 'https://home.example.com', players: 'media_player.kitchen' };

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('REMINDER_KINDS is the cue and the last call, and nothing else', () => {
    expect(REMINDER_KINDS).toEqual(['cue', 'last-call']);
  });

  // Configured in full, so the decline is the kind's and not "not configured".
  it.each([[undefined], [''], ['  '], [[]]])('voice with kinds %j declines it, and still speaks the reminders', async (kinds) => {
    const configured = ctx({ config: { ...speakers, kinds }, secrets: { token: 'tok' } });

    const result = await voiceChannel.deliver(eod(), configured);
    expect(result).toEqual({ ok: true, skipped: true, detail: 'voice declines eod' });
    expect(fetchMock).not.toHaveBeenCalled();

    // The default is the reminders, named: not nothing.
    expect(await voiceChannel.deliver(cue(), configured)).toMatchObject({ ok: true });
    expect((await voiceChannel.deliver(lastCall(), configured)).skipped).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[undefined], [''], ['  '], [[]]])('sms with kinds %j declines it, and still texts the reminders', async (kinds) => {
    const configured = ctx({ config: { ...twilio, kinds }, secrets: twilioSecrets });

    const result = await smsChannel.deliver(eod(), configured);
    expect(result).toEqual({ ok: true, skipped: true, detail: 'sms declines eod' });
    expect(fetchMock).not.toHaveBeenCalled();

    expect((await smsChannel.deliver(cue(), configured)).skipped).toBeFalsy();
    expect((await smsChannel.deliver(lastCall(), configured)).skipped).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the call declines it too: its default is the last call alone', async () => {
    const result = await callChannel.deliver(eod(), ctx({ config: twilio, secrets: twilioSecrets }));
    expect(result).toMatchObject({ ok: true, skipped: true, detail: 'call declines eod' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Every outward channel switched on and configured, none told which kinds:
  // the fan-out hands the review to push and to nothing else.
  it('through deliverNudge, only push takes it', async () => {
    const reports = await deliverNudge(
      eod(),
      { userId: 'u1', service: makeServiceFake().service, timeFormat: '12h', timezone: 'UTC' },
      {
        extensionEnabled: { 'voice-announcements': true, 'sms-nudge': true, 'phone-call': true },
        configs: { 'voice-announcements': speakers, 'sms-nudge': twilio, 'phone-call': twilio },
        secrets: { 'voice-announcements': { token: 'tok' }, 'sms-nudge': twilioSecrets, 'phone-call': twilioSecrets },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reports.filter((r) => r.channel !== 'push')).toEqual([
      expect.objectContaining({ channel: 'voice-announcements', skipped: true, detail: 'voice declines eod' }),
      expect.objectContaining({ channel: 'sms-nudge', skipped: true, detail: 'sms declines eod' }),
      expect.objectContaining({ channel: 'phone-call', skipped: true, detail: 'call declines eod' }),
    ]);
    expect(reports.find((r) => r.channel === 'push')?.skipped).toBe(false);
  });

  // The kinds fields are free text, so "eod" is one word away. Listed, it used
  // to opt the channel in: spokenLine has no branch for the review, so a
  // kitchen speaker said "End of day 🌙. After How'd today go?." and a call
  // said it twice. A list narrows REMINDER_KINDS and never widens it.
  describe("listing 'eod' does not opt a channel in", () => {
    const LISTED = [['cue, last-call, eod'], [['cue', 'last-call', 'eod']]] as const;

    it('channelKinds narrows a list to the reminders, and falls back only when nothing is listed', () => {
      expect(channelKinds(['cue', 'last-call', 'eod'])).toEqual(['cue', 'last-call']);
      expect(channelKinds(['eod'])).toEqual([]);
      expect(channelKinds(['last-call'])).toEqual(['last-call']);
      expect(channelKinds([])).toEqual(REMINDER_KINDS);
      expect(channelKinds([], ['last-call'])).toEqual(['last-call']);
      expect(channelKinds(['eod'], ['last-call'])).toEqual([]);
    });

    it.each(LISTED)('voice with kinds %j declines it, and still speaks what else was listed', async (kinds) => {
      const configured = ctx({ config: { ...speakers, kinds }, secrets: { token: 'tok' } });

      expect(await voiceChannel.deliver(eod(), configured)).toEqual({ ok: true, skipped: true, detail: 'voice declines eod' });
      expect(fetchMock).not.toHaveBeenCalled();

      expect((await voiceChannel.deliver(cue(), configured)).skipped).toBeFalsy();
      expect((await voiceChannel.deliver(lastCall(), configured)).skipped).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(LISTED)('sms with kinds %j declines it, and still texts what else was listed', async (kinds) => {
      const configured = ctx({ config: { ...twilio, kinds }, secrets: twilioSecrets });

      expect(await smsChannel.deliver(eod(), configured)).toEqual({ ok: true, skipped: true, detail: 'sms declines eod' });
      expect(fetchMock).not.toHaveBeenCalled();

      expect((await smsChannel.deliver(cue(), configured)).skipped).toBeFalsy();
      expect((await smsChannel.deliver(lastCall(), configured)).skipped).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(LISTED)('the call with kinds %j declines it, and still rings for what else was listed', async (kinds) => {
      const configured = ctx({ config: { ...twilio, kinds }, secrets: twilioSecrets });

      expect(await callChannel.deliver(eod(), configured)).toEqual({ ok: true, skipped: true, detail: 'call declines eod' });
      expect(fetchMock).not.toHaveBeenCalled();

      expect((await callChannel.deliver(cue(), configured)).skipped).toBeFalsy();
      expect((await callChannel.deliver(lastCall(), configured)).skipped).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // "eod" alone is a list with nothing the channel speaks in it: quiet, not
    // the default, which is what any other word it does not know gets too.
    it.each([
      ['voice', () => voiceChannel.deliver(cue(), ctx({ config: { ...speakers, kinds: 'eod' }, secrets: { token: 'tok' } }))],
      ['sms', () => smsChannel.deliver(cue(), ctx({ config: { ...twilio, kinds: 'eod' }, secrets: twilioSecrets }))],
      ['call', () => callChannel.deliver(lastCall(), ctx({ config: { ...twilio, kinds: 'eod' }, secrets: twilioSecrets }))],
    ])("%s with kinds 'eod' alone takes nothing", async (_, send) => {
      expect(await send()).toMatchObject({ ok: true, skipped: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('through deliverNudge, only push takes it', async () => {
      const reports = await deliverNudge(
        eod(),
        { userId: 'u1', service: makeServiceFake().service, timeFormat: '12h', timezone: 'UTC' },
        {
          extensionEnabled: { 'voice-announcements': true, 'sms-nudge': true, 'phone-call': true },
          configs: {
            'voice-announcements': { ...speakers, kinds: 'cue, last-call, eod' },
            'sms-nudge': { ...twilio, kinds: 'cue, last-call, eod' },
            'phone-call': { ...twilio, kinds: 'cue, last-call, eod' },
          },
          secrets: { 'voice-announcements': { token: 'tok' }, 'sms-nudge': twilioSecrets, 'phone-call': twilioSecrets },
        },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(reports.filter((r) => r.channel !== 'push').map((r) => r.detail)).toEqual([
        'voice declines eod',
        'sms declines eod',
        'call declines eod',
      ]);
    });
  });
});

/* ── Push ─────────────────────────────────────────────────────────────────── */

describe('the push channel says what became of the push', () => {
  const subscription = (n: number) => ({ endpoint: `https://push.example/${n}`, p256dh: 'p', auth: 'a' });
  const withRows = (rows: unknown[]) =>
    ctx({ service: makeServiceFake({ 'push_subscriptions.select': { data: rows } }).service });

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private');
    sendNotification.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  // "sent=0" with ok:true used to be the whole report, and nobody read it.
  it('no device: ok, but unreached', async () => {
    const result = await pushChannel.deliver(cue(), withRows([]));
    expect(result).toMatchObject({ ok: true, unreached: true });
    expect(result.detail).toMatch(/no device subscribed/);
  });

  it('no VAPID pair: unreached too, and it says which', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const result = await pushChannel.deliver(cue(), withRows([subscription(1)]));
    expect(result).toMatchObject({ ok: true, unreached: true });
    expect(result.detail).toMatch(/no VAPID pair/);
  });

  it('every device refused it: a failure, counted', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 503 }));
    const result = await pushChannel.deliver(cue(), withRows([subscription(1), subscription(2)]));
    expect(result.ok).toBe(false);
    expect(result.unreached).toBeFalsy();
    expect(result.detail).toMatch(/^push failed: 0 of 2 accepted/);
  });

  it('one device took it: a delivery', async () => {
    sendNotification
      .mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    const result = await pushChannel.deliver(cue(), withRows([subscription(1), subscription(2)]));
    expect(result.ok).toBe(true);
    expect(result.unreached).toBeFalsy();
    expect(result.detail).toBe('push sent=1/2 expired=1 failed=0');
  });

  // The channel contract (channels/types.ts): a failure is a result. And a
  // read nobody answered is a failure, not "this user has no phone".
  it('service read rejects ⇒ a failed result, not a rejection', async () => {
    const { service } = makeServiceFake(() => {
      throw new Error('fetch failed');
    });
    const outcome = pushChannel.deliver(cue(), ctx({ service }));
    await expect(outcome).resolves.toMatchObject({ ok: false });
    const result = await outcome;
    expect(result.unreached).toBeFalsy();
    expect(result.detail).toMatch(/read failed: fetch failed/);
  });

  it('deliverNudge carries unreached into its report', async () => {
    const { service } = makeServiceFake({ 'push_subscriptions.select': { data: [] } });
    const reports = await deliverNudge(
      cue(),
      { userId: 'u1', service, timeFormat: '12h', timezone: 'UTC' },
      { extensionEnabled: {}, configs: {}, secrets: {} },
    );
    expect(reports).toEqual([
      expect.objectContaining({ channel: 'push', ok: true, skipped: false, unreached: true }),
    ]);
  });
});

describe('the push channel says how long a push may wait, and how hard to wake for it', () => {
  /** RFC 8030 §5.4: 1 to 32 characters of the URL-safe base64 alphabet. */
  const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
  /** A real item id: items.id is a uuid (migration 019). */
  const UUID = '6f1c2b0e-8d4a-4c3e-9b7a-2f5d1e0c9a8b';

  const oneDevice = () =>
    ctx({
      service: makeServiceFake({
        'push_subscriptions.select': { data: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }] },
      }).service,
    });

  /** What web-push was handed for the one push sent: the body it encrypted, and the options. */
  const sentAs = () => {
    const [, body, options] = sendNotification.mock.calls[0];
    return { body: JSON.parse(body as string) as Record<string, unknown>, options };
  };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private');
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TICK);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // No topic on a cue. If FCM reads a topic as a collapse key, it holds four
  // per device: a topic per item, and a morning of six cues to a phone out of
  // signal loses two, every send still a 201. The tag collapses a cue and its
  // snooze in the shade instead.
  it('a cue: TTL from the nudge, high urgency, and no topic', async () => {
    await pushChannel.deliver(cue({ itemId: UUID, expiresAtMs: TICK + 1800_000 }), oneDevice());

    const { options, body } = sentAs();
    expect(options).toEqual({ TTL: 1800, urgency: 'high' });
    // Headers, not notification: the service worker never sees them.
    expect(body).not.toHaveProperty('ttl');
    expect(body).not.toHaveProperty('urgency');
    expect(body).not.toHaveProperty('topic');
    expect(body).toMatchObject({ title: 'Vitamins', tag: `dsul-item-${UUID}` });
  });

  it('a last call: high urgency, and its DAY as the topic, even when it names one habit', async () => {
    await pushChannel.deliver(lastCall({ itemId: 'a', expiresAtMs: TICK + 600_000 }), oneDevice());
    expect(sentAs().options).toEqual({ TTL: 600, urgency: 'high', topic: 'lc-20260810' });
  });

  // An invitation that keeps until midnight, not an alarm: 'normal', so a push
  // service may hold it for the phone's own next wake. Collapsed on its day,
  // under the tag its old route sent, and with nothing to tick on it.
  it('the EOD review: normal urgency, its DAY as the topic, and no buttons', async () => {
    await pushChannel.deliver(eod({ expiresAtMs: TICK + 10500_000 }), oneDevice());

    const { options, body } = sentAs();
    expect(options).toEqual({ TTL: 10500, urgency: 'normal', topic: 'eod-20260810' });
    expect(body).toMatchObject({
      title: 'End of day 🌙',
      body: "How'd today go?",
      url: '/?eod=1',
      tag: 'dsul-eod-2026-08-10',
      data: { url: '/?eod=1', dateStr: '2026-08-10', kind: 'eod' },
    });
    expect(body).not.toHaveProperty('actions');
  });

  // The expiry is an instant, so the TTL is what is left of it when the push
  // leaves, not what was left when the tick began. A review claimed on the
  // 23:55 tick and sent ten seconds later, a few users down the list, stops at
  // midnight; worked out at 23:55:00, it would have been held until 00:00:10.
  it('the TTL is what is left of the nudge when it is sent, not when the tick began', async () => {
    const MIDNIGHT = Date.parse('2026-08-11T04:00:00Z');
    vi.setSystemTime(MIDNIGHT - 290_000);
    await pushChannel.deliver(eod({ dateStr: '2026-08-10', expiresAtMs: MIDNIGHT }), oneDevice());
    expect(sentAs().options).toMatchObject({ TTL: 290 });
    expect(sentAs().body).not.toHaveProperty('expiresAtMs');
  });

  // A matured snooze is a cue like any other, and travels the same way.
  it('a matured snooze: no topic either, and the tag its cue had', async () => {
    await pushChannel.deliver(cue({ itemId: UUID, snoozed: true, expiresAtMs: TICK + 1800_000 }), oneDevice());

    const { options, body } = sentAs();
    expect(options).not.toHaveProperty('topic');
    expect(body).toMatchObject({ tag: `dsul-item-${UUID}` });
  });

  // One topic per kind per day, so however many habits a user sets, a phone
  // that is off holds a handful of them at most.
  it('names day topics that fit, one per kind', () => {
    for (const prefix of ['lc', 'eod', 'pl'] as const) {
      expect(dayTopic(prefix, '2026-08-10')).toMatch(TOPIC);
      expect(dayTopic(prefix, '2026-08-10')).toBe(`${prefix}-20260810`);
    }
  });
});

/* ── Isolation ────────────────────────────────────────────────────────────── */

describe('deliverNudge isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The contract: one integration whose token expired last week must never be
  // able to stop the push notification that has worked every day.
  it('a channel that throws does not take the others down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS exploded'); }));

    const reports = await deliverNudge(
      lastCall(),
      { userId: 'u1', service: {} as never, timeFormat: '12h', timezone: 'UTC' },
      {
        extensionEnabled: { 'voice-announcements': true, 'phone-call': true },
        configs: {
          'voice-announcements': { baseUrl: 'https://home.example.com', players: 'media_player.kitchen' },
          'phone-call': { to: '+1', from: '+2' },
        },
        secrets: {
          'voice-announcements': { token: 'tok' },
          'phone-call': { accountSid: 'AC1', authToken: 'tok' },
        },
      },
    );

    const voice = reports.find((r) => r.channel === 'voice-announcements');
    const call = reports.find((r) => r.channel === 'phone-call');
    expect(voice?.ok).toBe(false);
    expect(call?.ok).toBe(false);
    // …and crucially, the whole fan-out still resolved with a report per channel
    // rather than rejecting.
    expect(reports.some((r) => r.channel === 'push')).toBe(true);
  });

  it('a disabled channel is never dispatched at all', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const reports = await deliverNudge(
      cue(),
      { userId: 'u1', service: {} as never, timeFormat: '12h', timezone: 'UTC' },
      { extensionEnabled: {}, configs: {}, secrets: {} },
    );

    expect(reports.map((r) => r.channel)).toEqual(['push']);
  });
});

describe('postToChannel refuses to follow a redirect', () => {
  afterEach(() => vi.unstubAllGlobals());

  // assertSafeUrl checks the address the user TYPED. With redirect:'follow'
  // that check is decorative — any user-supplied host can answer 302 and send
  // this fetch to the loopback address the guard exists to refuse.
  it('asks fetch to error rather than follow', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await voiceChannel.deliver(
      cue(),
      ctx({
        config: { baseUrl: 'https://home.example.com', players: 'media_player.kitchen' },
        secrets: { token: 'tok' },
      }),
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('error');
  });
});
