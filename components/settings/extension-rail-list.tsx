'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Store } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import {
  subPanesOf,
  extensionSlugFromPane,
  settingsForPane,
  type PaneId,
  type SettingCtx,
  type SettingRecord,
  type SettingsPane,
} from '@/lib/settings/manifest';
import { extensionStateOf, toggleOf, type ExtensionState } from '@/lib/settings/extension-state';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { OFFICIAL_EXTENSIONS } from '@/lib/extension-registry';

const OFF_OPEN_KEY = 'dsul-settings-extensions-off-open';

/**
 * Your extensions, as a list you can switch from — the rail's sub-list under
 * Extensions on a desktop, and the top of the Extensions pane on a phone.
 *
 * The Extensions pane itself is the store (Browse), so this list is where an
 * extension you already know about lives: Browse first, then the ones that are
 * on, then the ones that are off, folded.
 *
 * THE SWITCH IS A SIBLING OF THE LINK, never inside it. A switch nested in a
 * link is one target that does two things depending on the pixel. And it is
 * NOT a setting row: `data-setting-row` keeps naming exactly one place (the
 * extension's own pane), so a ?focus= deep link still has one candidate. The
 * switch writes through the same toggle record that pane draws, shows that
 * record's own value (an extension can be switched on and still Unavailable,
 * and the pane draws that as a disabled switch in the ON position — so must
 * this), and is disabled for exactly the reasons that row is.
 *
 * The On/Off split is a SNAPSHOT, taken when you arrive on a pane and when the
 * stores first answer. Flipping a switch here changes the row's dot and switch
 * but leaves the row where it is; re-sorting live would move the row out from
 * under the pointer that just clicked it.
 */
export function ExtensionRailList({
  ctx,
  pane,
  variant,
}: {
  ctx: SettingCtx;
  pane: PaneId;
  variant: 'rail' | 'pane';
}) {
  // The records read through getState(); these name the two stores a row's
  // state depends on, so the list re-renders when they change.
  const extensionsTick = useExtensionsStore((s) => `${s.available}|${s.configsLoaded}|${JSON.stringify(s.enabled)}`);
  const reminderTick = useReminderStore((s) => `${s.remindersEnabled}|${s.stakesEnabled}`);
  const loadedTick = useExtensionsStore((s) => `${s.available}|${s.configsLoaded}`);
  const loading = useExtensionsStore((s) => s.available && !s.configsLoaded);

  const rows = useMemo(
    () =>
      subPanesOf('extensions').map((sub) => {
        const slug = extensionSlugFromPane(sub.id)!;
        const toggle = toggleOf(settingsForPane(sub.id));
        return { sub, slug, toggle, state: extensionStateOf(toggle, ctx), checked: readToggle(toggle, ctx) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, extensionsTick, reminderTick]
  );

  // Which slugs sit under "On". Recomputed on arrival and when loading
  // finishes, NOT on every flip — see the header.
  const onSlugs = useMemo(
    () => new Set(rows.filter((row) => row.state.on).map((row) => row.slug)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane, loadedTick]
  );

  // Lazy, not an effect: the settings shell only mounts on the client, behind
  // the page's hydration gate, so storage is readable here.
  const [offOpenPref, setOffOpenPref] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OFF_OPEN_KEY) === '1';
    } catch {
      return false; // private mode — folded
    }
  });
  const toggleOffOpen = () => {
    setOffOpenPref((open) => {
      try {
        localStorage.setItem(OFF_OPEN_KEY, open ? '0' : '1');
      } catch {
        /* private mode — the fold just isn't remembered */
      }
      return !open;
    });
  };

  const onRows = rows.filter((row) => onSlugs.has(row.slug));
  const offRows = rows.filter((row) => !onSlugs.has(row.slug));
  const currentSlug = extensionSlugFromPane(pane);
  const currentIsOff = offRows.some((row) => row.slug === currentSlug);
  // Never fold away the row you are on, and never fold everything away.
  const offOpen = offOpenPref || onRows.length === 0 || currentIsOff;

  const rail = variant === 'rail';

  const row = ({ sub, slug, toggle, state, checked }: (typeof rows)[number]) => (
    <ExtensionRow
      key={slug}
      sub={sub}
      slug={slug}
      state={state}
      checked={checked}
      current={slug === currentSlug}
      rail={rail}
      onCheckedChange={toggle ? (next) => toggle.write(next, ctx) : undefined}
    />
  );

  return (
    <div
      className={cn('flex flex-col', rail ? 'gap-px' : 'divide-border divide-y')}
      data-testid={`extension-list-${variant}`}
    >
      {rail && (
        <Link
          href="/settings/extensions"
          aria-current={pane === 'extensions' ? 'page' : undefined}
          className={cn(
            'flex min-h-7 items-center gap-2 rounded-sm px-2 text-[13px] transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            pane === 'extensions'
              ? 'bg-secondary text-foreground font-medium'
              : 'text-secondary-foreground hover:bg-accent'
          )}
        >
          <Store className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">Browse</span>
          <span className="text-muted-foreground font-num text-[10px]">{OFFICIAL_EXTENSIONS.length}</span>
        </Link>
      )}

      {/* Until the store answers, every row says Loading and none of them is
          on or off yet — so no split either, which would announce "On · 0"
          and then reshuffle. One plain list, in catalog order. */}
      {loading ? (
        rows.map(row)
      ) : (
        <>
          <GroupLabel rail={rail}>On · {onRows.length}</GroupLabel>
          {onRows.map(row)}

          <GroupLabel rail={rail}>
            Off · {offRows.length}
            {onRows.length > 0 && !currentIsOff && (
              <button
                type="button"
                aria-expanded={offOpen}
                onClick={toggleOffOpen}
                className={cn(
                  'text-muted-foreground hover:text-foreground ml-auto rounded-sm px-1 text-[11px] font-normal tracking-normal normal-case',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                )}
              >
                {offOpen ? 'Hide' : 'Show'}
              </button>
            )}
          </GroupLabel>
          {offOpen && offRows.map(row)}
        </>
      )}
    </div>
  );
}

