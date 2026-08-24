// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * A CONTRACT test between the unauthenticated guest page and the SDK React provider
 * boundary (`<ChecktivJourney>` from `@checktiv/sdk-web/react`). We mock ONLY that
 * component and assert the wiring the page owns: parse the durable `client_token` +
 * publishable key from the URL FRAGMENT, STASH `{ clientToken, publishableKey }` in
 * `sessionStorage` keyed by `:id` BEFORE stripping the fragment via
 * `history.replaceState`, then render `<ChecktivJourney publishableKey fetchToken
 * onConsent onEvent onComplete crossDeviceCopy layout="immersive" />` where
 * `fetchToken` resolves the BARE client-token STRING (the SDK's pinned
 * `() => Promise<string>` contract - NOT `{ clientToken }`). The pk scope (not
 * region/mode) is what sends `X-Publishable-Key` so a third-party guest origin clears
 * the CORS preflight. Also covers reload-resume, no-token, terminal error, the
 * SDK-native cross-device desktop trigger (`ref.openCrossDevice()`, gated to a
 * fine-pointer device) and its `onEvent` recovery (`session_expired` -> terminal,
 * `cross_device_capped` -> non-terminal "still waiting" hint), completion (both the
 * `onComplete` callback and a `checktiv.idv.submitted` event), and the fraud CONSENT
 * gate (the page owns the disclosure UI and resolves `onConsent`).
 *
 * The cross-device cases also pin the handoff's REPLACE behavior: while the SDK's QR
 * overlay owns the screen the page flags its journey wrapper
 * (`data-checkin-handoff="open"`, the hook `CheckInPage.css` hides the capture surface
 * with), and EVERY exit - backed out, or a handoff that never produced a code - clears it
 * again without unmounting the journey. Those two halves have to be tested together:
 * hiding the capture is only safe because a close event restores it, so a suite that
 * covered the open path alone would green-light a dead end.
 *
 * Scope note, and the reason `CheckInPage.handoff-css.test.tsx` exists next to this file:
 * `<ChecktivJourney>` is doubled out here, so the real capture DOM never exists and the
 * `data-checkin-handoff` assertions below can only pin the page's STATE FLAG. Whether the
 * one CSS rule actually hides the right node is proved in that sibling suite, which
 * resolves the real cascade over the SDK's shipped stylesheet. Neither half stands alone.
 *
 * The double captures the props `<ChecktivJourney>` received into a hoisted ref, so
 * the test can (a) assert the exact wiring passed and (b) invoke the callbacks
 * (`onEvent` / `onConsent` / `onComplete`) the SAME way the real SDK would. It is a
 * `forwardRef` component that exposes `openCrossDevice` on its imperative handle -
 * mirroring the real `ChecktivJourneyHandle` - so the desktop trigger's
 * `ref.current?.openCrossDevice()` call is observable via a hoisted spy. Because
 * `<ChecktivJourney>` renders declaratively (no deferred mount microtask), the props
 * are captured synchronously with `render(...)` - there is no lifecycle to flush.
 *
 * The route is rendered inside a `MemoryRouter` whose initial entry carries the
 * `#ct=...&pk=ah_pk_...` fragment, so `useParams` + `useLocation().hash` are REAL
 * (MemoryRouter parses the entry into pathname/hash). `window.matchMedia` is stubbed
 * per test (default: a fine-pointer desktop) because the cross-device trigger is
 * desktop-only and the page reads `matchMedia('(pointer: coarse)')` to gate it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ChecktivEvent } from "@checktiv/sdk-web";
import CheckInPage from "../../src/react-app/routes/CheckInPage";

/**
 * The prop surface the page passes to `<ChecktivJourney>` - a subset of the SDK's
 * `MountOptions` on the publishable-key scope. Typed (not `any`) so a producer rename
 * of a prop the test drives fails `tsc -b` here.
 */
interface JourneyProps {
	readonly publishableKey: string;
	readonly fetchToken: () => Promise<string>;
	// The page always wires these three, so they are required here (a rename that
	// drops one from the page fails `tsc -b` at the call sites below).
	readonly onConsent: () => boolean | Promise<boolean>;
	readonly onEvent: (event: ChecktivEvent) => void;
	readonly onComplete: (result: { sessionId: string }) => void;
	// Host-injected cross-device overlay strings; `unavailableMessage` is mandatory.
	readonly crossDeviceCopy?: { readonly unavailableMessage: string };
	readonly layout?: string;
}

