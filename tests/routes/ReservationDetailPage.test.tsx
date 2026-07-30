// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * The reservation detail page wires three moving parts the demo must get right,
 * so all three are driven here through the REAL component (rendered inside a
 * `MemoryRouter` seeded with the `:id` param so `useParams` resolves):
 *   1. Status polling discipline - poll every ~4s; stop on the terminal set;
 *      stop (with an actionable banner) on a permanent 404/401; stop after a
 *      bounded run of transient failures; never poll a draft; always clear the
 *      interval on unmount.
 *   2. The 11 -> 4 status reduction - the live session status is reduced via
 *      `reduceSessionStatus` BEFORE it reaches `<StatusChip>` (which only
 *      accepts the 4-member `Reservation["status"]`).
 *   3. The staff reviewer embed - mounted via the SDK `mountReviewer` loader,
 *      threading BOTH `region` and the custom-domain `workspaceBaseUrl`, with a
 *      `getToken` that surfaces DISTINCT actionable banners on 403/404/422.
 *
 * The client mock is typed against the client's exported result types so a field
 * rename in `checktiv-client.ts` fails THIS test at compile time. The real
 * `ChecktivClientError` class is preserved (via `importActual`) so the
 * component's `instanceof` error mapping is exercised, not stubbed away.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import {
	ChecktivClientError,
	type SessionStatusResult,
	type WorkspaceTokenResult,
} from "../../src/react-app/lib/checktiv-client";
import type { Reservation } from "../../src/shared/reservation-types";
import type { DemoConfig } from "../../src/shared/checktiv-config";

// -- mocks -------------------------------------------------------------------
// The spy fns are created inside `vi.hoisted` so they exist before the hoisted
// `vi.mock` factories reference them (a plain `const` would be in the temporal
// dead zone when the hoisted factory runs).
const spies = vi.hoisted(() => ({
	getSession: vi.fn<(id: string) => Promise<SessionStatusResult>>(),
	mintWorkspaceToken: vi.fn<(id: string) => Promise<WorkspaceTokenResult>>(),
	mountReviewer: vi.fn(),
	getReservation: vi.fn<(id: string) => Promise<Reservation | null>>(),
	updateReservation:
		vi.fn<(id: string, patch: Partial<Omit<Reservation, "id">>) => Promise<Reservation>>(),
}));
const { getSession, mintWorkspaceToken, mountReviewer, getReservation, updateReservation } = spies;

// Staff auth is always satisfied here; GuardedRoute must render the page.
vi.mock("../../src/react-app/lib/auth-client", () => ({
	useSession: () => ({ status: "authenticated" }),
}));

vi.mock("../../src/react-app/lib/checktiv-client", async (importActual) => {
	const actual = await importActual<typeof import("../../src/react-app/lib/checktiv-client")>();
	return {
		...actual, // keep the REAL ChecktivClientError so instanceof mapping runs
		checktivClient: {
			getSession: spies.getSession,
			mintWorkspaceToken: spies.mintWorkspaceToken,
			createSession: vi.fn(),
		},
	};
});

vi.mock("../../src/react-app/lib/sdk", () => ({ mountReviewer: spies.mountReviewer }));

// A custom-domain org config: workspaceBaseUrl is NOT the us region default, so
// asserting it threads through proves the override host is honored. The object
// is built inside the (hoisted) factory to avoid a temporal-dead-zone reference.
const WORKSPACE_BASE_URL = "https://reviewer.acme-lodging.com";
vi.mock("../../src/react-app/lib/config-store", () => ({
	getConfig: (): DemoConfig => ({
		secretKey: "ah_sk_us_test_abc",
		publishableKey: "ah_pk_us_test_abc",
		workflowTemplateId: "wt_abc",
		ctx: {
			region: "us",
			mode: "test",
			apiBase: "https://api.us.checktiv.com",
			sdkApiBase: "https://sdk-api.us.checktiv.com",
			workspaceBaseUrl: "https://reviewer.acme-lodging.com",
		},
	}),
}));

