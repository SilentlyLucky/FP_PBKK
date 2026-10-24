"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export const MenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(({ className, sideOffset = 6, align = "start", ...props }, ref) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      collisionPadding={12}
      className={cn(
        "z-[80] min-w-[220px] max-w-[min(340px,calc(100vw-24px))] rounded-[14px] border border-border-strong bg-surface p-1.5 text-foreground shadow-[var(--shadow-float)]",
        className,
      )}
      {...props}
    />
  </DropdownMenu.Portal>
));
MenuContent.displayName = "MenuContent";

export const MenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Label
    ref={ref}
    className={cn(
      "px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground",
      className,
    )}
    {...props}
  />
));
MenuLabel.displayName = "MenuLabel";

const itemClass =
  "flex min-h-9 cursor-pointer items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-muted-foreground data-[disabled]:opacity-70";

export const MenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(itemClass, className)}
    {...props}
  />
));
MenuItem.displayName = "MenuItem";

export const MenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem> & {
    description?: React.ReactNode | undefined;
  }
>(({ className, children, description, ...props }, ref) => (
  <DropdownMenu.RadioItem
    ref={ref}
    className={cn(itemClass, className)}
    {...props}
  >
    <span className="min-w-0 flex-1">
      <span className="block font-medium">{children}</span>
      {description ? (
        <span className="mt-px block text-xs leading-snug text-muted-foreground">
          {description}
        </span>
      ) : null}
    </span>
    <DropdownMenu.ItemIndicator className="mt-0.5 inline-grid size-4 shrink-0 place-items-center text-accent-text">
      <Check aria-hidden="true" size={15} strokeWidth={2} />
    </DropdownMenu.ItemIndicator>
  </DropdownMenu.RadioItem>
));
MenuRadioItem.displayName = "MenuRadioItem";

export const MenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Separator
    ref={ref}
    className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
    {...props}
  />
));
MenuSeparator.displayName = "MenuSeparator";
