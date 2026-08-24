/**
 * What this teaches / copy this pattern:
 * The country dropdown's option list, built from a hardcoded ISO 3166-1 alpha-2
 * CODE list plus `Intl.DisplayNames` for the English labels.
 *
 * ## Why codes only, and not code + label pairs
 *
 * The obvious alternative is to hardcode 248 `{ code, label }` pairs. Measured on
 * this exact list, minified: pairs are 5,949 bytes raw / 2,220 gzipped, codes
 * alone are 1,239 / 511. So generating the labels saves about 4.7 KB raw and
 * 1.7 KB gzipped, and - the reason that mattered more here - it keeps 248 lines
 * of reference data out of a sample app whose job is to be read. A developer
 * opening this repo is here for the Checktiv integration, not for a copy of
 * ISO 3166.
 *
 * What that costs, stated plainly:
 *
 *   - **Labels come from the browser's ICU data**, so two visitors on different
 *     browsers can see slightly different wording for the same country. That is
 *     acceptable HERE because the label is presentation only: the submitted value
 *     is the alpha-2 code, and it is identical either way. It would NOT be
 *     acceptable on a surface where the displayed string is itself the record.
 *   - **`Intl.DisplayNames` is a browser API** (Chrome 81+, Safari 14.1+, Firefox
 *     86+). Where it is missing, {@link COUNTRY_OPTIONS} falls back to showing the
 *     raw codes. The dropdown stays complete and usable, just less friendly - a
 *     degraded label, never a dead end.
 *   - **Sort order is computed at runtime** rather than baked in, so it follows
 *     whatever labels this browser produced.
 *
 * The CODE SET is deliberately identical to the one the hosted Checktiv journey
 * offers, so the two forms present the same countries even though only one of
 * them ships the names.
 */

/**
 * Codes shown FIRST, in this order, before the alphabetical remainder.
 *
 * Ordered most-common-first rather than alphabetically, and the Western-market
 * bias is intentional: it keeps the short, fast path for the markets this demo is
 * most often shown in, while the full list below covers everyone else. It is a
 * presentation choice, not a statement about which countries matter.
 */
const FREQUENT_CODES: ReadonlyArray<string> = [
	"US", "CA", "GB", "AU", "NZ", "IE", "DE", "FR", "ES", "IT", "NL", "BE",
	"CH", "SE", "NO", "DK", "FI",
];

/**
 * The full ISO 3166-1 alpha-2 set offered by the dropdown (248 entries).
 *
 * Rendered as ONE flat list rather than `<optgroup>`s: screen readers vary in how
 * they announce a group, the visual divider browsers add is unreliable on mobile,
 * and a single list keeps type-ahead-by-letter predictable once the guest is past
 * the frequent block.
 */
const COUNTRY_CODES: ReadonlyArray<string> = [
	"AF", "AX", "AL", "DZ", "AS", "AD", "AO", "AI", "AQ", "AG", "AR", "AM",
	"AW", "AU", "AT", "AZ", "BS", "BH", "BD", "BB", "BY", "BE", "BZ", "BJ",
	"BM", "BT", "BO", "BQ", "BA", "BW", "BV", "BR", "IO", "BN", "BG", "BF",
	"BI", "CV", "KH", "CM", "CA", "KY", "CF", "TD", "CL", "CN", "CX", "CC",
	"CO", "KM", "CG", "CD", "CK", "CR", "HR", "CU", "CW", "CY", "CZ", "DK",
	"DJ", "DM", "DO", "EC", "EG", "SV", "GQ", "ER", "EE", "SZ", "ET", "FK",
	"FO", "FJ", "FI", "FR", "GF", "PF", "TF", "GA", "GM", "GE", "DE", "GH",
	"GI", "GR", "GL", "GD", "GP", "GU", "GT", "GG", "GN", "GW", "GY", "HT",
	"HM", "VA", "HN", "HK", "HU", "IS", "IN", "ID", "IR", "IQ", "IE", "IM",
	"IL", "IT", "JM", "JP", "JE", "JO", "KZ", "KE", "KI", "KP", "KR", "KW",
	"KG", "LA", "LV", "LB", "LS", "LR", "LY", "LI", "LT", "LU", "MO", "MG",
	"MW", "MY", "MV", "ML", "MT", "MH", "MQ", "MR", "MU", "YT", "MX", "FM",
	"MD", "MC", "MN", "ME", "MS", "MA", "MZ", "MM", "NA", "NR", "NP", "NL",
	"NC", "NZ", "NI", "NE", "NG", "NU", "NF", "MK", "MP", "NO", "OM", "PK",
	"PW", "PS", "PA", "PG", "PY", "PE", "PH", "PN", "PL", "PT", "PR", "QA",
	"RE", "RO", "RU", "RW", "BL", "SH", "KN", "LC", "MF", "PM", "VC", "WS",
	"SM", "ST", "SA", "SN", "RS", "SC", "SL", "SG", "SX", "SK", "SI", "SB",
	"SO", "ZA", "GS", "SS", "ES", "LK", "SD", "SR", "SJ", "SE", "CH", "SY",
	"TW", "TJ", "TZ", "TH", "TL", "TG", "TK", "TO", "TT", "TN", "TR", "TM",
	"TC", "TV", "UG", "UA", "AE", "GB", "US", "UM", "UY", "UZ", "VU", "VE",
	"VN", "VG", "VI", "WF", "EH", "YE", "ZM", "ZW",
];

