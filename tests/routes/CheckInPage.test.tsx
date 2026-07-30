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
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

/** The props `<ChecktivJourney>` was last rendered with (throws if it never rendered). */
function currentJourney(): JourneyProps {
	const props = journeyRef.current;
	if (props === null) throw new Error("ChecktivJourney did not render");
	return props;
}

beforeEach(() => {
	sessionStorage.clear();
	journeyRef.current = null;
	openCrossDeviceSpy.mockClear();
	// Default to a fine-pointer desktop so the cross-device trigger renders; tests that
	// need a phone override this explicitly.
	setCoarsePointer(false);
});

afterEach(() => {
	// This repo's vitest.config.ts does NOT set `test.globals: true`, so RTL's
	// automatic afterEach cleanup never registers; unmount manually so prior
	// renders do not leak into the next `it` (else "found multiple elements").
	cleanup();
	sessionStorage.clear();
	vi.restoreAllMocks();
});

describe("CheckInPage (guest check-in SPA)", () => {
	it("(a) parses the fragment, stashes BEFORE stripping, renders the journey, then completes", () => {
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
		const replaceSpy = vi.spyOn(window.history, "replaceState");

		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// token + publishable key parsed from the hash and threaded into the journey props
		const props = currentJourney();
		expect(props.publishableKey).toBe("ah_pk_us_test_abc");
		// immersive layout is the point of the 1.3.0 bump (full-screen phone capture)
		expect(props.layout).toBe("immersive");
		// the cross-device overlay strings are injected (mandatory `unavailableMessage`)
		expect(props.crossDeviceCopy?.unavailableMessage).toBeTruthy();

		// the stash was written under the :id key with the full scope
		const stash = JSON.parse(sessionStorage.getItem("checkin:r1") ?? "null");
		expect(stash).toEqual({ clientToken: "tok123", publishableKey: "ah_pk_us_test_abc" });

		// stash BEFORE strip: the setItem call is ordered before the replaceState call
		expect(setItemSpy.mock.invocationCallOrder[0]).toBeLessThan(
			replaceSpy.mock.invocationCallOrder[0],
		);

		// history.replaceState cleared the fragment (the new URL carries no token)
		const strippedUrl = String(replaceSpy.mock.calls.at(-1)?.[2] ?? "");
		expect(strippedUrl).not.toContain("ct=");

		// the `checktiv.idv.submitted` event transitions to the terminal "complete" state
		act(() => currentJourney().onEvent({ type: "checktiv.idv.submitted", sessionId: "vs_1" }));
		expect(screen.getByText(/check-in complete/i)).toBeInTheDocument();
	});

	it("(a2) fetchToken resolves the BARE client-token STRING (not `{ clientToken }`)", async () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		await expect(currentJourney().fetchToken()).resolves.toBe("tok123");
	});

	it("(a3) the onComplete callback also transitions to the terminal complete state", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");
		act(() => currentJourney().onComplete({ sessionId: "vs_1" }));
		expect(screen.getByText(/check-in complete/i)).toBeInTheDocument();
	});

	it("(b) resumes from the :id stash when the fragment is already gone (in-tab reload)", async () => {
		sessionStorage.setItem(
			"checkin:r1",
			JSON.stringify({ clientToken: "tok999", publishableKey: "ah_pk_eu_live_xyz" }),
		);

		renderAt("/checkin/r1");

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

	it("(d) shows an actionable next step on a NON-recoverable IDV error", () => {
		renderAt("/checkin/r1#ct=expired&pk=ah_pk_us_test_abc");

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

	it("(d2) does NOT end the journey on a recoverable retry IDV error (the SDK handles retry)", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

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

	it("(d3) treats a session_expired error as terminal even when flagged recoverable (dead cross-device handoff)", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

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

	it("(d4) surfaces a non-terminal 'still waiting' hint on cross_device_capped (overlay stays open)", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

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
	});

	it("(f) renders the desktop cross-device trigger and calls the SDK handle's openCrossDevice()", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		const trigger = screen.getByRole("button", { name: /continue on your phone/i });
		expect(trigger).toBeInTheDocument();

		fireEvent.click(trigger);
		expect(openCrossDeviceSpy).toHaveBeenCalledTimes(1);
	});

	it("(f3) hides the cross-device trigger once the SDK opens its QR overlay", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// Visible before any overlay event on a fine-pointer desktop (the default stub).
		expect(
			screen.getByRole("button", { name: /continue on your phone/i }),
		).toBeInTheDocument();

		// The SDK mounts its own QR overlay: the host's quiet trigger must step aside so the
		// two never compete for attention. The SDK emits no close event, so it stays hidden.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_opened" }),
		);
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
	});

	it("(f4) re-shows the trigger when the handoff mint fails (cross_device_unavailable, no overlay)", () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The mint failed and NO overlay was shown, so the trigger stays available to retry.
		act(() =>
			currentJourney().onEvent({ type: "checktiv.idv.cross_device_unavailable" }),
		);
		expect(
			screen.getByRole("button", { name: /continue on your phone/i }),
		).toBeInTheDocument();
	});

	it("(f2) hides the cross-device trigger on a coarse-pointer (touch) device", () => {
		// A phone gets immersive capture, so the desktop-only handoff trigger must not show.
		setCoarsePointer(true);
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// The journey still renders; only the trigger is gated off.
		expect(currentJourney().publishableKey).toBe("ah_pk_us_test_abc");
		expect(
			screen.queryByRole("button", { name: /continue on your phone/i }),
		).not.toBeInTheDocument();
	});

	it("(e) presents the fraud consent gate and resolves onConsent with the applicant's choice", async () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

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
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

		// No dialog until the SDK asks for consent.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		let consent: Promise<boolean> | undefined;
		act(() => {
			consent = Promise.resolve(currentJourney().onConsent());
		});

		// The disclosure is now a centered modal dialog (not an inline column card): it is a
		// real ARIA dialog, modal, and labelled by its heading.
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toHaveAccessibleName(/before you continue/i);

		// Allow (scoped inside the dialog) resolves the promise and dismisses the modal.
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: /^allow$/i }));
		});
		await expect(consent).resolves.toBe(true);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("(e2) declining consent resolves onConsent false without ending the journey", async () => {
		renderAt("/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc");

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
});
