/**
 * What this teaches / copy this pattern:
 * The app's single router. It registers the FULL route table with lazily
 * imported page components (`React.lazy(() => import("./routes/<Page>"))`), so
 * each page is code-split into its own chunk and loaded on demand.
 *
 * How routing is structured:
 *   - Each route maps a final path to a page's DEFAULT export.
 *   - The app shell (sidebar/header) is applied INSIDE each staff page's own
 *     default export (e.g. `<AppShell>...</AppShell>`), never as a router-level
 *     wrapper here. Keeping the shell inside each page means a page is
 *     self-contained and readable on its own, without tracing wrappers back to
 *     the router. `SetupPage` is unshelled; `CheckInPage` is the guest journey.
 *   - There is no route guard, because this demo has no authentication: every
 *     page is reachable by any visitor. See the "NO AUTHENTICATION" note in
 *     `src/worker/index.ts` for what that means on the API side.
 */
/*
 * This is the application ENTRY (it calls `createRoot(...).render(...)`), not a
 * fast-refresh component boundary: it defines the lazy route table alongside the
 * bootstrap side effect. `react-refresh/only-export-components` only applies to
 * component modules, so it is disabled for this file.
 */
/* eslint-disable react-refresh/only-export-components */
import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";

const SetupPage = lazy(() => import("./routes/SetupPage"));
const ReservationsPage = lazy(() => import("./routes/ReservationsPage"));
const ReservationDetailPage = lazy(() => import("./routes/ReservationDetailPage"));
const CheckInPage = lazy(() => import("./routes/CheckInPage"));

/** Wrap a lazily loaded page in a Suspense fallback shared by every route. */
function withSuspense(node: ReactNode): ReactNode {
	return <Suspense fallback={<div className="p-6 text-muted-foreground">Loading...</div>}>{node}</Suspense>;
}

const router = createBrowserRouter([
	{ path: "/", element: <Navigate to="/reservations" replace /> },
	{ path: "/setup", element: withSuspense(<SetupPage />) },
	{ path: "/reservations", element: withSuspense(<ReservationsPage />) },
	{ path: "/reservations/:id", element: withSuspense(<ReservationDetailPage />) },
	{ path: "/checkin/:id", element: withSuspense(<CheckInPage />) },
	// Catch-all. Without it React Router renders its own unstyled
	// "Unexpected Application Error! 404 Not Found" boundary for any unmatched
	// path: a dead end wearing none of this app's chrome, which is exactly what
	// the no-dead-end rule exists to prevent. The Worker already answers unknown
	// NON-`/api` paths with `index.html` (`not_found_handling:
	// "single-page-application"`), so the SPA is what decides, and it should send
	// the visitor somewhere real rather than to a framework error.
	//
	// `/login` is why this is not hypothetical. It was a real route until the
	// staff-auth removal, so a bookmark or an old link still points at it.
	{ path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
