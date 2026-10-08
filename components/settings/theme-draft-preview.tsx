'use client';

import { useEffect } from 'react';
import { printTheme, type ThemeManifest } from '@/lib/mods/theme-grammar';
import { DRAFT_SLUG } from '@/lib/user-themes/css';
import { setUserThemeDraft } from '@/lib/user-themes/store';
import { resolveDarkPick, resolveLightPick } from '@/lib/theme-looks';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { layoutDef } from '@/lib/layout-themes';
import { LookMini } from './look-mini';

/**
 * A theme manifest drawn as a miniature dsul, in the live layout: the theme
 * editor's preview (./theme-builder.tsx) and the "Write with AI" draft card's
 * (./make-write.tsx). The draft's rules go in as the injector's preview twin
 * only (setUserThemeDraft), so nothing outside the miniature changes, and the
 * draft is cleared on unmount. The two are never mounted together: Edit
 * replaces the card with the editor.
 */
export function ThemeDraftPreview({ manifest, className }: { manifest: ThemeManifest; className?: string }) {
  const printedKey = JSON.stringify(manifest);
  useEffect(() => {
    const printed = printTheme(JSON.parse(printedKey) as ThemeManifest);
    setUserThemeDraft({ slug: DRAFT_SLUG, mode: printed.mode, decls: printed.decls });
  }, [printedKey]);
  useEffect(() => () => setUserThemeDraft(null), []);

  const layout = useLookStore((s) => s.layout);
  const lightPick = useLookStore((s) => s.light);
  const darkPick = useLookStore((s) => s.dark);
  const tint = usePaletteStore((s) => s.palette);
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);

  return (
    <LookMini
      def={layoutDef(layout)}
      mode={manifest.mode}
      light={manifest.mode === 'light' ? DRAFT_SLUG : resolveLightPick(lightPick)}
      dark={manifest.mode === 'dark' ? DRAFT_SLUG : resolveDarkPick(darkPick)}
      tint={tint}
      bucketStyle={bucketStyle}
      typeMode={typeMode}
      showCompleted={showCompleted}
      className={className ?? 'border-border rounded-[8px] border'}
    />
  );
}
