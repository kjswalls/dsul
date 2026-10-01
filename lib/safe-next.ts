/**
 * Where a sign-in may land afterwards: a path on `origin`, or `/`.
 *
 * /auth/callback builds its redirect as `${origin}${next}`, so a `next` of
 * `@evil.com` becomes `https://do.dsul.app@evil.com` — a URL whose HOST is
 * evil.com — and `//evil.com` or `/\evil.com` are protocol-relative. Anything
 * that does not resolve to `origin` is dropped rather than repaired.
 *
 * The result is re-serialised from the parsed URL, so what is checked is what
 * is returned: the URL parser strips tabs and newlines, and a raw string that
 * only looks safe before that step never reaches the redirect.
 */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  try {
    const url = new URL(raw, origin);
    // `/..//evil.com` parses to the pathname `//evil.com`: on the origin now, but
    // protocol-relative to anything that uses it without the prefix.
    if (url.origin !== origin || url.pathname.startsWith('//')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
