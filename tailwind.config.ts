/**
 * What this teaches / copy this pattern:
 * Tailwind v4 is CSS-first: the theme tokens and dark-mode variant live in
 * `src/react-app/index.css` (`@theme inline`, `@custom-variant dark`), and
 * `@tailwindcss/vite` auto-detects template sources. This file therefore stays
 * intentionally minimal. It is kept for tooling that still reads a config
 * (editor IntelliSense, shadcn CLI expectations) and to make the content globs
 * and class-based dark mode explicit for humans skimming the repo. Add real theme
 * extensions in index.css (not here) so there is a single source of truth.
 */
import type { Config } from "tailwindcss";

export default {
	darkMode: "class",
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
} satisfies Config;
