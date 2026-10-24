import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-3.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary)_88%,var(--foreground))] disabled:bg-raised disabled:text-muted-foreground",
        secondary:
          "border border-border-strong bg-transparent text-foreground hover:bg-hover disabled:border-border disabled:text-muted-foreground",
        ghost:
          "text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-60",
        danger:
          "border border-[color-mix(in_srgb,var(--danger)_45%,var(--border))] bg-danger-soft text-danger-text hover:bg-[color-mix(in_srgb,var(--danger)_26%,transparent)] disabled:opacity-60",
      },
      size: {
        default: "h-11",
        sm: "h-11 px-3 text-xs",
        icon: "size-11 shrink-0 p-0",
        pill: "h-11 rounded-full px-4",
        iconRound: "size-11 shrink-0 rounded-full p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
