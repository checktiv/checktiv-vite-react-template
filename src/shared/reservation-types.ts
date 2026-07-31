/**
 * What this teaches / copy this pattern:
 * These reservation types are HAND-AUTHORED on purpose. They are the shared shape
 * used by the browser store, the Worker route layer, and the UI.
 *
 * Client-bundle boundary: do NOT derive these from Drizzle
 * (`InferSelectModel` / `$inferSelect` off `src/worker/db/schema.ts`). Nothing under
 * `src/react-app/**` may import `drizzle-orm` or the DB schema - not even type-only,
 * because a single-file transpile does not reliably elide a plain import and the
 * Drizzle table DDL would then leak into the client bundle. The Worker route layer
 * maps Drizzle rows -> these plain types at the DB boundary; the browser never sees
 * schema code.
 */

/** Demo-domain reservation lifecycle (distinct from Checktiv's own session status). */
export type ReservationStatus = "draft" | "invited" | "verifying" | "complete";

/** A reservation as stored and rendered. `sessionId` links to the Checktiv session. */
export interface Reservation {
	id: string;
	guestName: string;
	guestEmail: string;
	property: string;
	/** ISO date string (YYYY-MM-DD). */
	checkIn: string;
	/** ISO date string (YYYY-MM-DD). */
	checkOut: string;
	/** Present once a verification session has been minted for this reservation. */
	sessionId?: string;
	status: ReservationStatus;
}

/** Fields accepted when creating a reservation. `id`/`status` are assigned by the store. */
export interface NewReservation {
	guestName: string;
	guestEmail: string;
	property: string;
	checkIn: string;
	checkOut: string;
	status?: ReservationStatus;
	sessionId?: string;
}
