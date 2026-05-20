"use client";

import { Badge } from "@/components/ui/badge";
import { ConnectionDot } from "./ConnectionDot";

export function TopBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const env = process.env.NEXT_PUBLIC_LOS_ENV || "dev";
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-background/80 px-8 backdrop-blur-xl">
      <div className="flex flex-col leading-none">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-4">
        <ConnectionDot />
        <span className="h-4 w-px bg-border" aria-hidden />
        <Badge
          variant={env === "prod" ? "destructive" : env === "staging" ? "warning" : "secondary"}
          className="font-mono text-[10px] uppercase"
        >
          {env}
        </Badge>
      </div>
    </header>
  );
}
