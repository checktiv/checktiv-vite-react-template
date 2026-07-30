/**
 * What this teaches / copy this pattern:
 * A Checktiv secret key encodes everything the demo needs to reach the right cell:
 * `ah_sk_<region>_<mode>_<random>`. This module parses that prefix into a
 * `KeyContext` (region + mode + the region's static origins). The parser is the
 * single producer(key-format) -> consumer(origins) contract; it is anchored and
 * accepts BOTH `test` and `live` keys (the real demo keys are `live`), rejecting
 * only non-secret / malformed prefixes with `InvalidKeyError`.
 *
 * SSRF note: origins come from the static region table in `origins.ts`, never from
 * request input. Do not add a code path that derives `apiBase` from user data.
 */
import {
	resolveOrigins,
	type Origins,
	type OriginOverrides,
	type Region,
} from "./origins";

export type { Region, OriginOverrides };

/** Key mode. `test` meters synthetic verifications; `live` runs real ones. */
export type KeyMode = "test" | "live";

/** Everything derived from a secret key: where to call + how to badge the UI. */
export interface KeyContext extends Origins {
	region: Region;
	mode: KeyMode;
}

/**
 * The full bring-your-own-key config the visitor supplies at Setup.
 *
 * `publishableKey` (`ah_pk_...`) is a PUBLIC key: it is safe in the guest
 * check-in link fragment and the client bundle, and it is what the browser SDK
 * sends as `X-Publishable-Key` so sdk-api can match a third-party customer
 * origin against the key's allowlist (the first-party `{region,mode}` scope
 * never sends it, so a cross-origin guest mount is CORS-blocked). It is NOT the
 * secret key - `ctx` is still derived from `secretKey`, which stays server-side
 * (proxy header only), never in a link or bundle.
 */
export interface DemoConfig {
	secretKey: string;
	publishableKey: string;
	workflowTemplateId: string;
	ctx: KeyContext;
}

/** Thrown when a supplied string is not a well-formed Checktiv secret key. */
export class InvalidKeyError extends Error {
	constructor(
		message = "Enter a valid Checktiv secret key (it starts with ah_sk_).",
	) {
		super(message);
		this.name = "InvalidKeyError";
	}
}

/** Thrown when a supplied string is not a well-formed Checktiv publishable key. */
export class InvalidPublishableKeyError extends Error {
	constructor(
		message = "Enter a valid Checktiv publishable key (it starts with ah_pk_).",
	) {
		super(message);
		this.name = "InvalidPublishableKeyError";
	}
}

/**
 * Anchored secret-key format. Capture groups: 1 = region, 2 = mode. Publishable
 * (`ah_pk_...`) and any other prefix do not match, so they are rejected.
 */
const SECRET_KEY_RE = /^ah_sk_(us|eu)_(test|live)_.+$/;

/**
 * Anchored publishable-key format. Capture groups: 1 = region, 2 = mode. Mirrors
 * `SECRET_KEY_RE` but pins the `ah_pk_` prefix; a secret key (`ah_sk_...`) or any
 * other prefix does not match, so they are rejected.
 */
const PUBLISHABLE_KEY_RE = /^ah_pk_(us|eu)_(test|live)_.+$/;

/**
 * Parse a secret key into its `KeyContext`. Optional static `overrides` support
 * custom-domain orgs (see `origins.ts`); they are never request-derived.
 *
 * @throws {InvalidKeyError} when `secretKey` is not a well-formed `ah_sk_` key.
 */
export function deriveKeyContext(
	secretKey: string,
	overrides?: OriginOverrides,
): KeyContext {
	const match = SECRET_KEY_RE.exec(secretKey);
	if (match === null) {
		throw new InvalidKeyError();
	}
	const region = match[1] as Region;
	const mode = match[2] as KeyMode;
	return { region, mode, ...resolveOrigins(region, overrides) };
}

/**
 * Parse a publishable key into the cell it addresses. The SDK derives region and
 * mode FROM the pk (see `parsePublishableKey` in `@checktiv/sdk-web`), so this
 * mirror lets the demo cross-check the pk against the secret key at Setup.
 *
 * @throws {InvalidPublishableKeyError} when `publishableKey` is not a well-formed
 *   `ah_pk_` key.
 */
export function parsePublishableKey(publishableKey: string): {
	region: Region;
	mode: KeyMode;
} {
	const match = PUBLISHABLE_KEY_RE.exec(publishableKey);
	if (match === null) {
		throw new InvalidPublishableKeyError();
	}
	return { region: match[1] as Region, mode: match[2] as KeyMode };
}

/** Boolean well-formedness gate for a publishable key (guest-page fragment). */
export function isValidPublishableKey(value: string): boolean {
	return PUBLISHABLE_KEY_RE.test(value);
}

/**
 * Defensive Setup-time cross-check: the publishable key must be well-formed AND
 * address the SAME cell as the secret key. A pk from a different region/mode would
 * otherwise mount the guest flow against the wrong cell and fail opaquely.
 *
 * @throws {InvalidPublishableKeyError} when the pk is malformed or its region/mode
 *   does not match `ctx`.
 */
export function assertPublishableKeyMatchesContext(
	publishableKey: string,
	ctx: KeyContext,
): void {
	const parsed = parsePublishableKey(publishableKey);
	if (parsed.region !== ctx.region || parsed.mode !== ctx.mode) {
		throw new InvalidPublishableKeyError(
			"This publishable key is for a different region or mode than your secret key.",
		);
	}
}

/**
 * Lightweight Setup-time check for a workflow template id. Mirrors the wire
 * contract (`workflow_template_id` must start with `wt_`) and requires a non-empty
 * id so a typo fails fast at Setup rather than as a mid-booking 422 from the mint
 * call.
 */
export function isValidWorkflowTemplateId(id: string): boolean {
	return /^wt_.+$/.test(id.trim());
}

/**
 * Workflow step check types this demo cannot run, so Setup filters out any template
 * that includes one.
 *
 * The guest journey (`<ChecktivJourney>`) imports the identity-verification renderer
 * (`@checktiv/sdk-web/idv`) plus the consent-gated fraud signal. Server-side checks
 * (`watchlist`, `background_us_criminal`, `background_global`) run WITHOUT an
 * applicant screen, so a template that pairs them with `id_verification` runs fine
 * and is NOT filtered. `collect_user_info` and `custom_form` are applicant-rendered
 * steps this demo does not import (`@checktiv/sdk-web/custom-form` is not loaded), so
 * a template that includes either would reach a step the SDK cannot mount
 * (`sdk_load_failed`); Setup blocks those.
 */
export const DEMO_UNSUPPORTED_CHECK_TYPES = ["collect_user_info", "custom_form"] as const;

/**
 * True when a template can run in this demo: it includes NONE of the
 * demo-unsupported check types (see {@link DEMO_UNSUPPORTED_CHECK_TYPES}). A template
 * with only server-side checks (or an empty / unreadable step list) is not blocked -
 * Setup still lets the applicant proceed and the journey mounts whatever the session
 * declares.
 */
export function isTemplateDemoSupported(checkTypes: readonly string[]): boolean {
	const unsupported = new Set<string>(DEMO_UNSUPPORTED_CHECK_TYPES);
	return !checkTypes.some((type) => unsupported.has(type));
}
