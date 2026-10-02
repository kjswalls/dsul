import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/auth/ios/route';

/**
 * /auth/ios — where the iPhone's Google sign-in and emailed link come back
 * from Supabase and are handed to the app at app.dsul.ios://auth/callback.
 *
 * A well-formed code in the query is a 302 straight to the scheme, the case
 * ASWebAuthenticationSession is built to catch. Everything else, an emailed
 * link (`via=email`) included, is one constant page, /auth/desktop's pattern,
 * whose script forwards what only the browser can see (an error in the hash,
 * the email link's nonce). Neither path ever forwards a token or
 * `error_description`.
 */

const at = (suffix: string) => GET(new Request(`https://do.dsul.app/auth/ios${suffix}`));

/** A nonce the app would send (`EmailSignIn.makeNonce`): 22 base64url characters. */
const NONCE = 'AbCdEf-hIjKlMnOp_rStUv';

const scriptOf = (html: string) => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no inline script');
  return match[1];
};

/**
 * Runs the page's inline script against a URL, the way a browser would.
 * `location`, `history` and `document` are passed in by name so nothing
 * touches jsdom's own window, and the page's markup is parsed into a detached
 * document so the script finds the elements it toggles.
 */
async function handOff(search: string, hash = '') {
  const html = await at('').text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const location = { search, hash, pathname: '/auth/ios', replace: vi.fn() };
  const history = { replaceState: vi.fn() };
  new Function('location', 'history', 'document', scriptOf(html))(location, history, doc);
  return { doc, location, history };
}

const expectPrivate = (res: Response) => {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-robots-tag')).toBe('noindex');
};

describe('/auth/ios redirects', () => {
  it('sends a well-formed code straight to the app', async () => {
    const res = at('?code=abcDEF-123_4.5~6');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('app.dsul.ios://auth/callback?code=abcDEF-123_4.5~6');
    expectPrivate(res);
    expect(await res.text()).toBe('');
  });

  it('forwards only the code, whatever else the query carries', () => {
    const res = at('?code=abcdef123456&error_description=hello&access_token=tok&refresh_token=ref&next=%2F%2Fevil.com');
    expect(res.headers.get('location')).toBe('app.dsul.ios://auth/callback?code=abcdef123456');
  });

  it('forwards an error as its code alone, preferring error_code', () => {
    const both = at('?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid');
    expect(both.status).toBe(302);
    expect(both.headers.get('location')).toBe('app.dsul.ios://auth/callback?error_code=otp_expired');

    const errorOnly = at('?error=access_denied&error_description=The+user+denied');
    expect(errorOnly.headers.get('location')).toBe('app.dsul.ios://auth/callback?error_code=access_denied');

    // An HTTP status in error_code is not a code; the error name behind it is.
    const status = at('?error=unauthorized_client&error_code=401');
    expect(status.headers.get('location')).toBe('app.dsul.ios://auth/callback?error_code=unauthorized_client');
  });

  it('prefers a code over an error, as the page script does', () => {
    expect(at('?error=access_denied&code=abcdef123456').headers.get('location')).toBe(
      'app.dsul.ios://auth/callback?code=abcdef123456',
    );
  });

  it('never puts a description or a token in a Location', () => {
    for (const suffix of [
      '?code=abcdef123456&error_description=hello&access_token=tok',
      '?error=access_denied&error_description=hello&refresh_token=ref',
      '?error_description=hello&access_token=tok',
    ]) {
      const location = at(suffix).headers.get('location') ?? '';
      expect(location).not.toMatch(/error_description|access_token|refresh_token|hello|tok|ref/);
    }
  });
});

