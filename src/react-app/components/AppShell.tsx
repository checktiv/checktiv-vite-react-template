/**
 * What this teaches / copy this pattern:
 * The staff shell every staff route wraps itself in. Wrapping happens INSIDE
 * each route's own default export (e.g.
 * `export default function ReservationDetailPage() { return <AppShell>
 * ...</AppShell> }`), never at the router level in `main.tsx`.
 *
 * AppShell stays a plain, prop-driven layout component - it does not import
 * `lib/reservation-store.ts` itself (dependency injection over singleton
 * imports), so it builds and tests in isolation:
 *   - The "sample app, no sign-in" notice is a fixed, ALWAYS-shown banner.
 *     Every staff page renders this shell, so this is the one place that
 *     guarantees the notice is never missed. It names the two things a visitor
 *     must know before typing anything real: these pages have no sign-in, and
 *     the data goes somewhere unprotected.
 *   - `onResetDemo`, when passed, renders the "Reset demo" self-serve action
 *     that wipes ALL demo state on this browser (the entered Checktiv keys +
 *     bookings + guest check-in links) and returns the visitor to Setup - a
 *     full reset, not just a data wipe. The CALLER decides whether to pass it
 *     (typically only when `import.meta.env.VITE_PERSISTENCE === "local"`, i.e.
 *     the deployed demo), so this component has no compile-time dependency on
 *     the config / reservation-store modules.
 */
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Footer } from "./Footer";
import { Button } from "./ui/button";

export function AppShell({
	children,
	onResetDemo,
}: {
	children: ReactNode;
	/** Reset ALL demo state (keys + bookings + check-in links) and return to Setup. Omit to hide the action (e.g. local D1 dev). */
	onResetDemo?: () => void;
}) {
	return (
		// Full-height app shell as a single column: a full-width demo notice, then a
		// `flex-1` body row (sidebar + content) so the sidebar fills the viewport
		// height, then a full-width footer pinned to the bottom of the window. The
		// column is `min-h-svh` so short pages still push the footer to the bottom
		// while long pages scroll the whole page (classic sticky-footer layout).
		<div className="flex min-h-svh flex-col bg-background text-foreground">
			{/* Global demo notice: a full-width strip across the top of the window. */}
			<div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
				<strong className="font-medium">Sample app, not production.</strong> These pages have
				no sign-in and anyone with the link can open them. Use fake guest details only.
			</div>
			{/* Body: the sidebar and content column. `flex-1` + `min-h-0` lets it fill
			    the space between the notice and the footer, so the sidebar stretches to
			    full height (it no longer sets its own `h-full`). */}
			<div className="flex min-h-0 flex-1">
				<Sidebar />
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex items-center justify-between border-b border-border px-6 py-3">
						<span className="text-sm font-semibold">Checktiv PMS demo</span>
						{onResetDemo ? (
							<Button variant="outline" size="sm" onClick={onResetDemo}>
								Reset demo
							</Button>
						) : null}
					</header>
					<main className="flex-1 p-6">{children}</main>
				</div>
			</div>
			{/* Full-width page footer (spans the whole window, not just the content column). */}
			<Footer />
		</div>
	);
}
