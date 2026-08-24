/**
 * What this teaches / copy this pattern:
 * The ONE field-level validation shape shared by the Worker proxy (producer) and the
 * browser client (consumer), so the two halves cannot drift.
 *
 * Checktiv's REST error envelope is `{ error: { code, message, details } }`, and a 422
 * carries `details.issues[]` describing exactly WHICH field was rejected and why. That
 * detail is the difference between an integrator who can fix their payload in one pass
 * and one who is stuck: a retired-field migration message ("`first_name` was removed,
 * use `given_names`") lives in `issues[].message`, and the offending request keys live
 * in `issues[].keys`. A proxy that collapses all of that into a single generic sentence
 * is a dead-end, so `checktiv-proxy` forwards a SANITIZED copy of it instead.
 *
 * Sanitized means: only these three fields survive, each length-capped, and any issue
 * whose text contains a credential marker is dropped outright (see
 * `sanitizeIssues`). The raw upstream body NEVER escapes the proxy.
 */

/** A single sanitized field-level validation issue from an upstream 422. */
export interface ValidationIssue {
	/**
	 * The schema's own message for this issue. This is where a retired-field
	 * migration hint appears, so it is the field an integrator actually needs.
	 */
	message: string;
	/** The offending request keys, when the issue names them (`unrecognized_keys`). */
	keys?: string[];
	/** Dotted path to the offending field, e.g. `applicant.family_name`. */
	path?: string;
}

/** Cap on how many issues are forwarded, so a pathological body cannot be echoed wholesale. */
export const MAX_FORWARDED_ISSUES = 5;

/** Cap on a single forwarded issue message, in characters. */
export const MAX_ISSUE_MESSAGE_LENGTH = 300;

/**
 * Substrings that must never appear in an error body leaving the proxy. Checktiv keys
 * ride the `Authorization` header and tokens ride response bodies, so neither belongs
 * in an upstream validation issue - but the guard is unconditional rather than
 * trusting the upstream to be well-behaved.
 */
const CREDENTIAL_MARKERS = ["ah_sk_", "ah_pk_", "Bearer", "Authorization"] as const;

/** True when `text` carries no credential-shaped marker and is therefore safe to forward. */
export function isCredentialFree(text: string): boolean {
	return !CREDENTIAL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Render one issue as a single actionable sentence for a human-facing error string:
 * `applicant.family_name: must not be blank`. The path prefix is what tells the reader
 * WHICH field to go fix, so it is kept when present.
 */
export function formatIssue(issue: ValidationIssue): string {
	return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}
