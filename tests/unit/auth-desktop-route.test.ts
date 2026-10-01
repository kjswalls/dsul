import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/auth/desktop/route';

// Next calls every handler with the request. Pass one, so a handler that ever
// starts reading the URL is caught by the constant-body test below.
const get = GET as unknown as (request: Request) => Response;
const at = (suffix: string) => get(new Request(`https://do.dsul.app/auth/desktop${suffix}`));

const scriptOf = (html: string) => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no inline script');
  return match[1];
};

/**
 * Runs the page's inline script against a URL, the way a browser would after
 * Supabase's redirect lands. `location`, `history` and `document` are passed in
 * by name so nothing touches jsdom's own window, and the page's markup is parsed
 * into a detached document so the script finds the elements it toggles.
 */
async function handOff(search: string, hash = '') {
  const html = await at('').text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const location = { search, hash, pathname: '/auth/desktop', replace: vi.fn() };
  const history = { replaceState: vi.fn() };
  new Function('location', 'history', 'document', scriptOf(html))(location, history, doc);
  return { doc, location, history };
}

describe('/auth/desktop', () => {
  it('serves the bounce page with every header the plan asks for', async () => {
    const res = at('?code=abcdef123456');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
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

  it('serves the same bytes whatever the URL carries', async () => {
    const bodies = await Promise.all(
      [
        '',
        '?code=abcdef123456',
        '?error=access_denied&error_code=otp_expired&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
        '?code=%22%3E%3Cimg%20src%3Dx%3E',
        '#access_token=secret&refresh_token=secret',
      ].map((suffix) => at(suffix).text()),
    );
    for (const body of bodies) expect(body).toBe(bodies[0]);
    expect(bodies[0]).not.toContain('abcdef123456');
  });

  it('hands a well-formed code to the app and clears it from the address bar', async () => {
    const { location, history } = await handOff('?code=abcDEF-123_4.5~6');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/auth/desktop');
    expect(location.replace).toHaveBeenCalledExactlyOnceWith('dsul://auth/callback?code=abcDEF-123_4.5~6');
    // Cleared first: the code should not be left in history behind the hand-off.
    expect(history.replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      location.replace.mock.invocationCallOrder[0],
    );
  });

  it('retries the hand-off from the Open dsul button', async () => {
    const { doc, location } = await handOff('?code=abcdef123456');
    (doc.getElementById('open') as HTMLButtonElement).click();
    expect(location.replace).toHaveBeenCalledTimes(2);
    expect(location.replace).toHaveBeenLastCalledWith('dsul://auth/callback?code=abcdef123456');
  });

  it('forwards only the error code, from the query or the hash', async () => {
    const query = await handOff(
      '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(query.location.replace).toHaveBeenCalledExactlyOnceWith('dsul://auth/callback?error_code=otp_expired');

    const hash = await handOff('', '#error=access_denied&error_description=The+user+denied');
    expect(hash.location.replace).toHaveBeenCalledExactlyOnceWith('dsul://auth/callback?error_code=access_denied');

    // An HTTP status in error_code is not a code; the error name behind it is.
    const status = await handOff('', '#error=unauthorized_client&error_code=401');
    expect(status.location.replace).toHaveBeenCalledExactlyOnceWith(
      'dsul://auth/callback?error_code=unauthorized_client',
    );
  });

  it('never forwards a description or a token', async () => {
    const runs = await Promise.all([
      handOff('?code=abcdef123456&error_description=hello&access_token=tok&refresh_token=ref'),
      handOff('', '#access_token=tok&refresh_token=ref&error_description=hello'),
      handOff('?error_description=hello'),
    ]);
    for (const { location } of runs) {
      for (const [url] of location.replace.mock.calls) {
        expect(url).not.toMatch(/error_description|access_token|refresh_token|hello|tok|ref/);
      }
    }
    // Only the first carried anything forwardable.
    expect(runs[0].location.replace).toHaveBeenCalledExactlyOnceWith('dsul://auth/callback?code=abcdef123456');
    expect(runs[1].location.replace).not.toHaveBeenCalled();
    expect(runs[2].location.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', '?code=abc'],
    ['markup', '?code=%22%3E%3Cimg%20src%3Dx%3E'],
    ['a second scheme', '?code=abcdef12%26next%3Djavascript%3Aalert(1)'],
    ['a capitalised error', '?error=Access_Denied'],
  ])('drops a malformed value (%s) and says there is nothing to open', async (_, search) => {
    const { doc, location, history } = await handOff(search);
    expect(location.replace).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/auth/desktop');
    expect(doc.getElementById('opening')!.hidden).toBe(true);
    expect(doc.getElementById('done')!.hidden).toBe(false);
  });
});
