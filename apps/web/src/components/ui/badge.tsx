import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-[22px] items-center gap-1.5 rounded-full border border-transparent px-2.5 text-[12.5px] font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-accent-soft text-accent-text",
        success: "bg-success-soft text-success-text",
        warning: "bg-warning-soft text-warning-text",
        danger: "bg-danger-soft text-danger-text",
        muted: "bg-raised text-muted-foreground",
        graph: "bg-accent-soft text-accent-text",
      },
    },
    defaultVariants: { variant: "muted" },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
