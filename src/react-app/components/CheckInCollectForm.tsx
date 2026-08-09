/**
 * What this teaches / copy this pattern:
 * The "bring your own form" applicant-info step (CT-377 mode b) wired INTO the guest
 * check-in journey. A developer who owns their OWN form and PII handling supplies the
 * applicant's details PROGRAMMATICALLY via `@checktiv/sdk-web/collect-user-info`,
 * instead of mounting an SDK-rendered form. This component renders a prefilled,
 * guest-facing "confirm your details" card and calls `collector.submit(...)`; on
 * success it advances the host to the SDK-rendered identity journey
 * (`<ChecktivJourney>` in `CheckInPage`).
 *
 * WHICH fields to render is not guessed: on mount the component calls
 * `collector.describe()` once and drives the form from the workflow template's own
 * config. `describe()` returns `{ ok, fields, captureStructuredName }` where `fields`
 * is the set of OPTIONAL contact fields (email / phone / dob / address) the template
 * collects, and `captureStructuredName` says whether to collect structured
 * first/middle/last vs a single legal name. The legal name is ALWAYS required. Fields
 * the template does NOT ask for are hidden; fields it DOES ask for are shown and marked
 * expected for this template (the server stays the authority - the marks are UX only).
 * When `describe()` returns `{ ok:false }` or the probe throws, the form GRACEFULLY
 * FALLS BACK to a full static field set so it still works with no dead-end.
 *
 * How it fits the journey:
 *   1. `CheckInPage` resolves the durable `client_token` + publishable key from the
 *      check-in link fragment and fetches a guest-safe prefill
 *      (`GET /api/checkin/:id` -> legal name + email) for THIS reservation.
 *   2. This component probes `describe()`, renders the prefilled form for the resolved
 *      config; the guest reviews/edits and adds the remaining fields. On confirm it
 *      builds the camelCase applicant body and calls
 *      `collectUserInfo({ session }).submit(...)`. The SDK resolves the collect step
 *      from the session and POSTs; the server validates authoritatively (country-aware
 *      completeness + PII encryption).
 *   3. The result is a closed `{ ok } | { ok:false, code, message }` taxonomy. On `ok`
 *      - OR `not_collect_step` (the session has no collect step to satisfy, so there is
 *      nothing to block on) - the host advances to the identity journey. Every OTHER
 *      code maps to an actionable inline hint (no dead-ends, the demo's PLG rule) with a
 *      retry.
 *
 * `background_global` (when the session declares it) runs server-side on the submitted
 * name and resolves asynchronously in the workflow poll phase; the staff reviewer /
 * status surfaces show its outcome, so this component does not poll.
 *
 * DEV-TEST-ONLY dev-cell targeting: `sdkApiBase` for the SDK data-plane comes from the
 * build-time `VITE_CHECKTIV_DEV_CELL` flag via `devCellSdkApiBase()` (see
 * `lib/dev-cell.ts`), passed down by `CheckInPage`, and is `undefined` (prod) by
 * default. This is how the harness validates the unpublished submit path against dev-us
 * before the SDK is published.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
	collectUserInfo,
	type CollectUserInfoAddress,
	type CollectUserInfoCollector,
	type CollectUserInfoConfigResult,
	type CollectUserInfoSubmitErrorCode,
	type CollectUserInfoSubmitInput,
} from "@checktiv/sdk-web/collect-user-info";
import { splitLegalName } from "../../shared/name";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * Actionable hint per closed submit-error code. `satisfies Record<code, string>` is the
 * compile-time exhaustiveness guard: a new SDK error code fails `tsc -b` here until it
 * is mapped, so a code can never fall through to a blank/dead-end message. `ok` and
 * `not_collect_step` advance the journey rather than showing a hint, so `not_collect_step`'s
 * text is never displayed - it is kept only to satisfy the exhaustive map. The
 * `validation_failed` entry here is a generic fallback: the displayed copy is computed by
 * `validationFailedHint()` so it names the field GROUP(s) the template collects (the server
 * 400 is opaque). No m-dashes; US spelling.
 */