describe('/auth/ios page', () => {
  it('serves the bounce page with every header the plan asks for', () => {
    const res = at('');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expectPrivate(res);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('allows exactly the script it serves, and nothing inline beyond it', async () => {
    const res = at('');
    const html = await res.text();
    const hash = createHash('sha256').update(scriptOf(html), 'utf8').digest('base64');
    const directives = res.headers.get('content-security-policy')!.split('; ');
    expect(directives.filter((d) => d.startsWith('script-src'))).toEqual([`script-src 'sha256-${hash}'`]);
    expect(html.match(/<script/g)).toHaveLength(1);
    // CSP blocks inline handlers, so the retry button has to be wired by the script.
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('serves the same bytes for everything that is not a redirect', async () => {
    const bodies = await Promise.all(
      [
        '',
        '?code=abc',
        '?code=%22%3E%3Cimg%20src%3Dx%3E',
        '?error=Access_Denied',
        '?error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
        '?access_token=secret&refresh_token=secret',
        '#access_token=secret&refresh_token=secret',
        '#error=access_denied&error_description=hello',
        '#code=abcdef123456',
        `?via=email&n=${NONCE}&code=abcdef123456`,
        `?via=email&n=${NONCE}&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`,
        '?via=email&code=abcdef123456',
      ].map((suffix) => {
        const res = at(suffix);
        expect(res.status, suffix).toBe(200);
        return res.text();
      }),
    );
    for (const body of bodies) expect(body).toBe(bodies[0]);
    expect(bodies[0]).not.toMatch(/secret|abcdef123456|alert/);
  });

  it('is the phone’s page, not the desktop’s', async () => {
    const html = await at('').text();
    expect(html).toContain('app.dsul.ios://auth/callback');
    expect(html).not.toContain('dsul://auth/callback?');
    expect(html).not.toMatch(/computer/i);
  });

  it('hands an error in the hash to the app and clears the address bar', async () => {
    const { location, history } = await handOff('', '#error=access_denied&error_description=The+user+denied');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/auth/ios');
    expect(location.replace).toHaveBeenCalledExactlyOnceWith('app.dsul.ios://auth/callback?error_code=access_denied');
    expect(history.replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      location.replace.mock.invocationCallOrder[0],
    );
  });

  it('retries the hand-off from the Open dsul button', async () => {
    const { doc, location } = await handOff('', '#code=abcdef123456');
    (doc.getElementById('open') as HTMLButtonElement).click();
    expect(location.replace).toHaveBeenCalledTimes(2);
    expect(location.replace).toHaveBeenLastCalledWith('app.dsul.ios://auth/callback?code=abcdef123456');
  });

  it('never forwards a description or a token from the hash', async () => {
    const runs = await Promise.all([
      handOff('', '#access_token=tok&refresh_token=ref&error_description=hello'),
      handOff('?error_description=hello'),
    ]);
    for (const { location } of runs) expect(location.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', '?code=abc'],
    ['markup', '?code=%22%3E%3Cimg%20src%3Dx%3E'],
    ['a second scheme', '?code=abcdef12%26next%3Djavascript%3Aalert(1)'],
    ['a capitalised error', '?error=Access_Denied'],
  ])('drops a malformed value (%s) and says there is nothing to open', async (_, search) => {
    // The server answers these with the page too, so the script is what runs.
    expect(at(search).status).toBe(200);
    const { doc, location, history } = await handOff(search);
    expect(location.replace).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/auth/ios');
    expect(doc.getElementById('opening')!.hidden).toBe(true);
    expect(doc.getElementById('done')!.hidden).toBe(false);
  });

  it('agrees with the server on what is forwardable', async () => {
    // The script's shapes are spelled again inside a string; any value the
    // server would redirect, the script forwards to the same URL.
    for (const search of [
      '?code=abcDEF-123_4.5~6',
      '?code=' + 'a'.repeat(256),
      '?error_code=otp_expired',
      '?error=access_denied',
      '?error=unauthorized_client&error_code=401',
    ]) {
      const server = at(search).headers.get('location');
      const { location } = await handOff(search);
      expect(location.replace, search).toHaveBeenCalledExactlyOnceWith(server);
    }
    // And the edge the server refuses, the script refuses too.
    expect(at('?code=' + 'a'.repeat(257)).status).toBe(200);
    expect((await handOff('?code=' + 'a'.repeat(257))).location.replace).not.toHaveBeenCalled();
  });
});

describe('/auth/ios for an emailed link', () => {
  it('always serves the page, never the redirect Google gets', () => {
    for (const suffix of [
      `?via=email&n=${NONCE}&code=abcdef123456`,
      `?via=email&n=${NONCE}&error=access_denied&error_code=otp_expired`,
    ]) {
      const res = at(suffix);
      expect(res.status, suffix).toBe(200);
      expect(res.headers.get('location'), suffix).toBeNull();
      expectPrivate(res);
    }
    // Google's code, with no `via`, still goes straight to the app.
    expect(at('?code=abcdef123456').status).toBe(302);
    expect(at('?via=google&code=abcdef123456').status).toBe(302);
  });

  it('hands the code to the app with the nonce, and keeps both in the fragment', async () => {
    const { doc, location, history } = await handOff(`?via=email&n=${NONCE}&code=abcdef123456`);
    expect(location.replace).toHaveBeenCalledExactlyOnceWith(
      `app.dsul.ios://auth/callback?code=abcdef123456&n=${NONCE}`,
    );
    // Out of the query (history, a server, a Referer), but still there for
    // "Open in Safari" from another app's browser.
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      `/auth/ios#via=email&n=${NONCE}&code=abcdef123456`,
    );
    expect(history.replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      location.replace.mock.invocationCallOrder[0],
    );
    expect(doc.getElementById('email-help')!.hidden).toBe(false);
    expect(doc.getElementById('opening')!.hidden).toBe(false);
  });

  it('opens the same way again from the fragment it left', async () => {
    const first = await handOff(`?via=email&n=${NONCE}&code=abcdef123456`);
    const fragment = (first.history.replaceState.mock.calls[0][2] as string).split('#')[1];
    const again = await handOff('', `#${fragment}`);
    expect(again.location.replace).toHaveBeenCalledExactlyOnceWith(first.location.replace.mock.calls[0][0]);
    expect(again.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', `/auth/ios#${fragment}`);
  });

  it('forwards an error code with the nonce, never its description', async () => {
    const { location, history } = await handOff(
      `?via=email&n=${NONCE}&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`,
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
    );
    expect(location.replace).toHaveBeenCalledExactlyOnceWith(
      `app.dsul.ios://auth/callback?error_code=otp_expired&n=${NONCE}`,
    );
    expect(history.replaceState).toHaveBeenCalledWith(null, '', `/auth/ios#via=email&n=${NONCE}&error_code=otp_expired`);
  });

  it('retries the hand-off with the nonce from the Open dsul button', async () => {
    const { doc, location } = await handOff(`?via=email&n=${NONCE}&code=abcdef123456`);
    (doc.getElementById('open') as HTMLButtonElement).click();
    expect(location.replace).toHaveBeenCalledTimes(2);
    expect(location.replace).toHaveBeenLastCalledWith(`app.dsul.ios://auth/callback?code=abcdef123456&n=${NONCE}`);
  });

  it.each([
    ['no nonce', '?via=email&code=abcdef123456'],
    ['a short nonce', '?via=email&n=AbCdEfGhIjKlMnO&code=abcdef123456'],
    ['a nonce with markup', '?via=email&n=AbCdEfGhIjKlMnOp%3Cb%3E&code=abcdef123456'],
    ['a nonce but no code', `?via=email&n=${NONCE}`],
  ])('forwards nothing with %s, and clears the address bar', async (_, search) => {
    const { doc, location, history } = await handOff(search);
    expect(location.replace).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/auth/ios');
    expect(doc.getElementById('opening')!.hidden).toBe(true);
    expect(doc.getElementById('done')!.hidden).toBe(false);
  });

  it('keeps the email copy off Google’s hand-off', async () => {
    const { doc, location } = await handOff('', '#code=abcdef123456');
    expect(location.replace).toHaveBeenCalledExactlyOnceWith('app.dsul.ios://auth/callback?code=abcdef123456');
    expect(doc.getElementById('email-help')!.hidden).toBe(true);
  });
});
