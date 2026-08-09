// @vitest-environment happy-dom
/**
 * REGRESSION (fetchToken timing): reproduces the intermittent
 * "We could not start your check-in" that appeared after the zero-lifecycle
 * `<ChecktivJourney>` refactor.
 *
 * The real SDK's `Checktiv.mount()` calls `fetchToken()` SYNCHRONOUSLY from inside
 * `<ChecktivJourney>`'s OWN mount effect (init.ts `mount` -> `mountProvisioned` ->
 * `resolveSession` -> `getSessionToken` -> `fetchToken`, all before the first
 * `await`). React fires CHILD effects BEFORE PARENT effects, so that call happens
 * BEFORE `CheckInPage`'s stash-write effect. When `fetchToken` resolved the token by
 * re-reading `sessionStorage` (the stash), a FRESH open read an EMPTY stash and threw
 * "Missing check-in token" -> the SDK surfaced a non-recoverable idv error -> the page
 * showed the terminal error. A reload "worked" only because the failed visit's parent
 * effect had by then written the stash - hence the intermittency.
 *
 * The existing `CheckInPage.test.tsx` misses this because its `<ChecktivJourney>`
 * double calls `fetchToken()` from the TEST body AFTER the effect flush (stash already
 * written). This double instead calls it from a CHILD effect, mirroring the real
 * ordering. The fix resolves `fetchToken` from the render-time `scope` (fragment or
 * stash captured synchronously in a lazy `useState`), so it no longer races the write.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import CheckInPage from "../../src/react-app/routes/CheckInPage";

// The collect gate that now precedes the journey uses the SDK's programmatic collector;
// mock it so importing the page does not load the real SDK data-plane and a confirm
// advances to the journey deterministically.
vi.mock("@checktiv/sdk-web/collect-user-info", () => ({
	collectUserInfo: () => ({
		submit: async () => ({ ok: true }),
		// The form probes describe() on mount; return the no-collect-config result so it
		// renders its full static field set.
		describe: async () => ({ ok: false, code: "not_collect_step" }),
	}),
}));

// Records what `fetchToken()` resolved/threw when called from the child effect.
const { resultRef } = vi.hoisted(() => ({
	resultRef: { current: null as { ok: string } | { err: string } | null },
}));

// The double mirrors the real SDK's timing: it calls `props.fetchToken()` from its
// OWN (child) effect, which React runs BEFORE the parent `CheckInPage` stash-write
// effect - the exact window the production bug lived in.
vi.mock("@checktiv/sdk-web/react", async () => {
	const { useEffect } = await import("react");
	return {
		ChecktivJourney: ({ fetchToken }: { fetchToken: () => Promise<string> }) => {
			useEffect(() => {
				void fetchToken().then(
					(t) => {
						resultRef.current = { ok: t };
					},
					(e: unknown) => {
						resultRef.current = { err: e instanceof Error ? e.message : String(e) };
					},
				);
			}, [fetchToken]);
			return null;
		},
	};
});

beforeEach(() => {
	sessionStorage.clear();
	resultRef.current = null;
	// The collect gate fetches a guest-safe prefill; stub it to fail so the form readies
	// with empty fields (the resilient fallback) and the test can drive it.
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
});

afterEach(() => {
	cleanup();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("resolves fetchToken on a FRESH open when the SDK calls it from its mount effect (after the collect gate, before the stash-write effect)", async () => {
	render(
		<MemoryRouter initialEntries={["/checkin/r1#ct=tok123&pk=ah_pk_us_test_abc"]}>
			<Routes>
				<Route path="/checkin/:id" element={<CheckInPage />} />
			</Routes>
		</MemoryRouter>,
	);

	// The journey (hence the SDK's `fetchToken` mount call) only mounts AFTER the collect
	// gate, so confirm the prefilled details first.
	fireEvent.change(await screen.findByLabelText("Legal name"), { target: { value: "Ada" } });
	// Blur the legal name to reveal the structured name fields (progressive disclosure).
	fireEvent.blur(screen.getByLabelText("Legal name"));
	fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ada" } });
	fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Lovelace" } });
	fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: "1 Way" } });
	fireEvent.change(screen.getByLabelText("City"), { target: { value: "London" } });
	fireEvent.change(screen.getByLabelText("Country (ISO code)"), { target: { value: "GB" } });
	fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

	await waitFor(() => expect(resultRef.current).not.toBeNull());

	// Before the fix, `fetchToken` re-read an empty stash here (the parent stash-write
	// effect had not run yet) and rejected with "Missing check-in token". The fix
	// resolves from the render-time `scope`, so a fresh open resolves the token.
	expect(resultRef.current).toEqual({ ok: "tok123" });
});