/** The imperative handle the double exposes via `forwardRef` + `useImperativeHandle`. */
interface MockJourneyHandle {
	openCrossDevice: () => void;
	requestResend: (confirmEmail: string) => Promise<{ requested: boolean }>;
}

// Hoisted so the `vi.mock` factory (also hoisted, above the imports) can reference them.
const { journeyRef, openCrossDeviceSpy } = vi.hoisted(() => {
	const journeyRef: { current: JourneyProps | null } = { current: null };
	const openCrossDeviceSpy = vi.fn();
	return { journeyRef, openCrossDeviceSpy };
});

// Mock ONLY the SDK React provider boundary; everything else (fragment/stash/state) is
// real. The double is a `forwardRef` component that captures the props it received AND
// exposes an imperative handle mirroring the real `ChecktivJourneyHandle`
// (`openCrossDevice`), so the desktop trigger's `ref.current?.openCrossDevice()` call is
// observable. It renders nothing (returns null); the test drives the captured callbacks
// exactly as the real SDK would.
vi.mock("@checktiv/sdk-web/react", async () => {
	const { forwardRef, useImperativeHandle } = await import("react");
	return {
		ChecktivJourney: forwardRef<MockJourneyHandle, JourneyProps>((props, ref) => {
			journeyRef.current = props;
			useImperativeHandle(ref, () => ({
				openCrossDevice: openCrossDeviceSpy,
				requestResend: async () => ({ requested: false }),
			}));
			return null;
		}),
	};
});

// The page's side-effect imports (`/idv`, `/fraud`, `/idv/cross-device`,
// `capture-ui/style.css`) resolve against the real package; only the React component is
// mocked above.

// The collect gate (`CheckInCollectForm`) that precedes the journey uses the SDK's
// programmatic collector. Mock it so importing the page does not load the real SDK
// data-plane and a confirm advances the journey deterministically (the collector's own
// wiring is covered in `tests/components/CheckInCollectForm.test.tsx`).
vi.mock("@checktiv/sdk-web/collect-user-info", () => ({
	collectUserInfo: () => ({
		submit: async () => ({ ok: true }),
		// The form probes describe() on mount; return the no-collect-config result so it
		// renders its full static field set (the shape these CheckInPage tests assert on).
		describe: async () => ({ ok: false, code: "not_collect_step" }),
	}),
}));

/**
 * Stub `window.matchMedia` for the pointer-type media query the page reads to gate the
 * desktop cross-device trigger. `coarse: true` models a touch phone (no trigger);
 * `coarse: false` models a fine-pointer desktop (trigger shown).
 */
function setCoarsePointer(coarse: boolean): void {
	window.matchMedia = ((query: string) => ({
		matches: coarse && query.includes("coarse"),
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
}

function renderAt(entry: string) {
	return render(
		<MemoryRouter initialEntries={[entry]}>
			<Routes>
				<Route path="/checkin/:id" element={<CheckInPage />} />
			</Routes>
		</MemoryRouter>,
	);
}

/**
 * True while the page has flagged the journey wrapper as "the cross-device handoff owns
 * the screen" (`data-checkin-handoff="open"`), which is the hook `CheckInPage.css` keys
 * the `display: none` on the SDK's `.idv-capture-root` off.
 *
 * The `<ChecktivJourney>` double renders nothing, so the real capture surface never
 * exists in these tests. Asserting the HOOK is deliberate: it is the exact contract
 * between the page's state machine and the one CSS rule, so these tests pin what the page
 * actually owns. That the rule hides the right node is a browser check, not a jsdom one.
 */
function handoffOwnsScreen(): boolean {
	return document.querySelector('[data-checkin-handoff="open"]') !== null;
}

/** The props `<ChecktivJourney>` was last rendered with (throws if it never rendered). */
function currentJourney(): JourneyProps {
	const props = journeyRef.current;
	if (props === null) throw new Error("ChecktivJourney did not render");
	return props;
}

/**
 * Advance past the collect gate that now precedes the journey: fill the required fields
 * on the "confirm your details" form and confirm. The mocked collector resolves `ok`, so
 * the page mounts `<ChecktivJourney>`. Resolves once the journey has rendered.
 */
async function passCollectGate(): Promise<void> {
	// The form renders once the (stubbed, failing) prefill read settles.
	await screen.findByRole("button", { name: /confirm and continue/i });
	// The name boxes render immediately and are never config gated, so there is no blur
	// or probe to wait on before filling them. Only the surname is required.
	fireEvent.change(await screen.findByLabelText("Surname(s)"), { target: { value: "Lovelace" } });
	fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ada" } });
	fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: "1 Analytical Way" } });
	fireEvent.change(screen.getByLabelText("City"), { target: { value: "London" } });
	fireEvent.change(screen.getByLabelText("Country"), { target: { value: "GB" } });
	fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));
	await waitFor(() => expect(journeyRef.current).not.toBeNull());
}