// `update` is a STABLE hoisted spy (not a fresh `vi.fn()` per call) so the poll
// write-back can be asserted regardless of how many times the page calls
// `selectStore()`.
vi.mock("../../src/react-app/lib/reservation-store", () => ({
	selectStore: () => ({
		get: spies.getReservation,
		list: vi.fn(),
		create: vi.fn(),
		update: spies.updateReservation,
	}),
}));

// Import AFTER mocks so the component picks up the mocked singletons.
import ReservationDetailPage from "../../src/react-app/routes/ReservationDetailPage";

// -- helpers -----------------------------------------------------------------

const RES_WITH_SESSION: Reservation = {
	id: "res_1",
	guestName: "Dana Rivera",
	guestEmail: "dana@example.com",
	property: "Seaside Loft",
	checkIn: "2026-08-01",
	checkOut: "2026-08-05",
	sessionId: "vs_abc123",
	status: "invited",
};

const RES_DRAFT: Reservation = { ...RES_WITH_SESSION, sessionId: undefined, status: "draft" };

function renderDetail(id = "res_1") {
	return render(
		<MemoryRouter initialEntries={[`/reservations/${id}`]}>
			<Routes>
				<Route path="/reservations/:id" element={<ReservationDetailPage />} />
			</Routes>
		</MemoryRouter>,
	);
}

/** Flush pending microtasks + any 0ms timers under fake timers. */
async function flush() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

/** Advance fake time by `ms`, flushing async work triggered by each poll. */
async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	getSession.mockReset();
	mintWorkspaceToken.mockReset();
	mountReviewer.mockReset();
	getReservation.mockReset();
	updateReservation.mockReset();
	// Default: reviewer mounts without requesting a token (token-error tests override).
	mountReviewer.mockReturnValue({ destroy: vi.fn() });
	mintWorkspaceToken.mockResolvedValue({ framingToken: "f", dataToken: "d" });
	getReservation.mockResolvedValue(RES_WITH_SESSION);
	// The write-back awaits the store's resolved value, so give it one by default.
	updateReservation.mockResolvedValue(RES_WITH_SESSION);
});

afterEach(() => {
	// vitest.config.ts does NOT set test.globals:true, so @testing-library/react's
	// automatic afterEach cleanup never registers - unmount explicitly here or a
	// second render() in a file collides with the first ("found multiple elements").
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
});

// -- tests -------------------------------------------------------------------

describe("ReservationDetailPage - reservation summary", () => {
	it("renders the reservation summary once loaded", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "in_progress", checks: [] });
		renderDetail();
		await flush();
		// Name appears in both the heading and the summary row; property is unique.
		expect(screen.getByRole("heading", { name: "Dana Rivera" })).toBeInTheDocument();
		expect(screen.getByText("Seaside Loft")).toBeInTheDocument();
	});
});

describe("ReservationDetailPage - status poll -> reduce -> StatusChip", () => {
	it("polls getSession and shows the REDUCED status on the chip (never the raw status)", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "processing", checks: [] });
		renderDetail();
		await flush();
		// processing -> verifying
		expect(screen.getByText("Verifying")).toBeInTheDocument();
		// The raw upstream status must never be rendered as a chip label.
		expect(screen.queryByText("processing")).not.toBeInTheDocument();
		expect(getSession).toHaveBeenCalledWith("vs_abc123");
	});

	it("keeps polling on ~4s intervals while non-terminal", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "in_progress", checks: [] });
		renderDetail();
		await flush();
		expect(getSession).toHaveBeenCalledTimes(1);
		await advance(4000);
		expect(getSession).toHaveBeenCalledTimes(2);
		await advance(4000);
		expect(getSession).toHaveBeenCalledTimes(3);
	});

	it("stops polling once a terminal status is reached", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "completed", checks: [] });
		renderDetail();
		await flush();
		expect(getSession).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Complete")).toBeInTheDocument();
		await advance(20000);
		// No further polls after a terminal status.
		expect(getSession).toHaveBeenCalledTimes(1);
	});

	it("does not poll at all for a draft reservation (no sessionId)", async () => {
		getReservation.mockResolvedValue(RES_DRAFT);
		renderDetail();
		await flush();
		await advance(20000);
		expect(getSession).not.toHaveBeenCalled();
		expect(mountReviewer).not.toHaveBeenCalled();
	});

	it("clears the interval on unmount", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "in_progress", checks: [] });
		const { unmount } = renderDetail();
		await flush();
		expect(getSession).toHaveBeenCalledTimes(1);
		unmount();
		await advance(20000);
		expect(getSession).toHaveBeenCalledTimes(1);
	});
});