const SUBMIT_ERROR_HINTS = {
	not_collect_step:
		"This step is already complete. Continue to the identity check.",
	validation_failed:
		"Some details could not be accepted. Check your legal name and a complete address (address line 1, city, and country), then confirm again.",
	token_expired:
		"Your check-in link timed out. Reopen the check-in link from your reservation, then confirm again.",
	session_expired:
		"Your check-in link expired. Contact the property for a fresh link, then confirm again.",
	wrong_token_type:
		"Your check-in link is not valid for this step. Reopen the check-in link from your reservation, then try again.",
	origin_not_allowed:
		"This demo site is not allowlisted for this Checktiv org. Add this origin to the publishable key in your Checktiv org settings, then confirm again.",
	rate_limited: "Too many attempts. Wait a moment, then confirm again.",
	service_unavailable:
		"The identity service is temporarily unavailable. Wait a moment, then confirm again.",
	network_error:
		"We could not reach the identity service. Check your connection, then confirm again.",
} satisfies Record<CollectUserInfoSubmitErrorCode, string>;

/**
 * Per-field visibility for an optional contact field:
 *   - `hidden`   the template does not collect it, so it is not rendered or submitted.
 *   - `optional` shown but not marked required (the static fallback labels every field
 *                "(optional)" so the guest can still supply anything).
 *   - `expected` the template asked for it, so it is shown, marked expected/required for
 *                this template, and submitted when present. The server stays authoritative.
 */
type FieldVisibility = "hidden" | "optional" | "expected";

/** The form shape resolved from `describe()` (or the static fallback). */
interface ResolvedCollectConfig {
	email: FieldVisibility;
	phone: FieldVisibility;
	dob: FieldVisibility;
	address: FieldVisibility;
	/** Collect structured first/middle/last vs a single legal-name input. */
	captureStructuredName: boolean;
}

/**
 * The static fallback used before `describe()` resolves and whenever it returns
 * `{ ok:false }` or throws: show every field as optional and offer the structured-name
 * breakdown. This is the form's pre-`describe()` behavior, kept so the component never
 * dead-ends on a probe failure.
 */
const FALLBACK_CONFIG: ResolvedCollectConfig = {
	email: "optional",
	phone: "optional",
	dob: "optional",
	address: "optional",
	captureStructuredName: true,
};

/** Map a `describe()` result to the resolved form config; fall back on `{ ok:false }`. */
function resolveConfig(result: CollectUserInfoConfigResult): ResolvedCollectConfig {
	if (!result.ok) return FALLBACK_CONFIG;
	const has = (field: "email" | "phone" | "dob" | "address") => result.fields.includes(field);
	return {
		email: has("email") ? "expected" : "hidden",
		phone: has("phone") ? "expected" : "hidden",
		dob: has("dob") ? "expected" : "hidden",
		address: has("address") ? "expected" : "hidden",
		captureStructuredName: result.captureStructuredName,
	};
}

/** Join groups for the hint copy: "a", "a and b", "a, b, and c". No m-dashes. */
function formatGroupList(groups: string[]): string {
	if (groups.length <= 1) return groups[0] ?? "";
	if (groups.length === 2) return `${groups[0]} and ${groups[1]}`;
	return `${groups.slice(0, -1).join(", ")}, and ${groups[groups.length - 1]}`;
}

/**
 * Actionable `validation_failed` copy that NAMES the field group(s) the template
 * collects, since the server 400 is opaque about which one was rejected. Legal name is
 * always listed (always required); each template-collected group is added so the guest
 * knows exactly where to look. US spelling; no m-dashes.
 */
function validationFailedHint(config: ResolvedCollectConfig): string {
	const groups = ["your legal name"];
	if (config.dob === "expected") groups.push("your date of birth");
	if (config.address !== "hidden")
		groups.push(
			"a complete address (address line 1, city, and country, plus state or region and postal code where your country uses them)",
		);
	if (config.email === "expected") groups.push("your email");
	if (config.phone === "expected") groups.push("your phone number");
	return `Some details could not be accepted. Check ${formatGroupList(groups)}, then confirm again.`;
}

/** The prefill `CheckInPage` derives from the guest-safe reservation read. */
export interface CheckInCollectPrefill {
	legalName: string;
	first: string;
	last: string;
	email: string;
}

/** The form's field values. Plain strings; empty optionals are dropped on submit. */
interface CollectFormValues {
	legalName: string;
	first: string;
	middle: string;
	last: string;
	email: string;
	phone: string;
	dateOfBirth: string;
	line1: string;
	line2: string;
	city: string;
	region: string;
	postalCode: string;
	country: string;
}

/**
 * Seed the editable form from the prefill; the guest fills the rest. The
 * structured name parts are derived from `legalName` via `splitLegalName` (not
 * from `prefill.first`/`prefill.last`) so a middle name in the reservation legal
 * name lands in its own field. They stay hidden until the legal name is
 * committed (see the `revealed` state), so seeding them here is harmless when the
 * prefill legal name is empty (all parts resolve to "").
 */