/** Render at `entry`, then advance past the collect gate so the journey is mounted. */
async function renderActive(entry: string): Promise<void> {
	renderAt(entry);
	await passCollectGate();
}

beforeEach(() => {
	sessionStorage.clear();
	journeyRef.current = null;
	openCrossDeviceSpy.mockClear();
	// Default to a fine-pointer desktop so the cross-device trigger renders; tests that
	// need a phone override this explicitly.
	setCoarsePointer(false);
	// The collect gate fetches a guest-safe prefill (`GET /api/checkin/:id`). Stub it to
	// fail so the form readies with EMPTY fields (the resilient fallback); the tests fill
	// the required fields themselves. This keeps the journey tests independent of the
	// prefill read (its own coverage is in the collect-form + reservations-route suites).
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
});

afterEach(() => {
	// This repo's vitest.config.ts does NOT set `test.globals: true`, so RTL's
	// automatic afterEach cleanup never registers; unmount manually so prior
	// renders do not leak into the next `it` (else "found multiple elements").
	cleanup();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("CheckInPage (guest check-in SPA)", () => {
	it("(g) renders the collect gate BEFORE the journey and mounts the journey after confirm", async () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The prefilled "confirm your details" collect step is shown first; the SDK journey
		// is NOT mounted until the applicant confirms.
		await screen.findByText(/confirm your details/i);
		expect(journeyRef.current).toBeNull();

		await passCollectGate();
		// After a successful collect submit the journey mounts with the same durable scope.
		expect(currentJourney().publishableKey).toBe("ah_pk_us_test_abc");
	});

	it("(a) parses the fragment, stashes BEFORE stripping, then renders the journey after collect", async () => {
		// Spy the live `sessionStorage` INSTANCE (not `Storage.prototype`): the happy-dom
		// environment can hand a later test a fresh storage instance whose `setItem` no
		// longer routes through the prototype we would otherwise spy, so a prototype spy
		// captures zero calls when this test runs after an async one.
		const setItemSpy = vi.spyOn(window.sessionStorage, "setItem");
		const replaceSpy = vi.spyOn(window.history, "replaceState");

		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// the stash was written under the :id key with the full scope (at mount, before the
		// collect gate)
		const stash = JSON.parse(sessionStorage.getItem("checkin:r1") ?? "null");
		expect(stash).toEqual({ clientToken: "tok123", publishableKey: "ah_pk_us_test_abc" });

		// stash BEFORE strip: the setItem call is ordered before the replaceState call
		expect(setItemSpy.mock.invocationCallOrder[0]).toBeLessThan(
			replaceSpy.mock.invocationCallOrder[0],
		);

		// history.replaceState cleared the fragment (the new URL carries no token)
		const strippedUrl = String(replaceSpy.mock.calls.at(-1)?.[2] ?? "");
		expect(strippedUrl).not.toContain("ct=");

		// advance past the collect gate to mount the journey
		await passCollectGate();

		// token + publishable key parsed from the hash and threaded into the journey props
		const props = currentJourney();
		expect(props.publishableKey).toBe("ah_pk_us_test_abc");
		// immersive layout gives the phone a full-screen capture surface
		expect(props.layout).toBe("immersive");
		// the cross-device overlay strings are injected (mandatory `unavailableMessage`)
		expect(props.crossDeviceCopy?.unavailableMessage).toBeTruthy();

		// `checktiv.idv.submitted` ends the applicant's part of the journey
		act(() => currentJourney().onEvent({ type: "checktiv.idv.submitted", sessionId: "vs_1" }));
		expect(screen.getByText(/your id has been submitted/i)).toBeInTheDocument();
	});

	it("(a2) fetchToken resolves the BARE client-token STRING (not `{ clientToken }`)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		await expect(currentJourney().fetchToken()).resolves.toBe("tok123");
	});

	it("(a3) the onComplete callback also transitions to the same terminal submitted state", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		act(() => currentJourney().onComplete({ sessionId: "vs_1" }));
		expect(screen.getByText(/your id has been submitted/i)).toBeInTheDocument();
	});

	it("(a6) the terminal card states what is known and never claims the applicant PASSED", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// `checktiv.idv.submitted` is terminal-for-CAPTURE only: it says the images are in,
		// never that they cleared. The decision is made server-side afterwards and reaches
		// the integrator's backend on a signed webhook - which this demo has no server to
		// receive - so any copy implying an outcome here would say "you passed" to an
		// applicant who was declined. The SDK ships this as a machine-readable rule for
		// integrators (`dist/agents/manifest.json`, `completion-is-not-a-verdict`).
		act(() => currentJourney().onEvent({ type: "checktiv.idv.submitted", sessionId: "vs_1" }));

		const card = screen.getByText(/your id has been submitted/i).closest("div");
		expect(card).not.toBeNull();
		const copy = card?.textContent ?? "";
		expect(copy).not.toMatch(/\bpassed\b/i);
		expect(copy).not.toMatch(/\bverified\b/i);
		expect(copy).not.toMatch(/\bapproved\b/i);
		expect(copy).not.toMatch(/\bcleared\b/i);
		expect(copy).not.toMatch(/\bcomplete\b/i);
		// And it still gives the applicant a next step rather than a bare end state.
		expect(copy).toMatch(/close this window/i);
	});

	it("(a4) a server-side-only next step (processing/no_renderable_step) is a terminal 'submitted' state, not an error, and never reloads", async () => {
		// A reload would tear down the durable-scope state and re-run the journey; the terminal
		// "in progress" state must NOT do that, so assert `location.reload` is never called.
		const reloadSpy = vi.spyOn(window.location, "reload").mockImplementation(() => {});

		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The current step is a server-side-only check (e.g. a background check) with no
		// applicant UI: the SDK emits a NON-error processing event with this exact reason.
		act(() =>
			currentJourney().onEvent({
				type: "checktiv.idv.processing",
				reason: "no_renderable_step",
			}),
		);

		// The new terminal "details submitted / in progress" state is shown.
		expect(screen.getByText(/details submitted/i)).toBeInTheDocument();
		expect(screen.getByText(/verification is now in progress/i)).toBeInTheDocument();
		// It is NOT routed to the terminal error surface.
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
		// It is terminal: the journey is unmounted (its host trigger is gone) and no reload fired.
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
		expect(reloadSpy).not.toHaveBeenCalled();
	});

	it("(a5) a transient signal_pending processing event does NOT hit the terminal 'submitted' state", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// `signal_pending` is a reload-safe transient race, NOT a terminal outcome: the journey
		// stays live and the "submitted" surface is not shown.
		act(() =>
			currentJourney().onEvent({
				type: "checktiv.idv.processing",
				reason: "signal_pending",
			}),
		);

		expect(screen.queryByText(/details submitted/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
		// The journey is still mounted (not torn down).
		expect(journeyRef.current).not.toBeNull();
	});

	it("(b) resumes from the :id stash when the fragment is already gone (in-tab reload)", async () => {
		sessionStorage.setItem(
			"checkin:r1",
			JSON.stringify({ clientToken: "tok999", publishableKey: "ah_pk_eu_live_xyz" }),
		);

		await renderActive("/checkin/r1");

		const props = currentJourney();
		expect(props.publishableKey).toBe("ah_pk_eu_live_xyz");
		// the "durable, resume-capable" promise survives a fragment-less reload
		await expect(props.fetchToken()).resolves.toBe("tok999");
	});

	it("(c) renders an actionable state when neither the fragment nor the stash has a token", () => {
		renderAt("/checkin/r1");

		expect(journeyRef.current).toBeNull();
		expect(screen.getByText(/reopen the check-in link/i)).toBeInTheDocument();
	});

	it("(c2) no-token when the fragment carries only one of ct / pk (both are required)", () => {
		// pk present but ct missing
		renderAt("/checkin/r1#pk=ah_pk_us_test_abc");
		expect(journeyRef.current).toBeNull();
		expect(screen.getByText(/reopen the check-in link/i)).toBeInTheDocument();
		cleanup();
		journeyRef.current = null;

		// ct present but pk missing
		renderAt("/checkin/r2#ct=tok123");
		expect(journeyRef.current).toBeNull();
		expect(screen.getByText(/reopen the check-in link/i)).toBeInTheDocument();
	});

	it("(d) shows an actionable next step on a NON-recoverable IDV error", async () => {
		await renderActive("/checkin/r1#ct=expired&pk=ah_pk_us_test_abc");

		const errorEvent: ChecktivEvent = {
			type: "checktiv.idv.error",
			error: {
				code: "sdk_load_failed",
				recoverable: false,
				recovery: "contact_operator",
				message: "sdk load failed",
			},
		};
		act(() => currentJourney().onEvent(errorEvent));

		expect(screen.getByText(/contact the property/i)).toBeInTheDocument();
		expect(screen.getByText(/fresh link/i)).toBeInTheDocument();
	});

	it("(d2) does NOT end the journey on a recoverable retry IDV error (the SDK handles retry)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		act(() =>
			currentJourney().onEvent({
				type: "checktiv.idv.error",
				error: {
					code: "camera_denied",
					recoverable: true,
					recovery: "retry",
					message: "camera denied",
				},
			}),
		);

		// A recoverable retry error is handled inside the SDK UI; the page stays live.
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
	});

	it("(d3) treats a session_expired error as terminal even when flagged recoverable (dead cross-device handoff)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The handoff died on the phone: the re-mint cap was hit and the link expired. The
		// SDK reports `session_expired`; the desktop must not stay a silent dead-end, so it
		// routes to the terminal failure surface regardless of the `recoverable` flag.
		act(() =>
			currentJourney().onEvent({
				type: "checktiv.idv.error",
				error: {
					code: "session_expired",
					recoverable: true,
					recovery: "refresh_session",
					message: "session expired on phone",
				},
			}),
		);

		expect(screen.getByText(/we could not start your check-in/i)).toBeInTheDocument();
	});

	it("(d4) surfaces a non-terminal 'still waiting' hint on cross_device_capped (overlay stays open)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// Real ordering: the overlay opens, and only later does its completion poll cap.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		// The completion poll capped without the phone finishing. Per the SDK contract this
		// is NOT an error and NOT a verdict: the overlay stays mounted, so the page shows a
		// "still waiting" hint and does NOT unmount the journey (no terminal surface).
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_capped" }),
		);

		expect(screen.getByText(/still waiting for your phone/i)).toBeInTheDocument();
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
		// The journey is still mounted (not torn down) so the phone can still finish.
		expect(journeyRef.current).not.toBeNull();
		// The overlay stays on screen at the cap, so the capture surface stays replaced:
		// the hint sits with the QR the applicant is still meant to scan, not beside a
		// camera frame telling them to do something else.
		expect(handoffOwnsScreen()).toBe(true);
	});

	it("(d5) logs a recoverable SDK error it does not route to a screen, instead of swallowing it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// `sdk_load_failed` is the likeliest integration-time failure (a missing
		// `@checktiv/sdk-web/idv` or `/fraud` side-effect import). It is `recoverable: true`
		// in the SDK's error table, so it is NOT terminal here - and unlike the capture
		// errors it has NO SDK UI behind it, so the applicant sits on a blank journey.
		// Matching no arm and vanishing is the failure mode this final arm exists to stop.
		act(() =>
			currentJourney().onEvent({
				type: "checktiv.idv.error",
				error: {
					code: "sdk_load_failed",
					message: "This session requires the 'idv' module. Import '@checktiv/sdk-web/idv' in your app.",
					recoverable: true,
					recovery: "cross_device",
				},
			}),
		);

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = String(warn.mock.calls[0]?.[0]);
		expect(logged).toContain("sdk_load_failed");
		expect(logged).toContain("checktiv.idv.error");
		// Still not terminal: the journey stays mounted and no failure screen is shown.
		expect(journeyRef.current).not.toBeNull();
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
	});

	it("(d6) does NOT log the routed arms (no console noise on the normal paths)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// Everything the page routes to a screen, plus a non-error informational arm, must
		// stay quiet - otherwise the warning above becomes noise nobody reads.
		act(() => currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }));
		act(() => currentJourney().onEvent({ type: "checktiv.idv.cross_device_closed" }));
		act(() => currentJourney().onEvent({ type: "checktiv.idv.phase", phase: "document_front" }));

		expect(warn).not.toHaveBeenCalled();
	});

	it("(d4b) 'Keep checking' re-arms the poll through the SDK handle and never reloads", async () => {
		// The page must NOT reload to recover a capped poll: the zero-lifecycle mount plane
		// on a null cursor would 404 into `session_expired`, turning a recoverable wait into
		// a false dead end. Assert the recovery goes through `openCrossDevice()` instead,
		// and that the QR stays on screen (the applicant can still finish on their phone).
		const reloadSpy = vi.spyOn(window.location, "reload").mockImplementation(() => {});
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		act(() => currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }));
		act(() => currentJourney().onEvent({ type: "checktiv.idv.cross_device_capped" }));
		expect(screen.getByText(/still waiting for your phone/i)).toBeInTheDocument();
		// The desktop trigger is hidden while the overlay owns the screen, so any
		// `openCrossDevice` call after this point can only have come from "Keep checking".
		expect(openCrossDeviceSpy).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /keep checking/i }));

		expect(openCrossDeviceSpy).toHaveBeenCalledTimes(1);
		expect(reloadSpy).not.toHaveBeenCalled();
		// The hint clears (a fresh poll is running) but the handoff still owns the screen:
		// the SDK keeps the same overlay mounted, so restoring the capture here would put a
		// camera frame back under the code the applicant is still meant to scan.
		expect(screen.queryByText(/still waiting for your phone/i)).not.toBeInTheDocument();
		expect(handoffOwnsScreen()).toBe(true);
	});

	it("(f) renders the desktop cross-device trigger and calls the SDK handle's openCrossDevice()", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		const trigger = screen.getByRole("button", { name: /continue on your phone/i });
		expect(trigger).toBeInTheDocument();

		fireEvent.click(trigger);
		expect(openCrossDeviceSpy).toHaveBeenCalledTimes(1);
	});

	it("(f3) replaces the capture surface (and hides the trigger) once the SDK opens its QR overlay", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// Visible before any overlay event on a fine-pointer desktop (the default stub), and
		// the capture surface is NOT hidden yet.
		expect(
			screen.getByRole("button", { name: /continue on your phone/i }),
		).toBeInTheDocument();
		expect(handoffOwnsScreen()).toBe(false);

		// The SDK mounts its own QR overlay INSIDE the journey. The host's quiet trigger
		// steps aside AND the camera capture surface is hidden, so the applicant is not
		// asked to use a camera and scan a code with their phone at the same time.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
		expect(handoffOwnsScreen()).toBe(true);
		// Hiding, NOT unmounting: the journey owns the QR overlay and the completion poll,
		// so tearing it down here would destroy the handoff the applicant is mid-way through.
		expect(journeyRef.current).not.toBeNull();
	});

	it("(f5) restores the capture surface and the trigger when the applicant backs out (cross_device_closed)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		expect(handoffOwnsScreen()).toBe(true);

		// The SDK DOES emit a close event when the applicant uses the overlay's own back /
		// try-again control (it wires its own `onClose` on this `<ChecktivJourney>` path).
		// Without honoring it the capture surface would stay hidden for the rest of the
		// journey, leaving the applicant with no capture and no way back - the dead end that
		// makes hiding the capture dangerous in the first place.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_closed" }),
		);
		expect(handoffOwnsScreen()).toBe(false);
		expect(
			screen.getByRole("button", { name: /continue on your phone/i }),
		).toBeInTheDocument();
		// The journey was never torn down, so the restored capture surface is the SAME live
		// one - no remount, no fresh session.
		expect(journeyRef.current).not.toBeNull();
	});

	it("(f6) drops a stale 'still waiting' hint when a capped overlay is closed", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		// The completion poll capped while the overlay was still up: the hint tells the
		// applicant to use "the code on screen".
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_capped" }),
		);
		expect(screen.getByText(/still waiting for your phone/i)).toBeInTheDocument();
		expect(handoffOwnsScreen()).toBe(true);

		// They then back out. There is no code on screen any more, so the hint (and its
		// "Keep checking" control, which would reopen a panel they just dismissed) must go
		// with it, leaving a plain working capture surface.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_closed" }),
		);
		expect(screen.queryByText(/still waiting for your phone/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /keep checking/i })).not.toBeInTheDocument();
		expect(handoffOwnsScreen()).toBe(false);
		expect(
			screen.getByRole("button", { name: /continue on your phone/i }),
		).toBeInTheDocument();
	});

	it("(f4) restores the capture surface but RETIRES the trigger when the handoff is unavailable (cold start)", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The mint failed at open time, so the SDK mounts its "unavailable" arm instead of a
		// QR. That arm renders the `unavailableMessage` paragraph and NOTHING else - no Back,
		// no Try again - so the capture surface must come back: it is the only thing the
		// applicant can still act on, and hiding it behind an undismissable panel would be a
		// hard dead end.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_unavailable" }),
		);
		expect(handoffOwnsScreen()).toBe(false);

		// The trigger must NOT come back. The SDK keeps one overlay object per journey and
		// `openCrossDevice()` short-circuits on it; nothing clears it because the unavailable
		// arm has no control to dismiss it. So the trigger would be a dead button, which is
		// the dead-end this page's cross-device recovery exists to prevent.
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
		// Not terminal: the journey stays mounted so the applicant can finish on the camera.
		expect(journeyRef.current).not.toBeNull();
	});

	it("(f4b) an unavailable RE-MINT inside an open overlay restores the capture and retires the trigger", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The sharper arm: the applicant is inside an OPEN QR overlay and uses the SDK's
		// "Get a new code", which fails. The SDK swaps the SAME panel to its unavailable arm
		// and re-emits `cross_device_unavailable` - it never emits `cross_device_closed`,
		// because the unavailable arm renders no control that could fire one.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		expect(handoffOwnsScreen()).toBe(true);

		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_unavailable" }),
		);
		expect(handoffOwnsScreen()).toBe(false);
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
	});

	it("(f4c) a poll that caps AFTER an unavailable handoff never claims there is a code on screen", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The SDK starts its completion poll BEFORE it mints, so the poll keeps running
		// behind a failed handoff and will eventually cap. The "still waiting" hint tells the
		// applicant to keep using "the code on screen" - and on this path no code was ever
		// rendered, so raising it would send them to look for something that does not exist.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_unavailable" }),
		);
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_capped" }),
		);

		expect(screen.queryByText(/still waiting for your phone/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /keep checking/i })).not.toBeInTheDocument();
	});

	it("(f2) hides the cross-device trigger on a coarse-pointer (touch) device", async () => {
		// A phone gets immersive capture, so the desktop-only handoff trigger must not show.
		setCoarsePointer(true);
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The journey still renders; only the trigger is gated off.
		expect(currentJourney().publishableKey).toBe("ah_pk_us_test_abc");
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
	});

	it("(e) presents the fraud consent gate and resolves onConsent with the applicant's choice", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The SDK asks for consent because the session declares the fraud module.
		let consent: Promise<boolean> | undefined;
		act(() => {
			consent = Promise.resolve(currentJourney().onConsent());
		});

		// The host-owned disclosure card appears (the SDK renders none).
		expect(screen.getByText(/before you continue/i)).toBeInTheDocument();
		expect(
			screen.getByText(/we check device and connection signals/i),
		).toBeInTheDocument();

		// The applicant allows -> onConsent resolves true and the card is dismissed.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
		});
		await expect(consent).resolves.toBe(true);
		expect(screen.queryByText(/before you continue/i)).not.toBeInTheDocument();
	});

	it("(e3) renders the consent gate as an accessible modal dialog and Allow resolves it", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// No dialog until the SDK asks for consent.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		let consent: Promise<boolean> | undefined;
		act(() => {
			consent = Promise.resolve(currentJourney().onConsent());
		});

		// The disclosure is a real ARIA dialog labelled by its heading. Modality is asserted
		// through its EFFECT rather than an `aria-modal` attribute: the primitive aria-hides
		// the rest of the document instead, which is the better-supported equivalent, so an
		// attribute assertion would pin an implementation detail and pass on a hand-rolled
		// overlay that traps nothing.
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveAccessibleName(/before you continue/i);
		expect(document.body.querySelector("[aria-hidden='true']")).not.toBeNull();

		// Focus lands on the primary action, so a keyboard or screen-reader user starts on
		// the choice rather than at the top of the document.
		const allow = within(dialog).getByRole("button", { name: /^allow$/i });
		await waitFor(() => expect(allow).toHaveFocus());

		// Allow (scoped inside the dialog) resolves the promise and dismisses the modal.
		await act(async () => {
			fireEvent.click(allow);
		});
		await expect(consent).resolves.toBe(true);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("(e4) the consent gate cannot be escaped: the applicant MUST choose", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		let consent: Promise<boolean> | undefined;
		act(() => {
			consent = Promise.resolve(currentJourney().onConsent());
		});
		const dialog = await screen.findByRole("dialog");

		// The forced choice is the point of this gate, and this asserts the GUARANTEE
		// (Escape does not take the disclosure away) rather than any one mechanism that
		// currently provides it. Two do: `open` is controlled with no `onOpenChange`, and
		// the content suppresses the primitive's own dismissals. Wiring `onOpenChange`
		// without keeping the suppression is the realistic future edit that breaks this,
		// and it would leave `onConsent` parked forever with the journey stuck.
		// There is also no close affordance of any kind besides the two choices.
		await act(async () => {
			fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
		});
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(within(dialog).getAllByRole("button")).toHaveLength(2);

		// Still resolvable the intended way.
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: /not now/i }));
		});
		await expect(consent).resolves.toBe(false);
	});

	it("(e2) declining consent resolves onConsent false without ending the journey", async () => {
		await renderActive("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		let consent: Promise<boolean> | undefined;
		act(() => {
			consent = Promise.resolve(currentJourney().onConsent());
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /not now/i }));
		});

		// Deny -> fraud stays off, but the identity journey is NOT terminated.
		await expect(consent).resolves.toBe(false);
		expect(screen.queryByText(/we could not start your check-in/i)).not.toBeInTheDocument();
	});

	it("(h) carries the edge's country guess from GET /api/geo into the collect form's dropdown", async () => {
		// The WIRING test. The page's geo read and the form's dropdown are each covered on
		// their own (`tests/worker/geo.route.test.ts`, the collect-form suite), and two
		// green halves would still let the prop between them go unpassed. This drives the
		// real page with a real `/api/geo` response and asserts the value lands SELECTED.
		//
		// It also pins that the two reads are INDEPENDENT: the prefill call still fails
		// here (the deployed demo binds no D1, so its 501 is the production case), and the
		// country must survive that. Folding the country into the prefill response would
		// have failed exactly this test.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : String(input);
				if (url.includes("/api/geo")) {
					return Promise.resolve(
						new Response(JSON.stringify({ country: "DE" }), {
							headers: { "content-type": "application/json" },
						}),
					);
				}
				return Promise.reject(new Error("no network in test"));
			}),
		);

		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		await screen.findByRole("button", { name: /confirm and continue/i });

		const country = screen.getByLabelText("Country");
		expect(country).toHaveValue("DE");
		expect(screen.getByText(/we picked this from your connection/i)).toBeInTheDocument();
	});

	it("(h2) leaves the country unselected when /api/geo reports no usable signal", async () => {
		// The local-dev and no-Cloudflare-edge case reaching the page end to end: a 200
		// with `{ country: null }` must read the same as no signal at all, and must NOT
		// fall back to a plausible default the guest would submit without noticing.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : String(input);
				if (url.includes("/api/geo")) {
					return Promise.resolve(
						new Response(JSON.stringify({ country: null }), {
							headers: { "content-type": "application/json" },
						}),
					);
				}
				return Promise.reject(new Error("no network in test"));
			}),
		);

		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		await screen.findByRole("button", { name: /confirm and continue/i });

		expect(screen.getByLabelText("Country")).toHaveValue("");
		expect(screen.queryByText(/we picked this from your connection/i)).not.toBeInTheDocument();
	});
});
