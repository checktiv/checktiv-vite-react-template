/**
 * What this teaches / copy this pattern:
 * The shadcn/ui `cn()` helper - merge conditional class lists with `clsx`,
 * then resolve conflicting Tailwind utility classes (e.g. a caller's
 * `className` prop overriding a primitive's own default spacing/color) with
 * `tailwind-merge`. Every component under `components/ui/**` composes its
 * classes through this single helper.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class-list inputs, letting later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
