// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * The reservations page is the demo's core create -> mint -> persist flow, so
 * these tests drive the REAL component with injected mocks typed against the
 * shared contracts (`ReservationStore`, `ChecktivClient['createSession']`,
 * `CreateSessionResult`) - never hand-typed literals - so a field rename in a
 * dependency is a `tsc -b` failure right here, not a silent runtime drift.
 *
 * We render the named `ReservationsView` (the injectable inner component), NOT
 * the default export, because the default export resolves the real store /
 * config / client singletons - the view is the seam that lets us inject typed
 * mocks for all three.
 *
 * Three required paths: (a) happy path - call order +
 * split-vs-joined name mapping + the `#ct=` fragment link shape; (b) mint
 * failure - the reservation is left recoverable (draft, unlinked) with a
 * re-invite affordance and an actionable banner; (c) store-error - a rejecting
 * `list()` renders an actionable state, not an unhandled crash. A fourth guards
 * the test-vs-live mode gate on the synthetic-outcome control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router";
import { ReservationsView } from "../../src/react-app/routes/ReservationsPage";
import { setConfig, getConfig } from "../../src/react-app/lib/config-store";
import type { ReservationStore } from "../../src/react-app/lib/reservation-store";
import type {
	ChecktivClient,
	CreateSessionResult,
} from "../../src/react-app/lib/checktiv-client";
import type { DemoConfig } from "../../src/shared/checktiv-config";
import { deriveKeyContext } from "../../src/shared/checktiv-config";
import type { Reservation } from "../../src/shared/reservation-types";

/** A fully-typed store mock so a `ReservationStore` shape change breaks here. */
function makeStore(): { [K in keyof ReservationStore]: ReturnType<typeof vi.fn> } &
	ReservationStore {
	return {
		list: vi.fn<ReservationStore["list"]>(),
		get: vi.fn<ReservationStore["get"]>(),
		create: vi.fn<ReservationStore["create"]>(),
		update: vi.fn<ReservationStore["update"]>(),
		clear: vi.fn<ReservationStore["clear"]>(),
	};
}

/** Client mock: only `createSession` is used by this page; typed against the SDK contract. */
function makeClient(): Pick<ChecktivClient, "createSession"> & {
	createSession: ReturnType<typeof vi.fn>;
} {
	return { createSession: vi.fn<ChecktivClient["createSession"]>() };
}

function makeConfig(key = "ah_sk_us_test_x", publishableKey = "ah_pk_us_test_x"): DemoConfig {
	return {
		secretKey: key,
		publishableKey,
		workflowTemplateId: "wt_demo",
		ctx: deriveKeyContext(key),
	};
}

const RESERVATION: Reservation = {
	id: "res_1",
	guestName: "Ada Lovelace",
	guestEmail: "ada@example.co",
	property: "Seaside Loft",
	checkIn: "2026-08-01",
	checkOut: "2026-08-05",
	status: "draft",
};

const SESSION: CreateSessionResult = {
	id: "vs_1",
	clientToken: "ct_abc",
	applicantUrl: "https://verify.us.checktiv.com/s/ABC123",
	shortCode: "ABC123",
	status: "pending",
};

function renderView(
	store: ReservationStore,
	client: Pick<ChecktivClient, "createSession">,
	config: DemoConfig,
) {
	return render(
		<MemoryRouter initialEntries={["/reservations"]}>
			<ReservationsView store={store} client={client} config={config} />
		</MemoryRouter>,
	);
}

/** Open the "New booking" dialog and fill every field with the given guest. */
async function fillBooking(
	user: ReturnType<typeof userEvent.setup>,
	guest: { first: string; last: string; email: string; property: string },
) {
	await user.click(await screen.findByRole("button", { name: /new booking/i }));
	const dialog = await screen.findByRole("dialog");
	const scoped = within(dialog);
	await user.type(scoped.getByLabelText(/first name/i), guest.first);
	await user.type(scoped.getByLabelText(/last name/i), guest.last);
	await user.type(scoped.getByLabelText(/email/i), guest.email);
	// Property is now a dropdown over a fixed dummy set; select rather than type.
	await user.selectOptions(scoped.getByLabelText(/property/i), guest.property);
	await user.type(scoped.getByLabelText(/check-in/i), "2026-08-01");
	await user.type(scoped.getByLabelText(/check-out/i), "2026-08-05");
	return scoped;
}

