'use client'

import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * THE RIGHT-CLICK THAT OPENS A MENU NEVER ALSO CHOOSES FROM IT.
 *
 * Chromium on Linux and macOS fires `contextmenu` on the button's DOWN (Windows
 * waits for the release). Radix opens the menu at the pointer, shifts one too
 * tall for the room below up onto the viewport's floor, and slides it in from
 * the pointer's side, so the release can land on a row — and Radix's MenuItem
 * selects on a pointerup it saw no pointerdown for (its press-drag-release
 * gesture). Letting go of the button picked whatever row was under it: a task
 * moved to tomorrow on a plain right-click.
 *
 * So the trigger notes where a press that is still held opened the menu, and
 * the content defuses that press's release while it is still part of the
 * click: near where it went down, or soon after. A press held and steered onto
 * a row, further and longer than that, still selects, as a native menu's does.
 * Any new press ends the watch, and a menu opened with no button held (Windows,
 * the menu key, Shift+F10) never starts one, so left clicks and the keyboard
 * are untouched. tests/e2e/context-menu-release.spec.ts clicks for real.
 *
 * Defused is preventDefault(), which every Radix row honours, and never
 * stopPropagation(): a Mac's Ctrl+click is a LEFT press that dnd-kit is
 * holding as a pending drag of the row, and it lets go only on document's
 * pointerup. Hide the release from that and the row drags off after the menu.
 */
type OpeningPress = { x: number; y: number; at: number }

const OpeningPressContext =
  React.createContext<React.RefObject<OpeningPress | null> | null>(null)

/** Within either, the opening press's release is still the click that opened the menu. */
const OPENING_RELEASE_SLOP_PX = 8
const OPENING_RELEASE_MS = 300

function isOpeningClick(press: OpeningPress, release: React.PointerEvent) {
  const travelled = Math.hypot(release.clientX - press.x, release.clientY - press.y)
  return (
    travelled <= OPENING_RELEASE_SLOP_PX ||
    release.timeStamp - press.at <= OPENING_RELEASE_MS
  )
}

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  const openingPressRef = React.useRef<OpeningPress | null>(null)
  return (
    <OpeningPressContext.Provider value={openingPressRef}>
      <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
    </OpeningPressContext.Provider>
  )
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuTrigger({
  onContextMenu,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  const openingPressRef = React.useContext(OpeningPressContext)
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      onContextMenu={(event) => {
        onContextMenu?.(event)
        if (!openingPressRef) return
        // A button still down means the menu opened on the press, and its release is still to come.
        openingPressRef.current =
          event.buttons === 0
            ? null
            : { x: event.clientX, y: event.clientY, at: event.timeStamp }
      }}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  onPointerDownCapture,
  onPointerUpCapture,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const openingPressRef = React.useContext(OpeningPressContext)
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        // Capture, so it runs before any row's own handlers (submenus included: portalled, still descendants).
        onPointerDownCapture={(event) => {
          // A new press: the one that opened the menu is over.
          if (openingPressRef) openingPressRef.current = null
          onPointerDownCapture?.(event)
        }}
        onPointerUpCapture={(event) => {
          const press = openingPressRef?.current
          if (openingPressRef && press) {
            openingPressRef.current = null
            if (isOpeningClick(press, event)) event.preventDefault()
          }
          onPointerUpCapture?.(event)
        }}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        'px-2 py-1.5 text-sm font-medium data-[inset]:pl-8',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        'text-muted-foreground ml-auto text-xs tracking-widest',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  // Portalled for the same reason as components/ui/dropdown-menu.tsx: to escape the parent ContextMenuContent's clip. That content sets
  // `overflow-x-hidden overflow-y-auto` (for its own max-height scroll), and the
  // submenu's Popper wrapper otherwise renders as a DOM descendant of it. Radix
  // Popper positions with `position: fixed`, but the parent wrapper carries a
  // `transform`, which makes it the containing block — so the fixed submenu is
  // clipped through the parent's overflow box and paints nowhere. Portalling
  // lifts the submenu out of that subtree; Radix keeps hover/keyboard wiring via
  // refs, not DOM containment, so it is unaffected.
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export {
  ContextMenu,
  ContextMenuPortal,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
}
