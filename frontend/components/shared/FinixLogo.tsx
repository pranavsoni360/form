/**
 * Finix brand logo — the real raster artwork (public/brand/*.png), trimmed to a
 * transparent background. Two ink variants ship so the navy wordmark/shield stay
 * legible on dark surfaces:
 *   • finix-{mark,lockup}.png       — navy + teal, for light surfaces
 *   • finix-{mark,lockup}-dark.png  — white + teal, for dark surfaces
 *
 * The variant is chosen by CSS keyed on <html data-theme> (see .fx-logo-* rules
 * in globals.css), so this works on ANY page — inside a FinixThemeProvider or on
 * the plain public pages — with no hook/context dependency and no hydration flash
 * (the pre-paint head script sets data-theme before first paint).
 *
 *   <FinixLogo height={34} />                 — shield mark only
 *   <FinixLogo variant="lockup" height={48} /> — mark + FINIX wordmark
 */
export function FinixLogo({
  variant = "mark",
  height = 34,
  className,
  alt = "Finix",
}: {
  variant?: "mark" | "lockup";
  height?: number;
  className?: string;
  alt?: string;
}) {
  const light = `/brand/finix-${variant}.png`;
  const dark = `/brand/finix-${variant}-dark.png`;
  // NB: `display` is controlled by the .fx-logo-{light,dark} CSS rules keyed on
  // <html data-theme> — do NOT set `display` inline here, or the inline style
  // (highest specificity) beats the CSS and BOTH variants render side by side.
  return (
    <span className={className} style={{ display: "inline-flex", height, lineHeight: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={light} alt={alt} className="fx-logo-light" style={{ height, width: "auto" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={dark} alt="" aria-hidden className="fx-logo-dark" style={{ height, width: "auto" }} />
    </span>
  );
}

/**
 * Finix shield logo mark — recreated from brand asset.
 * Shield stroke uses `currentColor` so it adapts to light/dark theme.
 * The teal arrow is always #00C4B4 (brand teal).
 *
 * Usage:
 *   <FinixLogoMark size={28} />                     — theme-aware shield
 *   <FinixLogoMark size={28} shieldColor="white" />  — force white shield (dark bg)
 *   <FinixLogoMark size={28} shieldColor="#1B2A4A" /> — force navy (light bg)
 */
export function FinixLogoMark({
  size = 32,
  shieldColor,
  arrowColor = "#00C4B4",
  className,
}: {
  size?: number;
  shieldColor?: string;
  arrowColor?: string;
  className?: string;
}) {
  const w = Math.round((size * 100) / 112);
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 100 112"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Shield outline */}
      <path
        d="M50 5L90 20L90 55C90 77 72 95 50 103C28 95 10 77 10 55L10 20Z"
        stroke={shieldColor ?? "currentColor"}
        strokeWidth="7"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Upward trend chart line */}
      <path
        d="M28 72L42 52L54 64L76 26"
        stroke={arrowColor}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Arrow head */}
      <path
        d="M67 20L77 27L71 38"
        stroke={arrowColor}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
