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