describe("ReservationDetailPage - poll write-back keeps the list chip in sync", () => {
	it("persists the reduced status to the store when the live status advances", async () => {
		// RES_WITH_SESSION starts "invited"; in_progress -> "verifying", then
		// completed -> "complete". Each transition writes once with the reduced value.
		getSession
			.mockResolvedValueOnce({ id: "vs_abc123", status: "in_progress", checks: [] })
			.mockResolvedValue({ id: "vs_abc123", status: "completed", checks: [] });
		renderDetail();
		await flush();
		// invited -> verifying: exactly one write with the reduced status.
		expect(updateReservation).toHaveBeenCalledTimes(1);
		expect(updateReservation).toHaveBeenCalledWith("res_1", { status: "verifying" });

		await advance(4000);
		// verifying -> complete: the second (terminal) poll writes the reduced value.
		expect(updateReservation).toHaveBeenCalledWith("res_1", { status: "complete" });
		expect(updateReservation).toHaveBeenCalledTimes(2);
	});

	it("does not re-write the store when a subsequent poll returns the SAME status", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "in_progress", checks: [] });
		renderDetail();
		await flush();
		expect(updateReservation).toHaveBeenCalledTimes(1);
		expect(updateReservation).toHaveBeenCalledWith("res_1", { status: "verifying" });

		// A second poll with an unchanged status must NOT re-write the store.
		await advance(4000);
		expect(getSession).toHaveBeenCalledTimes(2);
		expect(updateReservation).toHaveBeenCalledTimes(1);
	});

	it("keeps the page functional when the store write-back rejects", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "processing", checks: [] });
		updateReservation.mockRejectedValue(new Error("store offline"));
		renderDetail();
		await flush();
		// The live chip still renders the reduced status despite the failed write.
		expect(updateReservation).toHaveBeenCalledWith("res_1", { status: "verifying" });
		expect(screen.getByText("Verifying")).toBeInTheDocument();
	});
});

describe("ReservationDetailPage - poll error handling", () => {
	it("stops polling and shows an actionable banner on a 404 (session gone)", async () => {
		getSession.mockRejectedValue(new ChecktivClientError("gone", "not_found", 404));
		renderDetail();
		await flush();
		expect(getSession).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/expired or was removed/i)).toBeInTheDocument();
		await advance(20000);
		expect(getSession).toHaveBeenCalledTimes(1);
	});

	it("stops polling and shows an actionable banner on a 401 (key no longer authorized)", async () => {
		getSession.mockRejectedValue(new ChecktivClientError("unauth", "forbidden", 401));
		renderDetail();
		await flush();
		expect(getSession).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/re-enter your secret key in setup/i)).toBeInTheDocument();
		await advance(20000);
		expect(getSession).toHaveBeenCalledTimes(1);
	});

	it("stops after a bounded run of consecutive transient failures", async () => {
		getSession.mockRejectedValue(
			new ChecktivClientError("temporary", "upstream_unavailable", 503),
		);
		renderDetail();
		await flush(); // attempt 1
		await advance(40000); // plenty of intervals
		// Capped at 5 consecutive transient failures, then stops.
		expect(getSession).toHaveBeenCalledTimes(5);
		expect(screen.getByText(/could not refresh/i)).toBeInTheDocument();
	});
});

