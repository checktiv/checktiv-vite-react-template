/**
 * What this teaches / copy this pattern:
 * The app's single router. It registers the FULL route table with lazily
 * imported page components (`React.lazy(() => import("./routes/<Page>"))`), so
 * each page is code-split into its own chunk and loaded on demand.
 *
 * How routing is structured:
 *   - Each route maps a final path to a page's DEFAULT export.
 *   - Auth guarding and the app shell (sidebar/header) are applied INSIDE each
 *     staff page's own default export (e.g. `<GuardedRoute><AppShell>...`), never
 *     as router-level wrappers here. Keeping the guard and shell inside each page
 *     means a page is self-contained and readable on its own, without tracing
 *     wrappers back to the router. `SetupPage` and `LoginPage` are
 *     unguarded/unshelled; `CheckInPage` is the unauthenticated guest journey.
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
const LoginPage = lazy(() => import("./routes/LoginPage"));
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
	{ path: "/login", element: withSuspense(<LoginPage />) },
	{ path: "/reservations", element: withSuspense(<ReservationsPage />) },
	{ path: "/reservations/:id", element: withSuspense(<ReservationDetailPage />) },
	{ path: "/checkin/:id", element: withSuspense(<CheckInPage />) },
]);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
