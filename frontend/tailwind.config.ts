import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    // Tremor content paths — required so its utility classes survive purge
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // ── shadcn semantic tokens (read from CSS variables in globals.css) ──
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        // VirtualVaani "solid" — dark navy button used in Admin chrome
        solid: {
          DEFAULT: "hsl(var(--solid))",
          foreground: "hsl(var(--solid-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // ── Retell-style semantic extras ──
        surface: "hsl(var(--surface))",
        elevated: "hsl(var(--elevated))",
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        // ── Tremor color tokens (uses shadcn vars under the hood) ──
        tremor: {
          brand: {
            faint: "hsl(var(--primary) / 0.1)",
            muted: "hsl(var(--primary) / 0.25)",
            subtle: "hsl(var(--primary) / 0.6)",
            DEFAULT: "hsl(var(--primary))",
            emphasis: "hsl(var(--primary))",
            inverted: "hsl(var(--primary-foreground))",
          },
          background: {
            muted: "hsl(var(--muted))",
            subtle: "hsl(var(--surface))",
            DEFAULT: "hsl(var(--background))",
            emphasis: "hsl(var(--foreground))",
          },
          border: { DEFAULT: "hsl(var(--border))" },
          ring: { DEFAULT: "hsl(var(--ring))" },
          content: {
            subtle: "hsl(var(--muted-foreground))",
            DEFAULT: "hsl(var(--foreground) / 0.7)",
            emphasis: "hsl(var(--foreground) / 0.9)",
            strong: "hsl(var(--foreground))",
            inverted: "hsl(var(--background))",
          },
        },
        // ── Legacy tokens (so existing pages don't break) ──
        dark: {
          card: "#1a1f2e",
          input: "#1e2433",
          section: "#161b27",
          bg: "#0f1320",
        },
        // ── Finix design-language tokens (oklch, see globals.css .finix-root).
        //    Namespaced `fx-*` so they never collide with the shadcn tokens;
        //    every value is `var(--fx-*)` resolved per data-theme. ──
        fx: {
          bg: "var(--fx-bg)",
          surface: "var(--fx-surface)",
          surface2: "var(--fx-surface2)",
          border: "var(--fx-border)",
          "border-strong": "var(--fx-border-strong)",
          text: "var(--fx-text)",
          text2: "var(--fx-text2)",
          text3: "var(--fx-text3)",
          accent: "var(--fx-accent)",
          green: "var(--fx-green)",
          amber: "var(--fx-amber)",
          orange: "var(--fx-orange)",
          red: "var(--fx-red)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-sans)", "ui-monospace", "monospace"],
        heading: ["var(--font-heading)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        "mono-loan": ["var(--font-mono-loan)", "ui-monospace", "monospace"],
      },
      fontSize: {
        // Slightly tighter line-heights for dashboard density
        "kpi": ["2.25rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "600" }],
      },
      boxShadow: {
        "glass": "0 1px 0 0 hsl(var(--border)), 0 8px 24px -12px rgb(0 0 0 / 0.5)",
        "glow-primary": "0 0 0 1px hsl(var(--primary) / 0.5), 0 8px 24px -8px hsl(var(--primary) / 0.3)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // Legacy keyframes from old globals.css — kept so existing pages still animate
        "fadeIn": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "shake": {
          "0%, 100%": { transform: "translateX(0)" },
          "20%": { transform: "translateX(-4px)" },
          "40%": { transform: "translateX(4px)" },
          "60%": { transform: "translateX(-3px)" },
          "80%": { transform: "translateX(3px)" },
        },
        "shrink": { from: { width: "100%" }, to: { width: "0%" } },
        "slideDown": {
          from: { opacity: "0", transform: "translateY(-20px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(0.95)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fadeIn 0.3s ease-out",
        "shake": "shake 0.4s ease-in-out",
        "shrink": "shrink 30s linear",
        "slide-down": "slideDown 0.3s ease-out",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
