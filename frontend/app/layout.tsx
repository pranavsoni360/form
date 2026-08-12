import "./globals.css";
import type { Metadata } from "next";
import { Sen, Plus_Jakarta_Sans, DM_Sans, JetBrains_Mono, Public_Sans, IBM_Plex_Mono } from "next/font/google";

import { Providers } from "./providers";

const sen = Sen({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "700", "800"],
  variable: "--font-sans",
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-heading",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-mono-loan",
});

// ── Finix design-language fonts (design_handoff_finix). Two weights only. ──
const publicSans = Public_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500"],
  variable: "--font-public-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "LOS — Loan Origination System",
  description:
    "Multi-bank loan origination + voice-agent ops console. Powered by Finix.",
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
      className={`${sen.variable} ${plusJakarta.variable} ${dmSans.variable} ${jetbrainsMono.variable} ${publicSans.variable} ${plexMono.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function() {
              try {
                var t = localStorage.getItem('los-theme');
                if (t === 'dark') document.documentElement.classList.add('dark');
                // Finix theme (bank-admin portal): dark default, persisted under
                // 'finix.theme'. Set data-theme pre-paint to avoid a flash.
                var f = localStorage.getItem('finix.theme');
                document.documentElement.setAttribute('data-theme', f === 'light' ? 'light' : 'dark');
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
