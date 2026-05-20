import "./globals.css";
import type { Metadata } from "next";
import { Sen } from "next/font/google";

import { Providers } from "./providers";

// Sen — matches the VirtualVaani master frontend + login/dashboard screenshots.
// Self-hosted via next/font (no runtime Google Fonts call). Used for both UI
// and tabular numbers (Sen has OpenType `tnum` feature, enabled via the
// .font-mono utility in globals.css).
const sen = Sen({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "700", "800"],
  variable: "--font-sans",
});

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
      className={sen.variable}
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