function initialValues(prefill: CheckInCollectPrefill): CollectFormValues {
	const parts = splitLegalName(prefill.legalName);
	return {
		legalName: prefill.legalName,
		first: parts.first,
		middle: parts.middle,
		last: parts.last,
		email: prefill.email,
		phone: "",
		dateOfBirth: "",
		line1: "",
		line2: "",
		city: "",
		region: "",
		postalCode: "",
		country: "",
	};
}

/**
 * Factory for the SDK collector, injectable so tests drive the submit result without
 * the real SDK data-plane. The default wires the real `collectUserInfo`.
 */
export type CreateCollector = (opts: {
	publishableKey: string;
	fetchToken: () => Promise<string>;
	apiBase?: string;
}) => CollectUserInfoCollector;

const defaultCreateCollector: CreateCollector = ({ publishableKey, fetchToken, apiBase }) =>
	collectUserInfo({ session: { publishableKey, fetchToken, apiBase } });

/**
 * Build the SDK submit input from the form, trimming and dropping empty optionals.
 * Only the fields the resolved template config renders are submitted: `name` rides only
 * when structured-name capture is on, `address` only when the address block is shown,
 * and each contact field only when it is not hidden and non-empty.
 */
function toSubmitInput(values: CollectFormValues, config: ResolvedCollectConfig): CollectUserInfoSubmitInput {
	const input: CollectUserInfoSubmitInput = {
		legalName: values.legalName.trim(),
	};

	if (config.captureStructuredName) {
		input.name = {
			first: values.first.trim(),
			last: values.last.trim(),
			...(values.middle.trim() ? { middle: values.middle.trim() } : {}),
		};
	}

	if (config.address !== "hidden") {
		const address: CollectUserInfoAddress = {
			line1: values.line1.trim(),
			city: values.city.trim(),
			country: values.country.trim(),
		};
		if (values.line2.trim()) address.line2 = values.line2.trim();
		if (values.region.trim()) address.region = values.region.trim();
		if (values.postalCode.trim()) address.postalCode = values.postalCode.trim();
		input.address = address;
	}

	if (config.email !== "hidden" && values.email.trim()) input.email = values.email.trim();
	if (config.phone !== "hidden" && values.phone.trim()) input.phone = values.phone.trim();
	if (config.dob !== "hidden" && values.dateOfBirth.trim())
		input.dateOfBirth = values.dateOfBirth.trim();
	return input;
}

/** A small inline banner for the actionable submit-error hint. */
function ErrorBanner({ children }: { children: ReactNode }) {
	return (
		<div
			className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
			role="alert"
		>
			{children}
		</div>
	);
}

/** The "(optional)" label suffix for a shown-but-optional field; empty when expected. */
function optionalSuffix(visibility: FieldVisibility): string {
	return visibility === "optional" ? " (optional)" : "";
}

/**
 * The prefilled collect step. `fetchToken` returns the durable `client_token`
 * (the SDK exchanges + refreshes working tokens internally); it may change identity per
 * render, so it is read through a ref to keep the collector stable. `onComplete` mounts
 * the identity journey.
 */
