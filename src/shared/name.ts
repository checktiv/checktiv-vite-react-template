/**
 * What this teaches / copy this pattern:
 * A small pure helper that splits one "legal name" string into best-effort
 * first / middle / last parts for a progressive-disclosure name form. The guest
 * reviews and edits every part afterward, so an imperfect split is fine - the
 * value is giving the guest a sensible starting point they can correct.
 *
 * Rules (whitespace-collapsed tokens):
 *   - 0 tokens  -> all empty
 *   - 1 token   -> first only (middle + last empty)
 *   - 2 tokens  -> first + last (middle empty)
 *   - 3+ tokens -> first = first token, last = last token, middle = the interior
 *                  tokens joined by a single space
 *
 * This is the three-part superset of `CheckInPage`'s first/last-only
 * `splitGuestName`; the collect form uses it so a middle name in the reservation
 * legal name lands in its own field instead of being folded into the last name.
 */
export interface SplitLegalName {
	first: string;
	middle: string;
	last: string;
}

/** Best-effort split of a full legal name into first / middle / last parts. */
export function splitLegalName(fullName: string): SplitLegalName {
	const parts = fullName.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { first: "", middle: "", last: "" };
	if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
	if (parts.length === 2) return { first: parts[0], middle: "", last: parts[1] };
	return {
		first: parts[0],
		middle: parts.slice(1, -1).join(" "),
		last: parts[parts.length - 1],
	};
}
