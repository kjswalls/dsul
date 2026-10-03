'use client';

import { useId, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { Switch } from '@/components/ui/switch';
import { LookMini, themeScope } from './look-mini';
import {
  applyLook,
  pickLayoutFamily,
  settingById,
  type SettingCtx,
} from '@/lib/settings/manifest';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import {
  DARK_LOOKS,
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  LIGHT_LOOKS,
  darkLookDef,
  lightLookDef,
  type DarkLook,
  type LightLook,
  type LookMode,
} from '@/lib/theme-looks';
import { THEME_PALETTES, paletteDef, type ThemePalette } from '@/lib/theme-palettes';
import {
  LAYOUT_FAMILIES,
  layoutDef,
  layoutStyles,
  type LayoutDef,
  type LayoutTheme,
} from '@/lib/layout-themes';
import { LOOKS, lookBlurb, lookColours, lookHasOwnColours, lookState } from '@/lib/looks';
import { cn } from '@/lib/utils';

/**
 * Settings → Look's top half: the six look records drawn as pictures you tap.
 *
 *   Looks           a layout with the colours it was made with, one tap each
 *   Light | Dark    a live preview per mode; tapping one keeps dsul in that
 *                   mode. Under each, that mode's themes, and the tint dots
 *                   under Paper and Night, the only two a tint acts on
 *   Follow device   the mode's third value, as a switch
 *   Layout          floor plans, and Notepad's styles under Notepad
 *
 * It owns no setting. Every pick writes through its record's own write()
 * (lib/settings/manifest.ts), so the saved columns, search hits and `?focus=`
 * ids are the ones the rows had; the records are LOOK_PICKER_RECORD_IDS, and
 * the shell leaves them out of the pane's flat list. Two picks go through a
 * manifest helper instead: a Look (several records at once) and a layout from
 * the floor plans (the record's write also raises a toast offering the
 * pairing, which the Looks row and the "for <Layout>" marks already say here).
 *
 * Each of the six ids has exactly one `data-setting-row` anchor in every state
 * this device can draw, because a deep link that finds no anchor never lands
 * (settings-shell's focus effect). Layouts are desktop-only, so a phone draws
 * neither the Looks nor the Layout block and has four anchors, matching what
 * paneRows and search offer it.
 *
 * Rendered on the first commit, never behind a mounted flag: the focus effect
 * runs once when the pane mounts and would miss anchors that arrive a commit
 * later. The shell is client-only (the page shows a skeleton until settings
 * hydrate), so next-themes has already resolved the mode by then.
 */

type AnchorId =
  | 'look.theme'
  | 'look.lightTheme'
  | 'look.darkTheme'
  | 'look.palette'
  | 'look.layout'
  | 'look.layoutStyle';

/** A floor plan per family, in the style of the layout's own arrangement. */
const PLANS: Record<string, ReactNode> = {
  classic: (
    <>
      <rect x="4" y="4" width="18" height="40" rx="2" fill="currentColor" opacity=".25" />
      <rect x="26" y="4" width="42" height="40" rx="4" fill="currentColor" opacity=".55" />
    </>
  ),
  console: (
    <>
      <rect x="4" y="4" width="64" height="3" fill="currentColor" opacity=".4" />
      <rect x="4" y="9" width="44" height="31" rx="1" fill="currentColor" opacity=".55" />
      <rect x="50" y="9" width="18" height="31" rx="1" fill="currentColor" opacity=".25" />
      <rect x="4" y="42" width="64" height="3" fill="currentColor" opacity=".4" />
    </>
  ),
  notebook: (
    <>
      <rect x="6" y="5" width="29" height="38" rx="2" fill="currentColor" opacity=".35" />
      <rect x="37" y="5" width="29" height="38" rx="2" fill="currentColor" opacity=".55" />
      <line x1="36" y1="5" x2="36" y2="43" stroke="currentColor" strokeDasharray="2 2" opacity=".5" />
    </>
  ),
  notepad: (
    <>
      <rect x="4" y="4" width="64" height="5" fill="currentColor" opacity=".3" />
      <rect x="4" y="10" width="20" height="31" fill="currentColor" opacity=".35" />
      <rect x="25" y="10" width="43" height="31" fill="currentColor" opacity=".55" />
      <rect x="4" y="42" width="64" height="3" fill="currentColor" opacity=".4" />
    </>
  ),
  writer: (
    <>
      <rect x="22" y="6" width="28" height="36" rx="1" fill="currentColor" opacity=".45" />
      <rect x="2" y="18" width="4" height="12" rx="1" fill="currentColor" opacity=".4" />
    </>
  ),
};

// focus-visible keeps a deep-linked anchor marked after the highlight clears,
// as SettingRow does.
const ANCHOR_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-ring data-[highlight]:ring-2 data-[highlight]:ring-ring data-[highlight]:ring-offset-4 data-[highlight]:ring-offset-background';

const QUIET = 'text-muted-foreground text-xs';

export function LookPicker({
  ctx,
  isMobile,
  highlightId,
}: {
  ctx: SettingCtx;
  isMobile: boolean;
  highlightId: string | null;
}) {
  const light = useLookStore((s) => s.light);
  const dark = useLookStore((s) => s.dark);
  const layout = useLookStore((s) => s.layout);
  const tint = usePaletteStore((s) => s.palette);
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);
  const { resolvedTheme, systemTheme, setTheme: setThemeNow } = useTheme();

  // The mode as the record reads it, so this, the search row and a test's
  // hand-built ctx all agree.
  const theme = String(settingById('look.theme')!.read(ctx));
  const following = theme !== 'light' && theme !== 'dark';
  const showing: LookMode =
    resolvedTheme === 'dark' || resolvedTheme === 'light'
      ? resolvedTheme
      : theme === 'dark'
        ? 'dark'
        : 'light';

  const def = layoutDef(layout);
  const ownColours = def.slots.skin !== 'theme';

  const anchor = (id: AnchorId) => ({
    'data-setting-row': id,
    'data-highlight': highlightId === id || undefined,
    tabIndex: -1,
  });

  const write = (id: AnchorId, value: string) => settingById(id)!.write(value, ctx);

  /**
   * Writes the mode. Eased only when what is on screen changes: easing opens
   * the colour-only transition window (lib/theme-transition.ts), which would
   * also snap the Follow device switch's thumb when nothing visible moved.
   */
  const writeMode = (next: 'light' | 'dark' | 'system') => {
    const lands = next === 'system' ? (systemTheme === 'dark' ? 'dark' : 'light') : next;
    const quiet = lands === showing;
    settingById('look.theme')!.write(next, quiet ? { ...ctx, setTheme: setThemeNow } : ctx);
  };

  // A tint acts on Paper and Night only, and one value covers both, so its one
  // anchor sits on the first side that draws the dots; with neither picked, on
  // the light side's "no tints" line.
  const tintAnchorSide: LookMode = light === DEFAULT_LIGHT_LOOK || dark !== DEFAULT_DARK_LOOK ? 'light' : 'dark';

  const picks = { light, dark, tint };
  const previewDef = isMobile ? layoutDef('classic') : def;

  const side = (mode: LookMode) => {
    const pinned = !following && theme === mode;
    const isShowing = showing === mode;
    const current = mode === 'light' ? light : dark;
    const options = mode === 'light' ? LIGHT_LOOKS : DARK_LOOKS;
    const plain = mode === 'light' ? light === DEFAULT_LIGHT_LOOK : dark === DEFAULT_DARK_LOOK;
    const currentLabel = mode === 'light' ? lightLookDef(light).label : darkLookDef(dark).label;
    // The theme this layout was made with for this mode, marked on its swatch.
    // Not on a phone: the layout never reaches one.
    const madeFor = isMobile ? undefined : def.pairsWith[mode];
    const modeLabel = mode === 'light' ? 'Light' : 'Dark';

    return (
      <div
        key={mode}
        data-testid={`look-side-${mode}`}
        data-showing={isShowing || undefined}
        className={cn(
          'flex min-w-0 flex-col gap-3 rounded-[14px] border p-3',
          // The showing side is outlined, never the other side dimmed: the
          // accent is not faded through a parent (CLAUDE.md).
          isShowing ? 'border-primary shadow-[0_0_0_1px_var(--primary)]' : 'border-border'
        )}
      >
        <div className="relative flex flex-col gap-2">
          <LookMini
            def={previewDef}
            phone={isMobile}
            mode={mode}
            light={light}
            dark={dark}
            tint={tint}
            bucketStyle={bucketStyle}
            typeMode={typeMode}
            showCompleted={showCompleted}
            className="border-border rounded-[8px] border"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={`Always ${mode}`}
              data-testid={`look-pin-${mode}`}
              onClick={() => {
                if (!pinned) writeMode(mode);
              }}
              className={cn(
                'text-foreground flex items-center gap-2 text-sm font-medium',
                // The whole preview is the target: the button's box stretches
                // over the picture above it, which holds no control of its own.
                "after:absolute after:inset-[-4px] after:rounded-[10px] after:content-['']",
                'focus-visible:outline-none focus-visible:after:ring-ring focus-visible:after:ring-2'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'grid size-3.5 place-items-center rounded-full border',
                  pinned ? 'border-foreground' : 'border-muted-foreground/60'
                )}
              >
                {pinned && <span className="bg-foreground size-1.5 rounded-full" />}
              </span>
              {modeLabel}
            </button>
            {isShowing && (
              <span className="text-muted-foreground ml-auto font-mono text-[10px] tracking-wider uppercase">
                Showing now
              </span>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label={`${modeLabel} theme`}
          {...anchor(mode === 'light' ? 'look.lightTheme' : 'look.darkTheme')}
          className={cn('grid grid-cols-3 gap-2 rounded-[10px]', ANCHOR_RING)}
        >
          {options.map((o) => {
            const pressed = current === o.value;
            const mark = madeFor === o.value ? def.label : null;
            const chipPicks =
              mode === 'light'
                ? { ...picks, light: o.value as LightLook }
                : { ...picks, dark: o.value as DarkLook };
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={pressed}
                data-testid={`look-swatch-${o.value}`}
                title={o.description}
                onClick={() => {
                  if (!pressed) write(mode === 'light' ? 'look.lightTheme' : 'look.darkTheme', o.value);
                }}
                className={cn(
                  'relative flex min-w-0 flex-col gap-1.5 rounded-[10px] border p-1.5 text-left text-xs transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  pressed
                    ? 'border-foreground text-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <ThemeChip mode={mode} picks={chipPicks} />
                {mark && (
                  // On the swatch's top edge, like a legend, so it never
                  // covers the colours it is pointing at.
                  <span
                    aria-hidden
                    className="bg-primary text-primary-foreground absolute -top-[7px] left-1/2 max-w-[calc(100%-8px)] -translate-x-1/2 truncate rounded-[4px] px-1 font-mono text-[9px] leading-[14px]"
                  >
                    for {mark}
                  </span>
                )}
                <span className="truncate">
                  {o.label}
                  {mark && <span className="sr-only">, made for {mark}</span>}
                </span>
              </button>
            );
          })}
        </div>

        <TintLine
          plain={plain}
          themeLabel={currentLabel}
          tint={tint}
          anchorProps={tintAnchorSide === mode ? anchor('look.palette') : undefined}
          onPick={(value) => write('look.palette', value)}
        />
      </div>
    );
  };

  const switchId = useId();
  const followDesc = `${switchId}-desc`;
  const otherMode = theme === 'dark' ? 'Light' : 'Dark';

  return (
    <div data-testid="look-picker" className="flex flex-col gap-5">
      {!isMobile && (
        <section aria-labelledby={`${switchId}-looks`} className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 id={`${switchId}-looks`} className="text-foreground text-sm font-medium">
              Looks
            </h3>
            <span className={QUIET}>A layout with the colours it was made with</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {LOOKS.map((look) => {
              const state = lookState(look, { layout, light, dark });
              const colours = lookColours(look);
              // Drawn in the mode it was made for, so its own colours show.
              const mode: LookMode = lookHasOwnColours(look)
                ? 'light'
                : colours.light && !colours.dark
                  ? 'light'
                  : colours.dark && !colours.light
                    ? 'dark'
                    : showing;
              return (
                <div
                  key={look.id}
                  data-look-state={state}
                  className={cn(
                    'relative flex min-w-0 flex-col gap-2 rounded-[12px] border p-2 transition-colors',
                    state === 'on'
                      ? 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
                      : state === 'edited'
                        ? 'border-muted-foreground border-dashed'
                        : 'border-border hover:bg-accent'
                  )}
                >
                  <LookMini
                    def={layoutDef(look.layout)}
                    mode={mode}
                    light={colours.light ?? light}
                    dark={colours.dark ?? dark}
                    tint={tint}
                    bucketStyle={bucketStyle}
                    typeMode={typeMode}
                    showCompleted={showCompleted}
                    className="border-border rounded-[6px] border"
                  />
                  <button
                    type="button"
                    aria-pressed={state === 'on'}
                    data-testid={`look-card-${look.id}`}
                    onClick={() => {
                      if (state !== 'on') applyLook(look, ctx);
                    }}
                    className={cn(
                      'flex min-w-0 flex-col items-start px-0.5 text-left',
                      "after:absolute after:inset-0 after:rounded-[12px] after:content-['']",
                      'focus-visible:outline-none focus-visible:after:ring-ring focus-visible:after:ring-2'
                    )}
                  >
                    <span className="text-foreground text-sm font-medium">{look.label}</span>
                    <span className={QUIET}>{lookBlurb(look)}</span>
                    {state === 'on' && (
                      <span className="text-success-text mt-1 font-mono text-[10px] tracking-wider uppercase">
                        On
                      </span>
                    )}
                    {state === 'edited' && (
                      <span className="text-muted-foreground mt-1 font-mono text-[10px] tracking-wider uppercase">
                        Edited · tap to put back
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="text-muted-foreground mt-2 flex items-center gap-3 text-xs font-medium">
            <span>Make it yours</span>
            <span aria-hidden className="bg-border h-px flex-1" />
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {side('light')}
        {side('dark')}
      </div>

      {!isMobile && ownColours && (
        <p className={cn(QUIET, '-mt-2')} data-testid="look-own-colours">
          {def.styleLabel ?? def.label} brings its own colours. Your themes rest while it’s on, and
          still dress menus and dialogs.
        </p>
      )}

      <div
        {...anchor('look.theme')}
        className={cn(
          '-mx-3 flex items-center justify-between gap-6 rounded-[5px] px-3 py-2.5',
          ANCHOR_RING
        )}
      >
        <div className="min-w-0">
          <label htmlFor={switchId} className="text-foreground text-sm font-medium">
            Follow device
          </label>
          <p id={followDesc} className="text-muted-foreground mt-[3px] max-w-[46ch] text-xs">
            {following
              ? `Light or dark, as your device is set. It’s ${showing} now.`
              : `Off. dsul stays ${theme} until you tap ${otherMode}.`}
          </p>
        </div>
        <Switch
          id={switchId}
          data-testid="look-follow-device"
          aria-describedby={followDesc}
          checked={following}
          onCheckedChange={(on) => writeMode(on ? 'system' : showing)}
        />
      </div>

      {!isMobile && (
        <LayoutBlock
          def={def}
          anchor={anchor}
          onFamily={(value) => pickLayoutFamily(value, ctx)}
          onStyle={(value) => write('look.layoutStyle', value)}
        />
      )}
    </div>
  );
}

/** A swatch's chip: the theme itself, in miniature: its ground, its ink, its accent. */
function ThemeChip({
  mode,
  picks,
}: {
  mode: LookMode;
  picks: { light: LightLook; dark: DarkLook; tint: ThemePalette };
}) {
  return (
    <span
      aria-hidden
      {...themeScope(mode, picks)}
      className={cn(
        mode === 'dark' && 'dark',
        'bg-background border-border relative flex h-[34px] flex-col justify-center gap-1 overflow-hidden border px-2'
      )}
      // The theme's own corner, kept small enough to read at chip size.
      style={{ borderRadius: 'min(calc(var(--radius) * 0.5), 10px)' }}
    >
      <span className="bg-foreground/75 block h-[3px] w-[58%] rounded-full" />
      <span className="bg-muted-foreground/60 block h-[3px] w-[38%] rounded-full" />
      <span className="bg-primary absolute top-1/2 right-2 size-2.5 -translate-y-1/2 rounded-full" />
    </span>
  );
}

function TintLine({
  plain,
  themeLabel,
  tint,
  anchorProps,
  onPick,
}: {
  plain: boolean;
  themeLabel: string;
  tint: ThemePalette;
  anchorProps?: Record<string, unknown>;
  onPick: (value: ThemePalette) => void;
}) {
  return (
    <div
      {...anchorProps}
      role={plain ? 'group' : undefined}
      aria-label={plain ? `${themeLabel} tint` : undefined}
      className={cn('flex min-h-6 items-center gap-2 rounded-[8px] pl-1 text-xs', ANCHOR_RING)}
    >
      {/* The variant hangs off its theme, the way the tree reads. */}
      <span aria-hidden className="border-border -mt-2 h-3 w-2 flex-none rounded-bl-[3px] border-b border-l" />
      <span className="text-muted-foreground">{themeLabel}</span>
      {plain ? (
        <>
          <span className="flex items-center gap-2">
            {THEME_PALETTES.map((p) => {
              const pressed = tint === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={pressed}
                  aria-label={`${p.label} tint`}
                  title={`Tint: ${p.label}`}
                  data-testid={`look-tint-${p.value}`}
                  onClick={() => {
                    if (!pressed) onPick(p.value);
                  }}
                  className={cn(
                    // A 16px dot with a 24px hit area (WCAG 2.5.8), 24px apart.
                    "relative size-4 rounded-full border border-black/10 transition-shadow before:absolute before:-inset-[5px] before:rounded-full before:content-['']",
                    'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                    pressed && 'ring-foreground ring-offset-background ring-2 ring-offset-2'
                  )}
                  style={{ background: p.swatch }}
                />
              );
            })}
          </span>
          <span className="text-foreground">{paletteDef(tint).label}</span>
        </>
      ) : (
        <span className="text-muted-foreground">has no tints</span>
      )}
    </div>
  );
}

function LayoutBlock({
  def,
  anchor,
  onFamily,
  onStyle,
}: {
  def: LayoutDef;
  anchor: (id: AnchorId) => Record<string, unknown>;
  onFamily: (value: LayoutTheme) => void;
  onStyle: (value: LayoutTheme) => void;
}) {
  const styles = layoutStyles(def.family);
  const hasStyles = styles.length > 1;
  return (
    <section
      // Off a family with styles, Style's deep link lands on the whole block,
      // where Notepad is one tap away. On one, on the chips themselves.
      {...(hasStyles ? {} : anchor('look.layoutStyle'))}
      className={cn('flex flex-col gap-2.5 rounded-[10px]', ANCHOR_RING)}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-foreground text-sm font-medium">Layout</h3>
        <span className={QUIET}>Changes the layout only</span>
      </div>
      <div
        role="group"
        aria-label="Layout"
        {...anchor('look.layout')}
        className={cn('flex flex-wrap gap-2 rounded-[10px]', ANCHOR_RING)}
      >
        {LAYOUT_FAMILIES.map((family) => {
          const pressed = def.family === family.value;
          return (
            <button
              key={family.value}
              type="button"
              aria-pressed={pressed}
              data-testid={`look-layout-${family.value}`}
              title={family.description}
              onClick={() => {
                if (!pressed) onFamily(family.value);
              }}
              className={cn(
                'flex w-[92px] flex-col gap-1.5 rounded-[10px] border p-1.5 text-left text-xs transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                pressed
                  ? 'border-foreground text-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <svg
                viewBox="0 0 72 48"
                aria-hidden
                className="bg-surface-3 text-foreground h-auto w-full rounded-[6px]"
              >
                {PLANS[family.value]}
              </svg>
              {family.label}
            </button>
          );
        })}
      </div>
      {hasStyles && (
        <div
          role="group"
          aria-label={`${layoutDef(def.family).label} style`}
          {...anchor('look.layoutStyle')}
          className={cn('flex items-center gap-2 rounded-[8px] pl-1 text-xs', ANCHOR_RING)}
        >
          <span aria-hidden className="border-border -mt-2 h-3 w-2 flex-none rounded-bl-[3px] border-b border-l" />
          <span className="text-muted-foreground">{layoutDef(def.family).label}</span>
          <span className="flex flex-wrap gap-1">
            {styles.map((style) => {
              const pressed = def.value === style.value;
              return (
                <button
                  key={style.value}
                  type="button"
                  aria-pressed={pressed}
                  title={`Style: ${style.styleLabel}`}
                  data-testid={`look-style-${style.value}`}
                  onClick={() => {
                    if (!pressed) onStyle(style.value);
                  }}
                  className={cn(
                    'h-6 rounded-[6px] border px-2 transition-colors',
                    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                    pressed
                      ? 'border-foreground text-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {style.styleLabel}
                </button>
              );
            })}
          </span>
        </div>
      )}
    </section>
  );
}
