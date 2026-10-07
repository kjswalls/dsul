'use client';

import { toast } from 'sonner';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { organizeEnabled } from '@/lib/extension-gates';
import { openConsole } from '@/lib/console-door';
import { lookById } from '@/lib/looks';
import { isUserLookRef, userLookByRef } from '@/lib/user-looks';
import type { SettingCtx } from '@/lib/settings/manifest';
import type { RecipeUiStep } from './validate';

/**
 * The closed list of things a recipe may do to the app around the items
 * (memory/plans/mods.md, "Recipes"): toast, go to a view, open Organize, set a
 * theme, apply a Look. Every argument is a closed enum the schema parsed, and
 * this switch has no default, so a new step kind is a compile error here.
 *
 * Run AFTER the run's history batch, never inside it, so no navigation happens
 * while the entry is open.
 *
 * The theme and Look steps load the settings manifest when they run, not when
 * this module loads: the engine mounts in the root layout (RecipeHost), and the
 * manifest is the whole settings surface, which every other route would
 * otherwise carry.
 */

function withManifest(fn: (m: typeof import('@/lib/settings/manifest')) => void): void {
  import('@/lib/settings/manifest')
    .then(fn)
    .catch((err) => console.error('[recipes] theme step failed:', err));
}

export interface UiStepDeps {
  /** Client navigation, from the component that mounted the engine. */
  navigate: (href: string) => void;
}

function settingCtx(): SettingCtx {
  // The theme records' writes read only userId; `theme` and `setTheme` belong
  // to the light/dark/system switch, which no recipe step reaches.
  return { theme: undefined, setTheme: () => {}, userId: usePlannerStore.getState().userId };
}

export function runUiStep(step: RecipeUiStep, recipeLabel: string, deps: UiStepDeps): void {
  switch (step.do) {
    case 'toast':
      // The recipe's name is host chrome: the recipe's text cannot remove it.
      toast(step.text, { description: `Recipe: ${recipeLabel}` });
      return;
    case 'goto': {
      const view = useViewStore.getState();
      view.setScope(step.scope);
      view.setLayout(step.layout);
      return;
    }
    case 'organize':
      if (organizeEnabled()) openConsole({}, deps.navigate);
      return;
    case 'setTheme':
      // The record's own paired write (look store + user_settings).
      withManifest((m) =>
        m.settingById(step.mode === 'light' ? 'look.lightTheme' : 'look.darkTheme')?.write(step.theme, settingCtx())
      );
      return;
    case 'applyLook': {
      const preset = lookById(step.look);
      if (preset) withManifest((m) => m.applyLook(preset, settingCtx()));
      else if (isUserLookRef(step.look)) {
        // Looked up after the import, so a Look switched off or deleted in the
        // meantime (or held back by safe mode) does nothing.
        withManifest((m) => {
          const own = userLookByRef(step.look);
          if (own) m.applyUserLook(own, settingCtx());
        });
      }
      return;
    }
  }
}
