import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";

interface StatusPillProps extends Omit<BadgeProps, "children"> {
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  label: string;
  dot?: boolean;
}

const TONE_MAP = {
  success: { variant: "success" as const, dot: "bg-success" },
  warning: { variant: "warning" as const, dot: "bg-warning" },
  danger: { variant: "destructive" as const, dot: "bg-destructive" },
  info: { variant: "info" as const, dot: "bg-info" },
  neutral: { variant: "secondary" as const, dot: "bg-muted-foreground" },
};

/**
 * Filled status pill with optional leading dot. Wraps shadcn Badge so we get
 * focus rings + a11y for free.
 */
export function StatusPill({ tone, label, dot = true, className, ...rest }: StatusPillProps) {
  const meta = TONE_MAP[tone];
  return (
    <Badge variant={meta.variant} className={cn("gap-1.5", className)} {...rest}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />}
      <span>{label}</span>
    </Badge>
  );
}
