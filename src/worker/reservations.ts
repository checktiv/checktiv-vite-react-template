/**
 * What this teaches / copy this pattern:
 * The reservations CRUD surface, backed by D1 through `drizzle(env.DB)`. This
 * Hono sub-app is ALWAYS mounted by the composition root - it never disappears
 * from the route table - and instead branches internally on `env.DB`'s presence: local
 * dev binds D1 (`PERSISTENCE=d1`), the deployed Worker binds none
 * (`PERSISTENCE=local`; reservations live in the browser's `localStorage`
 * instead - see `reservation-store.ts`). A missing `env.DB` is therefore NOT
 * an error, it is the expected deployed shape, so every handler fails loud
 * with a structured, actionable 501 rather than throwing on a null binding.
 *
 * Routes are registered at their final absolute paths (mirroring
 * `checktiv-proxy.ts`'s `checktivProxy`), so the composition root mounts this
 * factory's result directly with no path rewriting, and `tests/lib/helpers.ts` /
 * `reservation-store.ts` call the SAME paths a real deploy would.
 *
 * Client-bundle boundary: `toReservation()` is the ONE place a Drizzle row
 * becomes the hand-authored `Reservation` shape
 * (`src/shared/reservation-types.ts`). Nothing under `src/react-app/**` may
 * import this file, `db/schema.ts`, or `drizzle-orm`.
 */
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { reservations } from "./db/schema";
import type {
	NewReservation,
	Reservation,
	ReservationStatus,
} from "../shared/reservation-types";

const VALID_STATUSES: readonly ReservationStatus[] = [
	"draft",
	"invited",
	"verifying",
	"complete",
];

/** Env fields this route reads. Composed into the full worker env in `index.ts`. */
interface ReservationsEnv {
	/** Bound in local dev only (`wrangler.jsonc` top-level); absent when deployed. */
	DB?: D1Database;
}

type AppContext = Context<{ Bindings: ReservationsEnv }>;
type ReservationRow = typeof reservations.$inferSelect;

/** Map a Drizzle row to the hand-authored `Reservation` shape at the DB boundary. */
function toReservation(row: ReservationRow): Reservation {
	return {
		id: row.id,
		guestName: row.guestName,
		guestEmail: row.guestEmail,
		property: row.property,
		checkIn: row.checkIn,
		checkOut: row.checkOut,
		sessionId: row.sessionId ?? undefined,
		status: row.status,
	};
}

/** The fail-loud, structured response for the deployed (no-D1) shape. */
function notAvailableResponse(c: AppContext) {
	return c.json(
		{
			error: "Reservations are not available in this deployment.",
			code: "no_persistence",
			status: 501,
		},
		501,
	);
}

function notFoundResponse(c: AppContext) {
	return c.json(
		{ error: "That reservation was not found.", code: "not_found", status: 404 },
		404,
	);
}

function invalidRequestResponse(c: AppContext, message: string) {
	return c.json({ error: message, code: "invalid_request", status: 400 }, 400);
}

type ParsedBody<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a POST body against `NewReservation`'s required shape. Explicit, not looped, so every field's type narrows precisely. */
function parseNewReservation(body: unknown): ParsedBody<NewReservation> {
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Request body must be a JSON object." };
	}
	const b = body as Record<string, unknown>;

	if (typeof b.guestName !== "string" || b.guestName === "") {
		return { ok: false, error: '"guestName" is required and must be a non-empty string.' };
	}
	if (typeof b.guestEmail !== "string" || b.guestEmail === "") {
		return { ok: false, error: '"guestEmail" is required and must be a non-empty string.' };
	}
	if (typeof b.property !== "string" || b.property === "") {
		return { ok: false, error: '"property" is required and must be a non-empty string.' };
	}
	if (typeof b.checkIn !== "string" || b.checkIn === "") {
		return { ok: false, error: '"checkIn" is required and must be a non-empty string.' };
	}
	if (typeof b.checkOut !== "string" || b.checkOut === "") {
		return { ok: false, error: '"checkOut" is required and must be a non-empty string.' };
	}
	if (b.status !== undefined && !VALID_STATUSES.includes(b.status as ReservationStatus)) {
		return { ok: false, error: `"status" must be one of: ${VALID_STATUSES.join(", ")}.` };
	}
	if (b.sessionId !== undefined && typeof b.sessionId !== "string") {
		return { ok: false, error: '"sessionId" must be a string.' };
	}

	return {
		ok: true,
		value: {
			guestName: b.guestName,
			guestEmail: b.guestEmail,
			property: b.property,
			checkIn: b.checkIn,
			checkOut: b.checkOut,
			status: b.status as ReservationStatus | undefined,
			sessionId: b.sessionId as string | undefined,
		},
	};
}

/**
 * Validate a PATCH body: every present field must be correctly typed, and at
 * least one recognized field must be present. A body that parses to ZERO
 * updatable fields (e.g. `{}`) is rejected as a structured 400 rather than
 * flowing into `db.update(...).set({})`, which drizzle-orm throws on and would
 * surface as an unstructured 500.
 */
