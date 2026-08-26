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

                // Finix theme, persisted under 'finix.theme' and applied to
                // <html data-theme> pre-paint so the oklch token layer resolves
                // without a flash.
                //
                // MIGRATION SEEDING: the Finix spec defaults to dark, but the
                // live app has always been light-by-default via 'los-theme'.
                // Flipping every migrated screen to dark on deploy day would
                // change the theme under users who never asked for it, so the
                // first time we see no 'finix.theme' we seed it from the
                // legacy key: los-theme==='dark' -> dark, anything else
                // (including unset) -> light. After that the user's Finix
                // ThemePill owns the value and this branch never runs again.
                // 'los-theme' stays live for the not-yet-migrated public
                // forms, which still use the legacy ThemeToggle.
                var f = localStorage.getItem('finix.theme');
                if (f !== 'light' && f !== 'dark') {
                  f = (t === 'dark') ? 'dark' : 'light';
                  localStorage.setItem('finix.theme', f);
                }
                document.documentElement.setAttribute('data-theme', f);
                // Keep the legacy .dark class in lockstep with the resolved
                // Finix theme so the old unscoped ".dark input" rules never
                // paint Finix inputs black in light mode (and vice-versa).
                document.documentElement.classList.toggle('dark', f === 'dark');
              } catch(e) {
                // Storage blocked (private mode): fall back to light to match
                // the app's historical default rather than the spec default.
                try { document.documentElement.setAttribute('data-theme', 'light'); } catch(e2) {}
              }
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
