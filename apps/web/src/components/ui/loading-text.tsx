import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

interface LoadingTextProps {
  children: ReactNode;
  className?: string;
}

export function LoadingText({ children, className }: LoadingTextProps) {
  return <span className={cn("shimmer shimmer-spread-200", className)}>{children}</span>;
}