function parsePatch(body: unknown): ParsedBody<Partial<Omit<Reservation, "id">>> {
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Request body must be a JSON object." };
	}
	const b = body as Record<string, unknown>;
	const patch: Partial<Omit<Reservation, "id">> = {};

	if (b.guestName !== undefined) {
		if (typeof b.guestName !== "string") return { ok: false, error: '"guestName" must be a string.' };
		patch.guestName = b.guestName;
	}
	if (b.guestEmail !== undefined) {
		if (typeof b.guestEmail !== "string") return { ok: false, error: '"guestEmail" must be a string.' };
		patch.guestEmail = b.guestEmail;
	}
	if (b.property !== undefined) {
		if (typeof b.property !== "string") return { ok: false, error: '"property" must be a string.' };
		patch.property = b.property;
	}
	if (b.checkIn !== undefined) {
		if (typeof b.checkIn !== "string") return { ok: false, error: '"checkIn" must be a string.' };
		patch.checkIn = b.checkIn;
	}
	if (b.checkOut !== undefined) {
		if (typeof b.checkOut !== "string") return { ok: false, error: '"checkOut" must be a string.' };
		patch.checkOut = b.checkOut;
	}
	if (b.sessionId !== undefined) {
		if (typeof b.sessionId !== "string") return { ok: false, error: '"sessionId" must be a string.' };
		patch.sessionId = b.sessionId;
	}
	if (b.status !== undefined) {
		if (!VALID_STATUSES.includes(b.status as ReservationStatus)) {
			return { ok: false, error: `"status" must be one of: ${VALID_STATUSES.join(", ")}.` };
		}
		patch.status = b.status as ReservationStatus;
	}

	if (Object.keys(patch).length === 0) {
		return {
			ok: false,
			error: "Request body must include at least one field to update.",
		};
	}

	return { ok: true, value: patch };
}

/**
 * Build the reservations Hono sub-app. ALWAYS mountable: every handler checks
 * `env.DB` first and returns a structured 501 when it is absent, so the
 * deployed no-D1 behavior is a live, tested code path (see
 * `tests/worker/reservations.route.test.ts`), never a conditional mount.
 */
export function reservationsRoute(): Hono<{ Bindings: ReservationsEnv }> {
	const app = new Hono<{ Bindings: ReservationsEnv }>();

	app.get("/api/reservations", async (c) => {
		if (!c.env.DB) return notAvailableResponse(c);
		const db = drizzle(c.env.DB);
		const rows = await db.select().from(reservations);
		return c.json(rows.map(toReservation));
	});

	app.get("/api/reservations/:id", async (c) => {
		if (!c.env.DB) return notAvailableResponse(c);
		const db = drizzle(c.env.DB);
		const rows = await db
			.select()
			.from(reservations)
			.where(eq(reservations.id, c.req.param("id")));
		if (rows.length === 0) return notFoundResponse(c);
		return c.json(toReservation(rows[0]));
	});

	/**
	 * GUEST-SAFE prefill read for the check-in collect step. Returns ONLY the
	 * `{ guestName, guestEmail }` for one reservation - never the secret key, session
	 * id, or any other row - so the applicant's "confirm your details" form
	 * (`CheckInCollectForm`) can prefill legal name + email.
	 *
	 * Deliberately NOT staff-gated: the guest never authenticates, and holding the
	 * check-in link (which carries the durable token in its fragment) is the capability,
	 * exactly like the guest journey itself. It is mounted OUTSIDE the `/api/reservations`
	 * `requireStaff` prefix in `index.ts` for that reason. Reservation ids are UUIDs
	 * (`crypto.randomUUID()` on create), so `:id` is not an enumerable leak. This is a
	 * DEMO-GRADE capability that rides on the demo's already-mock auth (see `AGENTS.md`
	 * "Out of scope"); a production integration would authenticate the guest and scope
	 * this read to their own reservation. In the deployed no-D1 shape this returns the
	 * structured 501 and the collect form falls back to empty fields (the guest fills
	 * them in), so prefill absence never blocks check-in.
	 */
	app.get("/api/checkin/:id", async (c) => {
		if (!c.env.DB) return notAvailableResponse(c);
		const db = drizzle(c.env.DB);
		const rows = await db
			.select()
			.from(reservations)
			.where(eq(reservations.id, c.req.param("id")));
		if (rows.length === 0) return notFoundResponse(c);
		return c.json({ guestName: rows[0].guestName, guestEmail: rows[0].guestEmail });
	});

	app.post("/api/reservations", async (c) => {
		if (!c.env.DB) return notAvailableResponse(c);
		const parsed = parseNewReservation(await c.req.json().catch(() => null));
		if (!parsed.ok) return invalidRequestResponse(c, parsed.error);
		const db = drizzle(c.env.DB);
		const [row] = await db
			.insert(reservations)
			.values({
				id: crypto.randomUUID(),
				guestName: parsed.value.guestName,
				guestEmail: parsed.value.guestEmail,
				property: parsed.value.property,
				checkIn: parsed.value.checkIn,
				checkOut: parsed.value.checkOut,
				sessionId: parsed.value.sessionId ?? null,
				status: parsed.value.status ?? "draft",
			})
			.returning();
		return c.json(toReservation(row), 201);
	});

	app.patch("/api/reservations/:id", async (c) => {
		if (!c.env.DB) return notAvailableResponse(c);
		const parsed = parsePatch(await c.req.json().catch(() => null));
		if (!parsed.ok) return invalidRequestResponse(c, parsed.error);
		const db = drizzle(c.env.DB);
		const [row] = await db
			.update(reservations)
			.set(parsed.value)
			.where(eq(reservations.id, c.req.param("id")))
			.returning();
		if (!row) return notFoundResponse(c);
		return c.json(toReservation(row));
	});

	return app;
}
