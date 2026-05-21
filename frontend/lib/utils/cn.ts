import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes safely — last-write-wins on conflicts.
 * Used by every shadcn primitive in components/ui/*.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
