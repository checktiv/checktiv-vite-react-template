/**
 * What this teaches / copy this pattern:
 * The Drizzle table definition for reservations. WORKER-ONLY: nothing under
 * `src/react-app/**` may import this file or `drizzle-orm` - not even
 * type-only (a single-file transpile does not reliably elide a plain import,
 * so the DDL could leak into the client bundle). See the client-bundle
 * boundary documented on `src/shared/reservation-types.ts`.
 *
 * `reservations.ts` (the Hono route layer) is the ONE place a row selected
 * through this table becomes the hand-authored `Reservation` shape - this
 * file is never the source of that shape (never `$inferSelect`/
 * `InferSelectModel` in the other direction, from `Reservation` -> here).
 *
 * `$type<ReservationStatus>()` constrains the `status` column to the ALREADY
 * hand-authored union from `reservation-types.ts`. That is the allowed
 * direction (a plain type informs a DB column); deriving the plain type FROM
 * this table is the forbidden one.
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ReservationStatus } from "../../shared/reservation-types";

export const reservations = sqliteTable("reservations", {
	id: text("id").primaryKey(),
	guestName: text("guest_name").notNull(),
	guestEmail: text("guest_email").notNull(),
	property: text("property").notNull(),
	checkIn: text("check_in").notNull(),
	checkOut: text("check_out").notNull(),
	/** Null until a Checktiv verification session has been minted for this reservation. */
	sessionId: text("session_id"),
	status: text("status").notNull().$type<ReservationStatus>(),
});
