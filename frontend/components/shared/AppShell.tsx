"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="finix-root flex min-h-screen" style={{ background: "var(--fx-bg)" }}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col md:py-3 md:pr-3">
        <div
          className="flex min-h-screen md:min-h-[calc(100vh-24px)] flex-col md:rounded-[18px]"
          style={{ background: "var(--fx-surface)" }}
        >
          <TopBar />
          <main className="flex flex-1 flex-col gap-3 px-3 pb-4 pt-4 sm:px-4 md:gap-4 md:px-[18px] md:pt-5">
            <div key={pathname} className="fx-page-enter flex flex-1 flex-col gap-3 md:gap-4">
              <div>
                <h1
                  className="text-[20px] font-medium leading-snug"
                  style={{ color: "var(--fx-text)", letterSpacing: "-0.02em" }}
                >
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-0.5 text-[13px]" style={{ color: "var(--fx-text2)" }}>
                    {subtitle}
                  </p>
                )}
              </div>
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
