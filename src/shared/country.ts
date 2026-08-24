/**
 * What this teaches / copy this pattern:
 * The one country-code rule the Worker and the browser must agree on, in ONE place
 * so they cannot drift. The Worker reads a geo signal off the request and the
 * browser decides whether to pre-select it; a second copy of "what counts as a
 * country code" on either side is how a sentinel like `XX` ends up selected in a
 * dropdown.
 *
 * Nothing here knows the list of countries. That list is a UI concern and lives in
 * `src/react-app/lib/countries.ts`, so the Worker bundle never carries it.
 */

/**
 * The values Cloudflare documents for `CF-IPCountry` that are NOT countries.
 *
 * `XX` is "clients without country code data" and `T1` is "clients using the Tor
 * network" (Cloudflare's HTTP request headers reference). Both are well-formed
 * two-letter strings, so a shape check alone would happily pre-select "XX" as
 * someone's country. Neither may ever reach a form field.
 */
const NON_COUNTRY_GEO_CODES: ReadonlySet<string> = new Set(["XX", "T1"]);

/**
 * Read a usable alpha-2 country out of a `CF-IPCountry` header value, or `null`.
 *
 * `null` is the honest answer in three distinct situations, and the caller must
 * treat all three the same way (no pre-selection at all):
 *
 *   - The header is ABSENT. There is no Cloudflare edge in front of `vite dev` or
 *     `vite preview`, so this is the normal local-development case, not an error.
 *   - The header is a documented non-country sentinel (`XX`, `T1`).
 *   - The header is malformed. Nothing produces that today; it is here because a
 *     header is caller-influenced input at the edge of the system.
 *
 * ## Why this does NOT truncate to two characters
 *
 * The hosted Checktiv journey normalizes its country value with
 * `trim().toUpperCase().slice(0, 2)`, and copying that here was a BUG the tests
 * caught: `"United Kingdom"` sliced to `"UN"`, which then passed the two-letter
 * shape check and would have pre-selected a country nobody lives in.
 *
 * The difference is where the value comes from. There, the input is a value the UI
 * itself produced from a fixed `<select>`, so truncation only ever tidies; here the
 * input is an arbitrary header, where truncation MANUFACTURES a plausible-looking
 * wrong answer out of a malformed one. So the whole trimmed value must be exactly
 * two letters, and anything else is rejected rather than trimmed into shape.
 *
 * @param raw - The raw header value, or `null`/`undefined` when it is absent.
 * @returns An uppercase alpha-2 code, or `null` when there is no usable signal.
 */
export function geoCountryFromHeader(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const code = raw.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(code)) return null;
	if (NON_COUNTRY_GEO_CODES.has(code)) return null;
	return code;
}
