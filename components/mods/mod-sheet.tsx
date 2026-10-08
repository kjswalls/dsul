'use client';

import { useEffect } from 'react';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { useModsStore } from '@/lib/mods-store';
import { modDisplayLabel } from '@/lib/mods/labels';
import { useModSheet } from '@/lib/mods/ui/sheet-store';
import { panelOf } from '@/lib/mods/ui/surface-state';
import { ModSurface } from './mod-surface';

const close = () => useModSheet.getState().close();

/**
 * The phone's one mod surface (memory/plans/mods.md, build order 9): a vaul
 * sheet showing the panel lib/mods/ui/open-panel.ts routed here, from ⌘K or a
 * held `$.ui.open`. The phone has no card and no rail. ModSurface's chrome is
 * the title row (the drawer's own title is for the screen reader), and the
 * body scrolls under it.
 *
 * Nothing in it takes focus on open: a panel is something to read first, and
 * on Android a focused field would raise the keyboard over it. An item opened
 * from it (an `itemRef` row, a held `openItem`, a held nav step) closes it
 * first, so two drawers never stack. A mod deleted, or a panel gone from its
 * manifest, closes it, as the rail does; switched off, it says so.
 */
export function ModSheet() {
  const ref = useModSheet((s) => s.ref);
  const stale = useModsStore((s) => {
    if (!ref) return false;
    const row = s.rows.find((r) => r.id === ref.modId && r.kind === 'mod');
    return !row || !panelOf(row, ref.panelId);
  });
  const name = useModsStore((s) => {
    const row = ref ? s.rows.find((r) => r.id === ref.modId) : undefined;
    return row ? modDisplayLabel(row) : 'Your mod';
  });

  useEffect(() => {
    if (stale) close();
  }, [stale]);

  return (
    <Drawer open={!!ref && !stale} onOpenChange={(o) => !o && close()}>
      <DrawerContent
        data-testid="mod-sheet"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DrawerTitle className="sr-only">{`${name}, your mod`}</DrawerTitle>
        {ref && <ModSurface panelRef={ref} presentation="sheet" onLeave={close} />}
      </DrawerContent>
    </Drawer>
  );
}
