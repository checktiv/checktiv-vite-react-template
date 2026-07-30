/**
 * What this teaches / copy this pattern:
 * This is the single boundary between Checktiv's live, 11-member session status
 * and the demo's own coarse, 4-member `Reservation["status"]`. The reservation
 * detail page reduces every polled session status THROUGH this module before it
 * ever reaches `<StatusChip>` (which only accepts `Reservation["status"]`).
 *
 * Why a hand-listed table (not a cross-package guard): the demo cannot import
 * Checktiv's session-status enum from the API package, so there is no compile-time
 * exhaustiveness guard available across the package boundary. Two defenses stand
 * in for it:
 *   1. `satisfies Record<KnownSessionStatus, ReservationStatus>` below - this
 *      pins the VALUE of every mapped entry to a real `ReservationStatus` (a typo
 *      like `"verify"` is a `tsc -b` error) and, because `KnownSessionStatus` is
 *      the local union of the 11 keys, it also forces every one of those 11 keys
 *      to be present.
 *   2. `tests/shared/session-status.test.ts` is the REQUIRED runtime drift
 *      backstop: it hand-copies the 11 upstream values independently and asserts
 *      the reduction, so a divergence between this table and the upstream enum
 *      turns the suite red.
 *
 * Unknown / future upstream values (e.g. a 12th status Checktiv ships later) are
 * NOT terminal and reduce to the documented default `DEFAULT_REDUCED_STATUS`
 * ("verifying"), so the UI keeps polling and shows a safe in-progress chip
 * rather than crashing or mis-bucketing the guest into a terminal state.
 */
import type { ReservationStatus } from "./reservation-types";

/**
 * The 11 known Checktiv session statuses (an independent, local copy of the
 * upstream `sessionStatusEnum` members - kept in sync via the drift test).
 */
type KnownSessionStatus =
	| "created"
	| "pending"
	| "in_progress"
	| "awaiting_gate"
	| "awaiting_recapture"
	| "processing"
	| "payment_required"
	| "awaiting_review"
	| "completed"
	| "expired"
	| "cancelled";

/**
 * Reservation status the UI shows for a guest who has NOT (yet) completed a
 * verification but whose session is terminal-with-no-result (expired / cancelled)
 * or not-yet-started (created / pending). Only a genuinely `completed` session
 * reduces to `"complete"` - mapping a dead session to the green success chip
 * would falsely tell a property manager the guest was verified. Expired and
 * cancelled sessions therefore reduce to `"invited"` (the reservation still
 * lacks a completed verification; the detail page's terminal notice explains the
 * expiry/cancellation and the re-invite next step).
 */
const SESSION_TO_RESERVATION_STATUS = {
	created: "invited",
	pending: "invited",
	in_progress: "verifying",
	awaiting_gate: "verifying",
	awaiting_recapture: "verifying",
	processing: "verifying",
	payment_required: "verifying",
	awaiting_review: "verifying",
	completed: "complete",
	expired: "invited",
	cancelled: "invited",
} satisfies Record<KnownSessionStatus, ReservationStatus>;

/** Documented fallback for unknown/future session statuses (keeps the poll alive). */
export const DEFAULT_REDUCED_STATUS: ReservationStatus = "verifying";

/**
 * Reduce a live Checktiv session status string to the demo's 4-member reservation
 * status. Always returns a valid `ReservationStatus` - unknown values map to
 * {@link DEFAULT_REDUCED_STATUS}, never `undefined`.
 */
export function reduceSessionStatus(sessionStatus: string): ReservationStatus {
	return (
		(SESSION_TO_RESERVATION_STATUS as Record<string, ReservationStatus | undefined>)[
			sessionStatus
		] ?? DEFAULT_REDUCED_STATUS
	);
}

/**
 * Terminal session statuses paired with the notice shown once the verification
 * lifecycle ends and polling stops. This map is the SINGLE source of truth for
 * "what is terminal": both {@link TERMINAL_SESSION_STATUSES} (which stops the
 * poll) and {@link terminalNoticeFor} (which renders the banner) read from it,
 * so the poll-stopping set and the explanatory copy cannot drift apart.
 */
const TERMINAL_NOTICES: Record<"completed" | "expired" | "cancelled", string> = {
	completed: "Verification complete. The guest passed identity verification.",
	expired:
		"This verification session expired before the guest finished. Create a new check-in link to re-verify.",
	cancelled: "This verification was canceled. Create a new check-in link to re-verify the guest.",
};

/**
 * Session statuses that end the verification lifecycle. Reaching any of these
 * stops the detail page's status poll (there is nothing left to observe).
 * Derived from {@link TERMINAL_NOTICES} keys so it is structurally impossible
 * for the poll-stopping set to diverge from the notice map.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set(
	Object.keys(TERMINAL_NOTICES),
);

/** True when a polled session status is terminal and polling should stop. */
export function isTerminalSessionStatus(sessionStatus: string): boolean {
	return TERMINAL_SESSION_STATUSES.has(sessionStatus);
}

/**
 * Informational notice for a terminal session (polling has stopped), or `null`
 * for any non-terminal status. Reads from the same {@link TERMINAL_NOTICES} map
 * that seeds {@link TERMINAL_SESSION_STATUSES}, so a status is terminal iff it
 * has a notice.
 */
export function terminalNoticeFor(sessionStatus: string): string | null {
	return (TERMINAL_NOTICES as Record<string, string | undefined>)[sessionStatus] ?? null;
}