export function CheckInCollectForm({
	publishableKey,
	fetchToken,
	sdkApiBase,
	prefill,
	onComplete,
	createCollector = defaultCreateCollector,
}: {
	publishableKey: string;
	fetchToken: () => Promise<string>;
	sdkApiBase?: string;
	prefill: CheckInCollectPrefill;
	onComplete: () => void;
	createCollector?: CreateCollector;
}) {
	const [values, setValues] = useState<CollectFormValues>(() => initialValues(prefill));
	const [submitting, setSubmitting] = useState(false);
	const [errorHint, setErrorHint] = useState<string | null>(null);

	// The form shape resolved from `describe()`. Starts on the static fallback so the
	// form is fully usable before the probe resolves and if the probe fails; a successful
	// probe narrows it to the template's collected fields.
	const [config, setConfig] = useState<ResolvedCollectConfig>(FALLBACK_CONFIG);

	// Progressive disclosure of the structured first/middle/last row. Hidden until
	// the legal name is committed. A non-empty prefilled legal name (from the
	// reservation) counts as already committed, so the breakdown is shown on mount
	// without forcing the guest to blur an already-filled field; an empty legal name
	// stays collapsed until the guest types one and blurs.
	const [nameRevealed, setNameRevealed] = useState(() => prefill.legalName.trim().length > 0);
	// Once the guest hand-edits any structured part we stop re-deriving it from the
	// legal name, so re-blurring the legal name never clobbers a manual correction.
	const [nameEdited, setNameEdited] = useState(false);

	function setField<K extends keyof CollectFormValues>(key: K, value: string) {
		setValues((prev) => ({ ...prev, [key]: value }));
	}

	/** Edit a structured name part and latch "manually edited" so it is never re-derived. */
	function setNamePart(key: "first" | "middle" | "last", value: string) {
		setNameEdited(true);
		setField(key, value);
	}

	/**
	 * Commit the legal name on blur: reveal the structured breakdown and, unless the
	 * guest has already hand-edited a part, (re)derive first/middle/last from it. An
	 * empty legal name is left collapsed - there is nothing to split, and the field's
	 * own `required` guard reports the emptiness. When the template does not capture a
	 * structured name there is no breakdown to reveal, so this is a no-op.
	 */
	function handleLegalNameBlur() {
		if (!config.captureStructuredName) return;
		if (!values.legalName.trim()) return;
		setNameRevealed(true);
		if (nameEdited) return;
		const parts = splitLegalName(values.legalName);
		setValues((prev) => ({ ...prev, first: parts.first, middle: parts.middle, last: parts.last }));
	}

	// Build the SDK collector from its inputs. `fetchToken` may be a fresh closure
	// each render (CheckInPage rebuilds `fetchToken`), so it is a dep here; rebuilding the
	// collector is cheap and it is only read inside `handleSubmit`, so there is no
	// subscription to churn.
	const collector = useMemo(
		() => createCollector({ publishableKey, fetchToken, apiBase: sdkApiBase }),
		[publishableKey, fetchToken, sdkApiBase, createCollector],
	);

	// Keep the latest collector in a ref so the mount-only `describe()` probe reads the
	// current instance without re-probing when `fetchToken` (and thus the collector)
	// changes identity. The ref is synced in an effect (never written during render) and
	// is seeded with the mount collector by `useRef`, so the probe below reads the right
	// instance on the first pass.
	const collectorRef = useRef(collector);
	useEffect(() => {
		collectorRef.current = collector;
	}, [collector]);

	// Probe the template config exactly once on mount. On `{ ok:true }` narrow the form
	// to the collected fields; on `{ ok:false }` or a throw, keep the static fallback so
	// the form still works (no dead-end).
	useEffect(() => {
		let active = true;
		collectorRef.current.describe().then(
			(result) => {
				if (active) setConfig(resolveConfig(result));
			},
			() => {
				if (active) setConfig(FALLBACK_CONFIG);
			},
		);
		return () => {
			active = false;
		};
	}, []);

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setErrorHint(null);
		try {
			const result = await collector.submit(toSubmitInput(values, config));
			// `ok` satisfied the collect step; `not_collect_step` means there was no
			// collect step to satisfy on this session. Either way there is nothing left to
			// block on, so advance to the identity journey.
			if (result.ok || result.code === "not_collect_step") {
				onComplete();
				return;
			}
			// `validation_failed` gets group-aware copy so the guest knows which section to
			// fix; every other code maps to its static actionable hint.
			setErrorHint(
				result.code === "validation_failed"
					? validationFailedHint(config)
					: SUBMIT_ERROR_HINTS[result.code],
			);
		} catch {
			// The SDK submit resolves a typed result rather than throwing, but stay
			// defensive so an unexpected throw is still an actionable state, never a crash.
			setErrorHint(SUBMIT_ERROR_HINTS.network_error);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Confirm your details</CardTitle>
				<CardDescription>
					Review the details from your reservation and add a few more, then continue to your
					identity check.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={handleSubmit} className="grid gap-4">
					<div className="grid gap-1.5">
						<Label htmlFor="collect-legalName">Legal name</Label>
						<Input
							id="collect-legalName"
							autoComplete="name"
							required
							value={values.legalName}
							onChange={(event) => setField("legalName", event.target.value)}
							onBlur={handleLegalNameBlur}
							aria-describedby="collect-legalName-hint"
						/>
						<p id="collect-legalName-hint" className="text-xs text-muted-foreground">
							Enter your full name as printed on your government ID.
						</p>
					</div>

					{config.captureStructuredName && nameRevealed ? (
						<div role="group" aria-label="Name breakdown" className="grid gap-1.5">
							<p className="text-sm text-muted-foreground">
								We split your legal name into the parts below. Edit any part that is not
								right.
							</p>
							{/* items-start keeps the three inputs aligned on one row: every label is a
							    single line of equal height, so each input sits at the same top regardless
							    of the muted helper text below the middle field. */}
							<div className="grid items-start gap-4 sm:grid-cols-3">
								<div className="grid gap-1.5">
									<Label htmlFor="collect-first">First name</Label>
									<Input
										id="collect-first"
										autoComplete="given-name"
										required
										value={values.first}
										onChange={(event) => setNamePart("first", event.target.value)}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="collect-middle">Middle name</Label>
									<Input
										id="collect-middle"
										autoComplete="additional-name"
										value={values.middle}
										onChange={(event) => setNamePart("middle", event.target.value)}
										aria-describedby="collect-middle-hint"
									/>
									<p id="collect-middle-hint" className="text-xs text-muted-foreground">
										Optional
									</p>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="collect-last">Last name</Label>
									<Input
										id="collect-last"
										autoComplete="family-name"
										required
										value={values.last}
										onChange={(event) => setNamePart("last", event.target.value)}
									/>
								</div>
							</div>
						</div>
					) : null}

					{config.email !== "hidden" || config.phone !== "hidden" ? (
						<div className="grid gap-4 sm:grid-cols-2">
							{config.email !== "hidden" ? (
								<div className="grid gap-1.5">
									<Label htmlFor="collect-email">Email{optionalSuffix(config.email)}</Label>
									<Input
										id="collect-email"
										type="email"
										autoComplete="email"
										required={config.email === "expected"}
										value={values.email}
										onChange={(event) => setField("email", event.target.value)}
									/>
								</div>
							) : null}
							{config.phone !== "hidden" ? (
								<div className="grid gap-1.5">
									<Label htmlFor="collect-phone">Phone{optionalSuffix(config.phone)}</Label>
									<Input
										id="collect-phone"
										type="tel"
										autoComplete="tel"
										placeholder="+15551234567"
										required={config.phone === "expected"}
										value={values.phone}
										onChange={(event) => setField("phone", event.target.value)}
									/>
								</div>
							) : null}
						</div>
					) : null}

					{config.dob !== "hidden" ? (
						<div className="grid gap-1.5 sm:max-w-[16rem]">
							<Label htmlFor="collect-dateOfBirth">Date of birth{optionalSuffix(config.dob)}</Label>
							<Input
								id="collect-dateOfBirth"
								type="date"
								autoComplete="bday"
								required={config.dob === "expected"}
								value={values.dateOfBirth}
								onChange={(event) => setField("dateOfBirth", event.target.value)}
							/>
						</div>
					) : null}

					{config.address !== "hidden" ? (
						<fieldset className="grid gap-4 rounded-md border border-border p-4">
							<legend className="px-1 text-sm font-medium text-muted-foreground">Address</legend>
							<div className="grid gap-1.5">
								<Label htmlFor="collect-line1">Address line 1</Label>
								<Input
									id="collect-line1"
									autoComplete="address-line1"
									required
									value={values.line1}
									onChange={(event) => setField("line1", event.target.value)}
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="collect-line2">Address line 2 (optional)</Label>
								<Input
									id="collect-line2"
									autoComplete="address-line2"
									value={values.line2}
									onChange={(event) => setField("line2", event.target.value)}
								/>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="grid gap-1.5">
									<Label htmlFor="collect-city">City</Label>
									<Input
										id="collect-city"
										autoComplete="address-level2"
										required
										value={values.city}
										onChange={(event) => setField("city", event.target.value)}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="collect-region">State / region (optional)</Label>
									<Input
										id="collect-region"
										autoComplete="address-level1"
										value={values.region}
										onChange={(event) => setField("region", event.target.value)}
									/>
								</div>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="grid gap-1.5">
									<Label htmlFor="collect-postalCode">Postal code (optional)</Label>
									<Input
										id="collect-postalCode"
										autoComplete="postal-code"
										value={values.postalCode}
										onChange={(event) => setField("postalCode", event.target.value)}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="collect-country">Country (ISO code)</Label>
									<Input
										id="collect-country"
										autoComplete="country"
										required
										placeholder="US"
										value={values.country}
										onChange={(event) => setField("country", event.target.value)}
									/>
								</div>
							</div>
						</fieldset>
					) : null}

					{errorHint ? <ErrorBanner>{errorHint}</ErrorBanner> : null}

					<Button type="submit" disabled={submitting}>
						{submitting ? "Confirming..." : "Confirm and continue"}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
