'use client';

import Link from 'next/link';
import type { ComponentProps, MouseEvent } from 'react';

/**
 * Moving between settings panes without asking the server.
 *
 * Every pane is one client page, /settings/[[...pane]], and it has nothing to
 * fetch per pane: the values are in browser stores and the manifest is a
 * module. But the route is dynamic, so a router.push or a <Link> to another
 * pane is a full RSC round trip, through proxy.ts and its Supabase getUser(),
 * before the new pane may draw. That wait was the delay between tabs.
 *
 * history.pushState is the way around it. Next patches it, so usePathname and
 * useSearchParams follow the new address and Back and Forward restore it with
 * no request (app-router.js copies its tree into the entry). useParams does NOT
 * follow, because it reads the tree, which is why the page reads the pane off
 * usePathname. A reload still asks the server, which serves the same page.
 *
 * Only from inside /settings. Anywhere else the page that reads the pane is not
 * mounted, so a pushed address would change the URL and nothing on screen.
 */
export function showSettings(href: string, opts: { replace?: boolean; scroll?: boolean } = {}) {
  if (opts.replace) {
    window.history.replaceState(null, '', href);
    return;
  }
  window.history.pushState(null, '', href);
  // router.push scrolled to the top on the way in; a pushed address does not.
  if (opts.scroll !== false) window.scrollTo(0, 0);
}

function onSettingsRoute(): boolean {
  const path = window.location.pathname;
  return path === '/settings' || path.startsWith('/settings/');
}

/**
 * A <Link> between settings panes that switches in place. A modified click
 * (new tab, new window, download) and a link to anywhere outside /settings are
 * left to the browser and Next, untouched. Never prefetched: the switch does
 * not use what a prefetch would bring.
 */
export function SettingsLink({ href, onClick, ...rest }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== '_self') return;
    if (!href.startsWith('/settings') || !onSettingsRoute()) return;
    e.preventDefault();
    showSettings(href);
  };
  return <Link href={href} prefetch={false} onClick={handle} {...rest} />;
}