describe("ReservationsView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// No `globals: true` in vitest.config, so RTL's auto-cleanup is not wired;
	// unmount between tests to avoid duplicate DOM (two "New booking" buttons).
	afterEach(() => {
		cleanup();
	});

	it("(a) happy path: create -> mint -> update in order, split/joined names, #ct= fragment link", async () => {
		const user = userEvent.setup();
		const store = makeStore();
		const client = makeClient();
		// First load is empty; after create the list reflects the new draft/invited row.
		store.list.mockResolvedValueOnce([]).mockResolvedValue([
			{ ...RESERVATION, sessionId: "vs_1", status: "invited" },
		]);
		store.create.mockResolvedValue(RESERVATION);
		store.update.mockResolvedValue({ ...RESERVATION, sessionId: "vs_1", status: "invited" });
		client.createSession.mockResolvedValue(SESSION);

		renderView(store, client, makeConfig());
		await waitFor(() => expect(store.list).toHaveBeenCalled());

		const scoped = await fillBooking(user, {
			first: "Ada",
			last: "Lovelace",
			email: "ada@example.co",
			property: "Seaside Loft 3",
		});
		// Pick a synthetic outcome (test mode only) to prove it threads through.
		await user.selectOptions(scoped.getByLabelText(/expected.*outcome/i), "review");
		await user.click(scoped.getByRole("button", { name: /create booking/i }));

		await waitFor(() => expect(store.update).toHaveBeenCalled());

		// call order: create BEFORE mint BEFORE update
		const createOrder = store.create.mock.invocationCallOrder[0];
		const mintOrder = client.createSession.mock.invocationCallOrder[0];
		const updateOrder = store.update.mock.invocationCallOrder[0];
		expect(createOrder).toBeLessThan(mintOrder);
		expect(mintOrder).toBeLessThan(updateOrder);

		// joined name into the reservation record
		expect(store.create).toHaveBeenCalledWith(
			expect.objectContaining({
				guestName: "Ada Lovelace",
				guestEmail: "ada@example.co",
				property: "Seaside Loft 3",
				checkIn: "2026-08-01",
				checkOut: "2026-08-05",
			}),
		);
		// The booking form captured the boundary as two separate inputs, so the mint
		// sends the STRUCTURED pair: `lastName` -> family_name, `firstName` ->
		// given_names as a one-element ARRAY. `toEqual` (not objectContaining) on the
		// applicant so a stray retired key would fail rather than pass unnoticed.
		expect(client.createSession).toHaveBeenCalledWith(
			{ family_name: "Lovelace", given_names: ["Ada"], email: "ada@example.co" },
			expect.objectContaining({ expectedOutcome: "review" }),
		);
		// Nothing reconstructs a name: the joined `guestName` is never fed to the mint
		// on this path, and no retired field is emitted.
		const bookingApplicant = client.createSession.mock.calls[0][0] as Record<string, unknown>;
		expect(bookingApplicant).not.toHaveProperty("first_name");
		expect(bookingApplicant).not.toHaveProperty("last_name");
		expect(bookingApplicant).not.toHaveProperty("legal_name");
		expect(bookingApplicant).not.toHaveProperty("reference_name");
		// persist the session link
		expect(store.update).toHaveBeenCalledWith(
			"res_1",
			expect.objectContaining({ sessionId: "vs_1", status: "invited" }),
		);

		// the raw link is never rendered as visible text - only the action buttons
		expect(screen.queryByText(/\/checkin\/res_1/)).not.toBeInTheDocument();

		// "Copy check-in link" copies the FULL ABSOLUTE URL (origin + path +
		// fragment), carrying the publishable key (the SDK's guest mount scope),
		// never region/mode and never a query string
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
		await user.click(await screen.findByRole("button", { name: /copy check-in link/i }));
		expect(writeText).toHaveBeenCalledTimes(1);
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).toMatch(/^http/);
		expect(copied).toContain("/checkin/res_1#ct=ct_abc");
		expect(copied).toContain("&pk=ah_pk_us_test_x");
		expect(copied).not.toContain("region=");
		expect(copied).not.toContain("mode=");
		expect(copied).not.toContain("?ct=");
	});

	it("(b) mint failure: reservation stays draft + unlinked, banner + re-invite affordance, retry recovers", async () => {
		const user = userEvent.setup();
		const store = makeStore();
		const client = makeClient();
		// list: empty first, then the draft row after the failed mint
		store.list.mockResolvedValueOnce([]).mockResolvedValue([RESERVATION]);
		store.create.mockResolvedValue(RESERVATION);
		store.update.mockResolvedValue({ ...RESERVATION, sessionId: "vs_1", status: "invited" });
		client.createSession
			.mockRejectedValueOnce(new Error("Workspace token minting is disabled for this org."))
			.mockResolvedValue(SESSION);

		renderView(store, client, makeConfig());
		await waitFor(() => expect(store.list).toHaveBeenCalled());

		const scoped = await fillBooking(user, {
			first: "Ada",
			last: "Lovelace",
			email: "ada@example.co",
			property: "Seaside Loft 3",
		});
		await user.click(scoped.getByRole("button", { name: /create booking/i }));

		// reservation was created but NOT updated (left recoverable / unlinked)
		await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));
		expect(store.update).not.toHaveBeenCalled();

		// actionable error banner
		expect(await screen.findByRole("alert")).toHaveTextContent(/disabled|failed|try again|retry/i);

		// the draft row exposes a re-invite / retry action; clicking it recovers
		const retry = await screen.findByRole("button", { name: /re-?invite|retry/i });
		await user.click(retry);
		await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(store.update).toHaveBeenCalledWith(
				"res_1",
				expect.objectContaining({ sessionId: "vs_1", status: "invited" }),
			),
		);
	});

	it("(b2) re-invite sends the joined guestName VERBATIM as reference_name, never split", async () => {
		// The load-bearing CT-404 assertion. A saved reservation carries ONE joined
		// `guestName` column, so this path does not know where the family name begins.
		// "Ana Garcia Lopez" is the case that exposes a whitespace split: last-token
		// splitting yields family_name "Lopez" (wrong - the surname is "Garcia Lopez"),
		// and first-token splitting yields given_names ["Ana"] with the rest as a
		// surname it never verified. The string goes verbatim to `reference_name`, a
		// non-authoritative display label, because that is honestly all it is; the
		// screenable parts come from the applicant in the collect step. Assert the
		// applicant EXACTLY: no name-component key and no retired key may appear.
		const user = userEvent.setup();
		const store = makeStore();
		const client = makeClient();
		const joined: Reservation = { ...RESERVATION, guestName: "Ana Garcia Lopez" };
		store.list.mockResolvedValue([joined]);
		store.update.mockResolvedValue({ ...joined, sessionId: "vs_1", status: "invited" });
		client.createSession.mockResolvedValue(SESSION);

		renderView(store, client, makeConfig());
		await waitFor(() => expect(store.list).toHaveBeenCalled());

		await user.click(await screen.findByRole("button", { name: /re-?invite/i }));
		await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));

		expect(client.createSession.mock.calls[0][0]).toEqual({
			reference_name: "Ana Garcia Lopez",
			email: joined.guestEmail,
		});
	});

	it("(c) store-error: list() rejecting renders an actionable state with a retry, not a crash", async () => {
		const store = makeStore();
		const client = makeClient();
		store.list
			.mockRejectedValueOnce(
				new Error("Persistence mismatch: set VITE_PERSISTENCE to match the Worker."),
			)
			.mockResolvedValue([]);

		renderView(store, client, makeConfig());

		expect(await screen.findByRole("alert")).toHaveTextContent(/persistence|mismatch|could not|failed/i);
		// actionable: a retry control that re-runs list()
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(store.list).toHaveBeenCalledTimes(2));
	});

	it("(d) live mode hides the synthetic-outcome control and shows the live warning", async () => {
		const user = userEvent.setup();
		const store = makeStore();
		const client = makeClient();
		store.list.mockResolvedValue([]);

		renderView(store, client, makeConfig("ah_sk_us_live_x"));
		await waitFor(() => expect(store.list).toHaveBeenCalled());
		await user.click(await screen.findByRole("button", { name: /new booking/i }));

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByLabelText(/expected.*outcome/i)).not.toBeInTheDocument();
		expect(
			within(dialog).getByText(/real verifications run against your org/i),
		).toBeInTheDocument();
	});

	it("(e) Reset demo: confirm wipes config + reservations + check-in stashes and returns to Setup", async () => {
		// The "Reset demo" action renders only in local (deployed) persistence mode.
		vi.stubEnv("VITE_PERSISTENCE", "local");
		try {
			const user = userEvent.setup();
			const store = makeStore();
			const client = makeClient();
			store.list.mockResolvedValue([RESERVATION]);
			store.clear.mockResolvedValue(undefined);

			// Seed the state a full reset must wipe: the demo config + a guest check-in stash.
			setConfig(makeConfig());
			sessionStorage.setItem("checkin:res_1", JSON.stringify({ clientToken: "vt_x", publishableKey: "ah_pk_us_test_x" }));

			render(
				<MemoryRouter initialEntries={["/reservations"]}>
					<Routes>
						<Route
							path="/reservations"
							element={<ReservationsView store={store} client={client} config={makeConfig()} />}
						/>
						<Route path="/setup" element={<div>SETUP SCREEN</div>} />
					</Routes>
				</MemoryRouter>,
			);
			await waitFor(() => expect(store.list).toHaveBeenCalled());

			// Header action opens a confirm gate (destructive: must not fire on a stray click).
			await user.click(screen.getByRole("button", { name: /reset demo/i }));
			const dialog = await screen.findByRole("dialog");

			// Confirm -> full wipe + redirect to Setup.
			await user.click(within(dialog).getByRole("button", { name: /reset demo/i }));

			await waitFor(() => expect(screen.getByText("SETUP SCREEN")).toBeInTheDocument());
			expect(store.clear).toHaveBeenCalledTimes(1);
			expect(getConfig()).toBeNull();
			expect(sessionStorage.getItem("checkin:res_1")).toBeNull();
		} finally {
			vi.unstubAllEnvs();
			sessionStorage.clear();
		}
	});
});
