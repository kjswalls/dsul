import { createElement, type ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { getIconByName } from '@/lib/category-icons';
import { MOD_ICON_NAMES, type ModIconName } from './icons-list';

/**
 * The lucide component for a name a mod gave (an `icon` node, a panel's
 * `icon`), or undefined. Only names on the allow-list (./icons-list.ts)
 * resolve, so a tree that slipped past the schema still cannot draw a
 * denied glyph. Used only by the mod renderer and the mod surfaces' chrome.
 */
const ALLOWED: ReadonlySet<string> = new Set(MOD_ICON_NAMES);

export function modIcon(name: ModIconName | string | undefined): LucideIcon | undefined {
  return name && ALLOWED.has(name) ? getIconByName(name) : undefined;
}

/** modIcon drawn, or `fallback` (the host's own glyph) when the name does not resolve; null without one. */
export function ModIcon({
  name,
  fallback,
  ...props
}: { name: string | undefined; fallback?: LucideIcon } & ComponentProps<LucideIcon>) {
  const icon = modIcon(name) ?? fallback;
  return icon ? createElement(icon, props) : null;
}
