'use client';

import { useMemo } from 'react';
import { useModsStore } from '@/lib/mods-store';
import { cardPanelOf } from '@/lib/mods/ui/card';
import { ModSurface } from './mod-surface';

/**
 * The braindump's one mod card (memory/plans/mods.md, build order 9): the
 * card panel of the earliest-created switched-on mod that has one
 * (lib/mods/ui/card.ts), under the braindump on the desktop. Its parents
 * mount it only while the braindump is open (components/sidebar/sidebar.tsx,
 * not during a hover peek; components/shell/braindump-pane.tsx), so a closed
 * braindump draws nothing and resolves nothing. Never in safe mode, and never
 * on the phone, whose only mod surface is the sheet.
 *
 * A hairline and the host's mod glyph in the chrome set it apart from the
 * dock below. No opacity on it or its parents.
 */
export function ModCard() {
  const rows = useModsStore((s) => s.rows);
  const safeMode = useModsStore((s) => s.safeMode);
  const card = useMemo(() => (safeMode ? null : cardPanelOf(rows)), [rows, safeMode]);
  if (!card) return null;
  return (
    <div data-testid="mod-card" className="border-border min-w-[260px] flex-none border-t">
      <ModSurface panelRef={{ modId: card.modId, panelId: card.panelId }} presentation="card" />
    </div>
  );
}
