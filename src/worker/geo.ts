/**
 * What this teaches / copy this pattern:
 * A one-route sub-app that hands the browser the ONE thing only the edge knows:
 * which country the visitor's request appears to come from, read off Cloudflare's
 * `CF-IPCountry` header. The guest check-in form uses it to pre-select the address
 * country instead of making every guest scroll a 248-entry dropdown from the top.
 *
 * ## Why this is its own route and not a field on `GET /api/checkin/:id`
 *
 * The obvious home for it is the existing guest-safe prefill read, which already
 * returns `{ guestName, guestEmail }` for the same page. Two things rule that out:
 *
 *   1. **That route is D1-gated and the deployed demo binds no D1.** It answers a
 *      structured 501 in production by design (`wrangler.jsonc` defines
 *      `d1_databases` only at the top level, and `scripts/assert-no-d1-in-deploy-env.mjs`
 *      keeps it that way). A country carried on that response would therefore work
 *      in local development and never on the live demo. Geo has no such dependency,
 *      so it must not inherit one.
 *   2. **It is deliberately narrow, and its contract test pins that.** The route
 *      returns exactly two fields and `tests/worker/reservations.route.test.ts`
 *      asserts the whole body with `toEqual`, precisely so a future edit cannot
 *      quietly widen a guest-readable endpoint. Adding a third key would have meant
 *      editing that assertion, which is the guard doing its job, not a formality.
 *
 * The two responsibilities are also different in kind. `/api/checkin/:id` projects
 * a stored RESERVATION; this route reports a property of the CALLER'S OWN REQUEST
 * and reads no storage at all. That is why it can answer in every deployment shape,
 * and why it discloses nothing: it tells you only what your own connection already
 * told Cloudflare.
 *
 * ## It always answers 200
 *
 * No signal is `{ country: null }`, not a 404 or a 204. The absence of a geo
 * reading is an ordinary outcome (it is the ONLY outcome under `vite dev` and
 * `vite preview`, where there is no Cloudflare edge in front of the Worker), and a
 * caller that has to distinguish "no country" from "route is broken" would end up
 * writing the same fallback twice.
 */
import { Hono } from "hono";
import { geoCountryFromHeader } from "../shared/country";

/**
 * `GET /api/geo` -> `{ country: "GB" }` or `{ country: null }`.
 *
 * Registered at its final absolute path (mirroring `checktivProxy` and
 * `reservationsRoute`) so the composition root mounts the result with no path
 * rewriting and the tests call the SAME path a real deploy would.
 *
 * Reads no bindings, so it takes no env type: it is correct in every deployment
 * shape, including the D1-free deployed one.
 */
export function geoRoute() {
	const app = new Hono();

	app.get("/api/geo", (c) =>
		c.json({ country: geoCountryFromHeader(c.req.header("CF-IPCountry")) }),
	);

	return app;
}