describe("ReservationDetailPage - reviewer embed", () => {
	it("mounts the reviewer threading region AND the custom-domain workspaceBaseUrl + a getToken", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		renderDetail();
		await flush();
		expect(mountReviewer).toHaveBeenCalledTimes(1);
		const [target, input] = mountReviewer.mock.calls[0];
		expect(target).toBeInstanceOf(HTMLElement);
		expect(input).toMatchObject({
			sessionId: "vs_abc123",
			region: "us",
			workspaceBaseUrl: WORKSPACE_BASE_URL,
		});
		expect(typeof input.getToken).toBe("function");
	});

	it("getToken resolves reviewer tokens via mintWorkspaceToken", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		mintWorkspaceToken.mockResolvedValue({
			framingToken: "framing_x",
			dataToken: "data_x",
			expiresAt: "2026-08-01T00:00:00Z",
		});
		renderDetail();
		await flush();
		const [, input] = mountReviewer.mock.calls[0];
		const bundle = await input.getToken({ sessionId: "vs_abc123", reason: "initial" });
		expect(mintWorkspaceToken).toHaveBeenCalledWith("vs_abc123");
		expect(bundle).toMatchObject({ framingToken: "framing_x", dataToken: "data_x" });
	});

	it("renders a DISTINCT scope banner when mintWorkspaceToken 403s", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		mintWorkspaceToken.mockRejectedValue(new ChecktivClientError("no scope", "forbidden", 403));
		mountReviewer.mockImplementation((_t: HTMLElement, input: { getToken: (c: { sessionId: string; reason: string }) => Promise<unknown> }) => {
			void input.getToken({ sessionId: "vs_abc123", reason: "initial" }).catch(() => {});
			return { destroy: vi.fn() };
		});
		renderDetail();
		await flush();
		expect(screen.getByText(/missing the workspace-token scope/i)).toBeInTheDocument();
	});

	it("renders a DISTINCT session-gone banner when mintWorkspaceToken 404s", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		mintWorkspaceToken.mockRejectedValue(new ChecktivClientError("gone", "not_found", 404));
		mountReviewer.mockImplementation((_t: HTMLElement, input: { getToken: (c: { sessionId: string; reason: string }) => Promise<unknown> }) => {
			void input.getToken({ sessionId: "vs_abc123", reason: "initial" }).catch(() => {});
			return { destroy: vi.fn() };
		});
		renderDetail();
		await flush();
		expect(screen.getByText(/expired or was removed/i)).toBeInTheDocument();
	});

	it("renders a DISTINCT origin banner when mintWorkspaceToken 422s (origin not permitted)", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		mintWorkspaceToken.mockRejectedValue(
			new ChecktivClientError("origin", "origin_not_permitted", 422),
		);
		mountReviewer.mockImplementation((_t: HTMLElement, input: { getToken: (c: { sessionId: string; reason: string }) => Promise<unknown> }) => {
			void input.getToken({ sessionId: "vs_abc123", reason: "initial" }).catch(() => {});
			return { destroy: vi.fn() };
		});
		renderDetail();
		await flush();
		expect(screen.getByText(/workspace-origin allowlist/i)).toBeInTheDocument();
	});

	it("renders the GENERIC reviewer hint (not the origin hint) on a plain 422 validation_error", async () => {
		getSession.mockResolvedValue({ id: "vs_abc123", status: "awaiting_review", checks: [] });
		// A generic 422 carries the proxy's plain `validation_error` code, NOT
		// `origin_not_permitted` - so it must NOT surface the origin-allowlist hint.
		mintWorkspaceToken.mockRejectedValue(
			new ChecktivClientError("bad request", "validation_error", 422),
		);
		mountReviewer.mockImplementation((_t: HTMLElement, input: { getToken: (c: { sessionId: string; reason: string }) => Promise<unknown> }) => {
			void input.getToken({ sessionId: "vs_abc123", reason: "initial" }).catch(() => {});
			return { destroy: vi.fn() };
		});
		renderDetail();
		await flush();
		expect(screen.getByText(/staff reviewer could not load/i)).toBeInTheDocument();
		expect(screen.queryByText(/workspace-origin allowlist/i)).not.toBeInTheDocument();
	});
});
