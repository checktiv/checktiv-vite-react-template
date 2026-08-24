/**
 * What this teaches / copy this pattern:
 * Exercises `geoRoute()` in the REAL Workers runtime, driving it through the
 * `CF-IPCountry` request header exactly as Cloudflare's edge would.
 *
 * The load-bearing group is the NON-country group. `CF-IPCountry` is documented to
 * carry `XX` for a client with no country data and `T1` for a client on the Tor
 * network, and both are well-formed two-letter strings. A shape check alone would
 * pass them straight through to a form and pre-select "XX" as a guest's country.
 * These tests pin that they come back as `null`, which the browser reads as "no
 * pre-selection".
 *
 * The route binds nothing and reads no storage, which is the whole reason it is not
 * a field on the D1-gated `GET /api/checkin/:id` (see `src/worker/geo.ts`). The
 * env-less `app.request(path, init, {})` calls below are that claim being tested,
 * not a shortcut: this route answers identically in the deployed, binding-free shape.
 */
import { describe, it, expect } from "vitest";
import { geoRoute } from "../../src/worker/geo";

/** Call `GET /api/geo` with an optional `CF-IPCountry`, returning the parsed body. */
async function getGeo(headerValue?: string): Promise<{ country: string | null }> {
	const app = geoRoute();
	const res = await app.request(
		"/api/geo",
		headerValue === undefined ? {} : { headers: { "CF-IPCountry": headerValue } },
		{},
	);
	expect(res.status).toBe(200);
	return (await res.json()) as { country: string | null };
}

describe("geoRoute - a usable country signal", () => {
	it("returns the alpha-2 country from CF-IPCountry", async () => {
		expect(await getGeo("GB")).toEqual({ country: "GB" });
	});

	it("normalizes a lowercase header value to uppercase alpha-2", async () => {
		// Nothing at Cloudflare's edge sends lowercase today. The normalization is at
		// the boundary because a header is caller-influenced input, and an unnormalized
		// "gb" would silently fail the dropdown's membership check downstream.
		expect(await getGeo("gb")).toEqual({ country: "GB" });
	});
});

describe("geoRoute - no usable signal is 200 + null, never an error status", () => {
	it("returns null when the header is absent (the local-dev and non-Cloudflare case)", async () => {
		// This is the ONLY outcome under `vite dev` / `vite preview`: no Cloudflare edge
		// sits in front of the Worker, so the header does not exist. It is an ordinary
		// state, not a failure, which is why it is a 200 rather than a 404.
		expect(await getGeo()).toEqual({ country: null });
	});

	it("returns null for XX (client without country code data)", async () => {
		expect(await getGeo("XX")).toEqual({ country: null });
	});

	it("returns null for T1 (client on the Tor network)", async () => {
		expect(await getGeo("T1")).toEqual({ country: null });
	});

	it("returns null for a malformed header value rather than a truncated guess", async () => {
		// The case that made this test worth writing. An earlier version copied the
		// hosted journey's `trim().toUpperCase().slice(0, 2)` normalizer, which turned
		// "United Kingdom" into "UN" - a well-formed two-letter string that sailed
		// through the shape check and would have pre-selected a country nobody lives in.
		// Truncating an arbitrary header manufactures a wrong answer; rejecting it does
		// not. See `src/shared/country.ts`.
		expect(await getGeo("United Kingdom")).toEqual({ country: null });
		expect(await getGeo("1")).toEqual({ country: null });
		expect(await getGeo("")).toEqual({ country: null });
	});
});

describe("geoRoute - it discloses nothing about anyone else", () => {
	it("returns ONLY the country key, so no request metadata can ride along", async () => {
		const app = geoRoute();
		const res = await app.request("/api/geo", { headers: { "CF-IPCountry": "DE" } }, {});
		const body = (await res.json()) as Record<string, unknown>;
		// Exact shape: the route reports one property of the caller's own request and
		// nothing else. An `toEqual` here is deliberate, mirroring the guest-safe
		// prefill route's own contract test.
		expect(body).toEqual({ country: "DE" });
	});
});