/** Fast membership test for the dropdown's code set. */
const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

/**
 * Fail LOUD at module load if a frequent code is not in the full list.
 *
 * A typo here would silently drop a country from the top of the dropdown, and the
 * only symptom would be a guest scrolling further than they should. It is a
 * programming error with a deterministic input, so it is checked once, at import,
 * and it throws. Note the asymmetry with the runtime degradation below: a missing
 * `Intl.DisplayNames` is a fact about the visitor's browser and must never break
 * their check-in, so THAT case falls back instead of throwing.
 */
for (const code of FREQUENT_CODES) {
	if (!COUNTRY_CODE_SET.has(code)) {
		throw new Error(`[countries] frequent code ${code} is missing from COUNTRY_CODES`);
	}
}

/** One dropdown entry: the alpha-2 value submitted, and the text the guest reads. */
export interface CountryOption {
	code: string;
	label: string;
}

/**
 * The dropdown's options: frequent markets first (in their declared order), then
 * every remaining country sorted alphabetically by the label THIS browser
 * produced.
 *
 * Computed once at module load. The input is a constant and the output is pure,
 * so there is nothing per-request to stale out; the `Intl.DisplayNames` instance
 * is built once rather than 248 times.
 *
 * The whole construction is wrapped because `Intl.DisplayNames` can be absent
 * (older browsers) or throw on an unexpected locale. Either way the list is still
 * returned, labeled with the raw codes, so the guest can always complete the form.
 */
export const COUNTRY_OPTIONS: ReadonlyArray<CountryOption> = (() => {
	const label = resolveLabeler();
	const frequent = FREQUENT_CODES.map((code) => ({ code, label: label(code) }));
	const rest = COUNTRY_CODES.filter((code) => !FREQUENT_CODES.includes(code))
		.map((code) => ({ code, label: label(code) }))
		.sort((a, b) => a.label.localeCompare(b.label, "en"));
	return [...frequent, ...rest];
})();

/**
 * Build the code -> English-name function, degrading to the identity function
 * when the platform cannot do it.
 *
 * `Intl.DisplayNames` returns `undefined` for a code its ICU data does not know
 * (`fallback: "none"` is not requested, but the type still allows it), so each
 * lookup falls back to the code as well. A dropdown reading "AQ" is worse than one
 * reading "Antarctica" and better than one missing the entry.
 */
function resolveLabeler(): (code: string) => string {
	try {
		const display = new Intl.DisplayNames(["en"], { type: "region" });
		return (code) => display.of(code) ?? code;
	} catch {
		return (code) => code;
	}
}

/**
 * True when `code` is a country this dropdown can actually show as selected.
 *
 * This is the gate on the geo suggestion, and it is why the demo does NOT copy the
 * hosted journey's "render an unknown value as an extra leading option" trick.
 * That trick exists to protect a value a PERSON already committed to, which must
 * never be silently rewritten by a dropdown. The country arriving here is a
 * MACHINE GUESS from an IP lookup, and there is no data to lose by discarding one
 * this list does not recognize: falling back to no pre-selection is strictly safer
 * than showing a guest a bare two-letter code they did not choose.
 */
export function isSelectableCountry(code: string): boolean {
	return COUNTRY_CODE_SET.has(code);
}
