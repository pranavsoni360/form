import "./globals.css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "LOS — Loan Origination System",
  description:
    "Multi-bank loan origination + voice-agent ops console. Powered by Vaani.",
};

/**
 * Root layout. Mounts Geist fonts, light/dark CSS variables, and the global
 * client providers (QueryClient, Realtime, Toaster).
 *
 * Legacy pages: light by default; users can opt into dark via the existing
 * `los-theme` localStorage flag (inline script below — kept verbatim).
 *
 * New ops pages: force dark by wrapping their subtree in `<div className="dark">`
 * inside `components/shared/AppShell.tsx`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function() {
              try {
                var t = localStorage.getItem('los-theme');
                if (t === 'dark') document.documentElement.classList.add('dark');
              } catch(e) {}
            })();`,
          }}
        />
      </head>
      <body className="bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
