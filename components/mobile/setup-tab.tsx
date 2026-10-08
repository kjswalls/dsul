'use client';

import type { ReactNode } from 'react';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { ConnectAI } from '@/components/ai/connect/connect-ai';
import { useRefreshOnWindowFocus } from '@/components/ai/connect/connect-shared';
import {
  FixHome,
  SetupFoot,
  SetupPreviews,
  YourQuestion,
  setupWord,
  useComposerRequestDropped,
  useSetupKind,
} from '@/components/ai/rail/ask-setup';
import { SurfaceHeader } from '@/components/primitives/surface-header';
import { useKeptQuestion } from '@/lib/ask-pending';

/** How many things it could ask the phone's page previews, under the key card. */
const PHONE_PREVIEWS = 2;

/**
 * The phone's Ask tab while nothing answers but the AI gate offers to set AI
 * up (`askInvite`) or to fix a saved model (`askFix`): the desktop's setup
 * column (components/ai/rail/ask-setup.tsx) laid out as a tab, from the same
 * pieces. The shell mounts it in AskTab's place (components/shell/
 * mobile-shell.tsx), and the moment something answers the tab is Ask again,
 * the phone's stack popped home by the connect that did it.
 *
 *  - Header: the capsule with the word ("Set up AI", "Fix AI") and the user
 *    menu (`headerAccessory`), as Ask's own capsule draws it (F17). No ✕:
 *    the tab is the way out, and the dock keeps its omnibar here.
 *  - Setup home, the key card leading: the greeting, YOUR QUESTION when one
 *    was brought from `?` (above the card, so the consent line's "your
 *    question" is on screen with it), the card and its folds, then two
 *    previews of what could be asked (none while a question is kept), Good
 *    to know, and at the end of the page the foot's line and No AI, thanks.
 *  - Fix home: the desktop's (connect-fix.tsx), under "Fix AI".
 *
 * Not Ask: no `data-ask-tab` or `data-ask-home` (those mean Ask is on
 * screen), no item interceptor, no conversation list warmed, nothing parked
 * by Escape, no heading taking focus on arrival, and nothing in it is lime.
 */
export function SetupTab({ headerAccessory }: { headerAccessory?: ReactNode }) {
  const kind = useSetupKind();
  const kept = useKeptQuestion();
  // The desktop app at a phone's width: a sign-in finished in the browser
  // lands while this window sits behind it.
  useRefreshOnWindowFocus();
  useComposerRequestDropped(true);

  return (
    <div data-setup-tab={kind} className="flex h-full min-h-0 flex-col gap-2">
      <SurfaceHeader title={setupWord(kind)} className="mx-[10px]">
        {headerAccessory}
      </SurfaceHeader>
      <div data-setup-scroller="" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-1 pb-5">
        <AskGreeting variant="home" />
        {kind === 'fix' ? (
          <FixHome />
        ) : (
          <>
            {kept && <YourQuestion question={kept} focusAfter="key" />}
            <ConnectAI
              host="column"
              layout="phone"
              afterFolds={kept ? null : <SetupPreviews max={PHONE_PREVIEWS} />}
            />
          </>
        )}
        <SetupFoot phone />
      </div>
    </div>
  );
}
