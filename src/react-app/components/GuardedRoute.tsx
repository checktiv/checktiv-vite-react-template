/**
 * What this teaches / copy this pattern:
 * Guarding is applied INSIDE each staff page's own default export (see the
 * routing note in `main.tsx`), never as router-level wrapping - e.g.
 * `export default function ReservationsPage() { return <GuardedRoute><AppShell>
 * ...</AppShell></GuardedRoute> }`. `<GuardedRoute>` itself just asks
 * `useSession()` (`lib/auth-client.ts`) whether the browser has a valid staff
 * cookie and redirects to `/login` if not, carrying the current location so
 * `LoginPage` can send the visitor back where they were headed.
 */
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../lib/auth-client";

export function GuardedRoute({ children }: { children: ReactNode }) {
	const { status } = useSession();
	const location = useLocation();

	if (status === "loading") {
		return <div className="p-6 text-muted-foreground">Loading...</div>;
	}
	if (status === "unauthenticated") {
		return <Navigate to="/login" replace state={{ from: location.pathname }} />;
	}
	return <>{children}</>;
}
