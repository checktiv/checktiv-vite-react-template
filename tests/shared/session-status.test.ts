/**
 * What this teaches / copy this pattern:
 * `reduceSessionStatus` is the demo's boundary between Checktiv's 11-member
 * live `SessionStatus` and the PMS's own 4-member `Reservation["status"]`.
 * The demo package CANNOT import Checktiv's session-status enum from the API
 * package, so no cross-package compile guard is possible - this suite is the
 * REQUIRED runtime drift backstop: it hand-enumerates all 11 known upstream
 * statuses (a second, independent copy of the enum) and asserts each reduces
 * to the intended reservation status, and that an unknown/future value falls
 * back to the documented default instead of `undefined`.
 *
 * If Checktiv adds a 12th status, the upstream poll will emit a value not in
 * the map below; `reduceSessionStatus` returns the documented default
 * ("verifying") so the UI keeps polling rather than crashing - and this test
 * still passes because it only pins the 11 KNOWN values. The new value is
 * surfaced by the live poll, not silently mis-bucketed into a terminal state.
 */
import { describe, it, expect } from "vitest";
import type { ReservationStatus } from "../../src/shared/reservation-types";
import {
	reduceSessionStatus,
	isTerminalSessionStatus,
	terminalNoticeFor,
	TERMINAL_SESSION_STATUSES,
	DEFAULT_REDUCED_STATUS,
} from "../../src/shared/session-status";

/**
 * Independent hand-copy of Checktiv's 11-member session enum -> the reservation
 * status each should reduce to. This intentionally duplicates the mapping in
 * `session-status.ts` so a change to the production table without a matching
 * change here (or vice versa) turns this suite red.
 */
const KNOWN_STATUS_EXPECTATIONS: Record<string, ReservationStatus> = {
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
};

describe("reduceSessionStatus (11 Checktiv statuses -> 4 reservation statuses)", () => {
	it("covers exactly the 11 known upstream statuses", () => {
		expect(Object.keys(KNOWN_STATUS_EXPECTATIONS)).toHaveLength(11);
	});

	for (const [sessionStatus, expected] of Object.entries(KNOWN_STATUS_EXPECTATIONS)) {
		it(`reduces "${sessionStatus}" -> "${expected}"`, () => {
			expect(reduceSessionStatus(sessionStatus)).toBe(expected);
		});
	}

	it("falls back to the documented default for an unknown/future status", () => {
		expect(reduceSessionStatus("some_future_status")).toBe(DEFAULT_REDUCED_STATUS);
		expect(DEFAULT_REDUCED_STATUS).toBe("verifying");
	});

	it("never returns undefined - known and unknown both resolve to a valid status", () => {
		const valid: ReservationStatus[] = ["draft", "invited", "verifying", "complete"];
		for (const sessionStatus of [...Object.keys(KNOWN_STATUS_EXPECTATIONS), "", "???"]) {
			expect(valid).toContain(reduceSessionStatus(sessionStatus));
		}
	});
});

describe("TERMINAL_SESSION_STATUSES (stops polling)", () => {
	it("contains exactly completed, expired, cancelled", () => {
		expect([...TERMINAL_SESSION_STATUSES].sort()).toEqual(
			["cancelled", "completed", "expired"],
		);
	});

	it.each(["completed", "expired", "cancelled"])("treats %s as terminal", (status) => {
		expect(isTerminalSessionStatus(status)).toBe(true);
	});

	it.each(["created", "pending", "in_progress", "processing", "awaiting_review", "unknown"])(
		"treats %s as non-terminal",
		(status) => {
			expect(isTerminalSessionStatus(status)).toBe(false);
		},
	);
});

describe("terminalNoticeFor (banner text for a terminal session)", () => {
	// The notice map and the poll-stopping set are one source now, so every
	// terminal status must yield a notice, and every non-terminal one must not.
	it("returns the completed notice", () => {
		expect(terminalNoticeFor("completed")).toBe(
			"Verification complete. The guest passed identity verification.",
		);
	});

	it("returns the expired notice", () => {
		expect(terminalNoticeFor("expired")).toBe(
			"This verification session expired before the guest finished. Create a new check-in link to re-verify.",
		);
	});

	it("returns the cancelled notice", () => {
		expect(terminalNoticeFor("cancelled")).toBe(
			"This verification was canceled. Create a new check-in link to re-verify the guest.",
		);
	});

	it("returns null for a non-terminal status", () => {
		expect(terminalNoticeFor("in_progress")).toBeNull();
		expect(terminalNoticeFor("some_future_status")).toBeNull();
	});

	it("gives a notice for exactly the poll-stopping terminal set (no drift)", () => {
		for (const status of TERMINAL_SESSION_STATUSES) {
			expect(terminalNoticeFor(status)).not.toBeNull();
		}
	});
});