/** The toggle's own value — what the extension's pane draws its switch from. */
function readToggle(toggle: SettingRecord | undefined, ctx: SettingCtx): boolean {
  try {
    return Boolean(toggle?.read(ctx));
  } catch {
    return false;
  }
}

function GroupLabel({ rail, children }: { rail: boolean; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'text-muted-foreground flex items-center text-[10px] font-medium tracking-wider uppercase',
        rail ? 'px-2 pt-2.5 pb-0.5' : 'pt-5 pb-1.5'
      )}
    >
      {children}
    </p>
  );
}

function ExtensionRow({
  sub,
  slug,
  state,
  checked,
  current,
  rail,
  onCheckedChange,
}: {
  sub: SettingsPane;
  slug: string;
  state: ExtensionState;
  checked: boolean;
  current: boolean;
  rail: boolean;
  onCheckedChange?: (next: boolean) => void;
}) {
  // Disabled for the same reasons the pane's own row is: a store that hasn't
  // answered, or an extension that can't run yet.
  const unavailable = state.label === 'Unavailable';
  const disabled = !onCheckedChange || state.label === 'Loading' || unavailable;
  // The state in words, for whoever can't see the dot — and the only place the
  // rail says WHY, since a disabled switch takes no focus and shows no title
  // on touch.
  const stateText = state.reason ? `Unavailable — ${state.reason}` : state.label;
  const stateId = `ext-state-${rail ? 'rail' : 'pane'}-${slug}`;
  const Icon = sub.icon;
  const sw = (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label={sub.name}
      aria-describedby={stateId}
      className={rail ? 'h-4 w-7 [&>span]:size-3.5' : undefined}
    />
  );

  if (!rail) {
    return (
      <div className="flex items-center gap-3 py-3" data-extension-row={slug} data-extension-state={state.label}>
        <Link
          href={`/settings/${sub.id}`}
          aria-describedby={stateId}
          className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-[5px] focus-visible:ring-2 focus-visible:outline-none"
        >
          <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="text-foreground block text-sm">{sub.name}</span>
            <span id={stateId} className="text-muted-foreground block text-xs">
              {stateText}
            </span>
          </span>
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        </Link>
        {sw}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group/ext flex min-h-7 items-center gap-1.5 rounded-sm pr-1.5 transition-colors',
        current ? 'bg-secondary' : 'hover:bg-accent'
      )}
      data-extension-row={slug}
      data-extension-state={state.label}
    >
      <Link
        href={`/settings/${sub.id}`}
        aria-current={current ? 'page' : undefined}
        title={state.reason ? `${sub.name} · ${stateText}` : sub.name}
        className={cn(
          'min-w-0 flex-1 rounded-sm py-1 pl-2 text-[13px] leading-snug',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          current ? 'text-foreground font-medium' : 'text-secondary-foreground'
        )}
      >
        {sub.name}
        {/* Read as part of the link's name ("Beeminder, Unavailable — …"), so
            the state reaches a screen reader without the dot. */}
        <span id={stateId} className="sr-only">
          , {stateText}
        </span>
      </Link>
      {/* At rest a dot says the state; with a mouse over the row, or focus
          anywhere in it, the switch takes the dot's place. Touch has no hover,
          so there the switch is always drawn. At rest the switch is not just
          invisible but out of the pointer's reach too, or a tap on a
          touchscreen laptop (which reports hover) would flip a switch nobody
          had seen. Instant, not faded: the accent is never shown dimmed, and
          the dot is its own element for the same reason. An unavailable
          extension wears a hollow ring, so it never reads as plain Off. */}
      <span className="relative grid h-4 w-7 shrink-0 place-items-center">
        <span
          aria-hidden
          className={cn(
            'size-[6px] rounded-full [@media(hover:none)]:hidden',
            'group-focus-within/ext:hidden group-hover/ext:hidden',
            unavailable ? 'border-muted-foreground/70 border' : state.on ? 'bg-primary' : 'bg-muted-foreground/40'
          )}
        />
        <span
          className={cn(
            'pointer-events-none absolute inset-0 grid place-items-center opacity-0',
            'group-focus-within/ext:pointer-events-auto group-focus-within/ext:opacity-100',
            'group-hover/ext:pointer-events-auto group-hover/ext:opacity-100',
            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
          )}
        >
          {sw}
        </span>
      </span>
    </div>
  );
}
