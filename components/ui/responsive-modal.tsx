'use client';

import * as React from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';

/**
 * A modal that renders a centered shadcn Dialog on desktop and a vaul bottom
 * Drawer on mobile, sharing the exact same children. Lets a single dialog be a
 * premium bottom sheet on phones without forking its content. Desktop output is
 * byte-identical to the plain Dialog (same components, same props).
 */
const MobileCtx = React.createContext(false);

function ResponsiveModal({
  open,
  onOpenChange,
  isMobile,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * For callers that mount this fresh per open (ItemDialog's wrapper): pin the
   * breakpoint from a hook instance that has already settled. useIsMobile
   * starts undefined and settles in an effect, so a freshly-mounted modal
   * would first-commit the desktop Dialog open, then swap Root to the Drawer —
   * tearing down and rebuilding the entire open surface on a phone. Callers
   * that stay mounted across opens can omit it.
   */
  isMobile?: boolean;
  children: React.ReactNode;
}) {
  const settledIsMobile = useIsMobile();
  const mobile = isMobile ?? settledIsMobile;
  const Root = mobile ? Drawer : Dialog;
  return (
    <MobileCtx.Provider value={mobile}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </MobileCtx.Provider>
  );
}

/** Kills the enter animation on a sheet/card and its scrim. `!` because vaul's
 *  own keyframes sit on attribute selectors that outrank a utility. */
const NO_ENTER = 'data-[state=open]:!animate-none';

/** `className` styles the desktop DialogContent; mobile is a bottom sheet with
 *  its own scroll + safe-area. Extra props (onKeyDown, etc.) pass to both.
 *  `overlayClassName` is desktop-only — the drawer keeps the shared scrim (only
 *  `instant` reaches it).
 *  `instant` skips the enter animation on both, for a surface that is taking
 *  over from one already on screen (the "new" dialog's type switch). */
function ResponsiveModalContent({
  className,
  children,
  overlayClassName,
  instant = false,
  ...props
}: React.ComponentProps<typeof DialogContent> & { instant?: boolean }) {
  const isMobile = React.useContext(MobileCtx);
  if (isMobile) {
    return (
      <DrawerContent
        className={instant ? NO_ENTER : undefined}
        overlayClassName={instant ? NO_ENTER : undefined}
        {...props}
      >
        <div className="overflow-y-auto overflow-x-hidden px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
          {children}
        </div>
      </DrawerContent>
    );
  }
  return (
    <DialogContent
      className={cn(className, instant && NO_ENTER)}
      overlayClassName={cn(overlayClassName, instant && NO_ENTER)}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

function ResponsiveModalHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const isMobile = React.useContext(MobileCtx);
  const C = isMobile ? DrawerHeader : DialogHeader;
  return <C className={cn(isMobile && 'px-0 text-left', className)} {...props} />;
}

function ResponsiveModalTitle({ className, ...props }: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = React.useContext(MobileCtx);
  const C = isMobile ? DrawerTitle : DialogTitle;
  return <C className={className} {...props} />;
}

function ResponsiveModalDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = React.useContext(MobileCtx);
  const C = isMobile ? DrawerDescription : DialogDescription;
  return <C className={className} {...props} />;
}

function ResponsiveModalFooter({ className, ...props }: React.ComponentProps<'div'>) {
  const isMobile = React.useContext(MobileCtx);
  if (isMobile) return <div className={cn('mt-4 flex', className)} {...props} />;
  return <DialogFooter className={className} {...props} />;
}

export {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
};
