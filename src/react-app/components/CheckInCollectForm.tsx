/**
 * What this teaches / copy this pattern:
 * The "bring your own form" applicant-info step wired INTO the guest
 * check-in journey. A developer who owns their OWN form and PII handling supplies the
 * applicant's details PROGRAMMATICALLY via `@checktiv/sdk-web/collect-user-info`,
 * instead of mounting an SDK-rendered form. This component renders a guest-facing
 * "confirm your details" card and calls `collector.submit(...)`; on success it advances
 * the host to the SDK-rendered identity journey (`<ChecktivJourney>` in `CheckInPage`).
 *
 * The field set, order and grouping mirror the hosted `collect_user_info` step the SDK
 * itself serves, so a developer reading this file sees the same form the platform would
 * have rendered for them.
 *
 * WHICH CONTACT fields to render is not guessed: on mount the component calls
 * `collector.describe()` once and drives them from the workflow template's own config.
 * `describe()` returns `{ ok, fields, nameComponents }` where `fields` is the set of
 * OPTIONAL contact fields (email / phone / dob / address) the template collects. Contact
 * fields the template does NOT ask for are hidden; fields it DOES ask for are shown and
 * marked expected for this template (the server stays the authority - the marks are UX
 * only). When `describe()` returns `{ ok:false }` or the probe throws, the form
 * GRACEFULLY FALLS BACK to a full static field set so it still works with no dead-end.
 *
 * ## The name: four boxes, never config-gated
 *
 * The four ICAO-style name boxes - SURNAME(S), FIRST NAME, MIDDLE NAME(S), SUFFIX - are
 * rendered unconditionally, and `describe().nameComponents` is deliberately NOT read to
 * decide any of it. The reason is not laziness: the components pair is the only name
 * shape a background check can screen and it is always an accepted shape on the wire, so
 * there is no config value for which hiding or un-asking them is correct. A property
 * frequently does not know a guest's name the way their ID prints it, so the guest is
 * the single source of truth and is always asked.
 *
 * SURNAME(S) is the only required box. The other three are optional, and that is
 * load-bearing rather than lax: a person with ONE name has a surname and no given names
 * at all, so requiring a first name would lock them out of check-in entirely.
 *
 * ONE box holds exactly ONE name component, however many words it contains. "Mary Ann"
 * typed into FIRST NAME rides as `givenNames: ["Mary Ann"]`, never `["Mary", "Ann"]`,
 * and "Garcia Lopez" in SURNAME(S) is one family name. A labeled box a human typed into
 * is not a delimiter: splitting on its whitespace would invent a boundary the guest
 * never stated. Separate boxes exist precisely so the GUEST states it.
 *
 * ## There is NO legal-name box, and no `legalName` key on the wire
 *
 * It asked the guest to type the same name a second time, and the only thing anyone
 * could do with the extra joined string was guess where the surname started. The submit
 * body therefore carries NO `legalName` key at all - not `null`, not `""`. The
 * distinction is the whole point: the server treats an absent `legalName` as an
 * OMISSION and leaves a name a property's system already seeded on the applicant
 * untouched, whereas a present blank is rejected outright. Omitting a key is not the
 * same as clearing it.
 *
 * The reservation's joined `guestName` is still READ (see {@link CheckInCollectPrefill})
 * and shown as read-only context so the guest can see whose check-in this is. It is
 * never submitted and never seeds a name box: a whitespace split is wrong for
 * "Garcia Lopez", for "van der Berg", for every family-name-first order and for every
 * mononym, and a confidently wrong prefill is worse than an empty one because the guest
 * tends to accept whatever is already in the box and then fails the document match.
 *
 * How it fits the journey:
 *   1. `CheckInPage` resolves the durable `client_token` + publishable key from the
 *      check-in link fragment and fetches a guest-safe prefill
 *      (`GET /api/checkin/:id` -> reservation name + email) for THIS reservation.
 *   2. This component probes `describe()`, renders the form for the resolved config; the
 *      guest fills their name parts and the remaining fields. On confirm it builds the
 *      camelCase applicant body (`familyName` / `givenNames` / `nameSuffix`) and calls
 *      `collectUserInfo({ session }).submit(...)`. The SDK resolves the collect step from
 *      the session and POSTs; the server validates authoritatively (country-aware
 *      completeness + PII encryption). A PRESENT-but-blank field is rejected by the wire
 *      schema, so every optional one is OMITTED when empty rather than sent as "".
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
 * build-time `VITE_CHECKTIV_DEV_CELL*` variables via `devCellSdkApiBase()` (see
 * `lib/dev-cell.ts`), passed down by `CheckInPage`, and is `undefined` (prod) by
 * default. This is how the harness points the SDK at a non-production API for
 * local testing of the submit path.
 */
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentProps,
	type FormEvent,
	type ReactNode,
} from "react";
import {
	collectUserInfo,
	type CollectUserInfoAddress,
	type CollectUserInfoCollector,
	type CollectUserInfoConfigResult,
	type CollectUserInfoSubmitErrorCode,
	type CollectUserInfoSubmitInput,
} from "@checktiv/sdk-web/collect-user-info";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select } from "./ui/select";
import { COUNTRY_OPTIONS, isSelectableCountry } from "../lib/countries";

/**
 * Shown when the server rejects a submit with `name_components_required`: the session
 * needs the name IN PARTS.
 *
 * This form always sends the parts (there is no joined-name box left to send instead),
 * so the code is not reachable from a submit this component builds. The copy is kept
 * actionable anyway rather than reduced to a placeholder: it is a SERVER code on a
 * closed taxonomy, and a hint that names the boxes to fill costs nothing and cannot
 * dead-end a guest if the server ever returns it. No m-dashes; US spelling.
 */
const NAME_COMPONENTS_REQUIRED_HINT =
	"This check needs your name in parts. Enter your surname and your first name exactly as your government ID separates them, then confirm again.";

/**
 * Actionable hint per closed submit-error code. `satisfies Record<code, string>` is the
 * compile-time exhaustiveness guard: a new SDK error code fails `tsc -b` here until it
 * is mapped, so a code can never fall through to a blank/dead-end message. `ok` and
 * `not_collect_step` advance the journey rather than showing a hint, so `not_collect_step`'s
 * text is never displayed - it is kept only to satisfy the exhaustive map. The
 * `validation_failed` entry here is a generic fallback: the displayed copy is computed by
 * `submitErrorHint()`, which names the field GROUP(s) the template collects (the server
 * 400 is opaque). No m-dashes; US spelling.
 */
const SUBMIT_ERROR_HINTS = {
	not_collect_step:
		"This step is already complete. Continue to the identity check.",
	validation_failed:
		"Some details could not be accepted. Check your surname and first name and a complete address (address line 1, city, and country), then confirm again.",
	name_components_required: NAME_COMPONENTS_REQUIRED_HINT,
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
 * Shown when the guest confirms with no usable surname. The wire schema rejects a
 * PRESENT blank and the SDK's submit input requires the components pair, so there is
 * nothing valid to send; naming the box to fix beats firing a 422.
 *
 * It names the one-name case out loud because that guest has nothing else to type and
 * would otherwise read "surname" as "the second of your two names".
 */
const SURNAME_REQUIRED_HINT =
	"Enter your surname as printed on your government ID, then confirm again. If you have just one name, enter it there.";

/**
 * Shown when the guest filled MIDDLE NAME(S) but left FIRST NAME blank.
 *
 * Not tidiness: `givenNames` is an ORDERED array and blank boxes drop out of it, so a
 * middle name with no first name would be promoted to the first slot and screened as the
 * guest's first name. Refusing is also just true of names, and it costs a person with
 * one name nothing because they fill neither box.
 */
const FIRST_NAME_REQUIRED_HINT =
	"Enter your first name, or clear the Middle name(s) box, then confirm again.";

/**
 * Per-field visibility for an optional CONTACT field:
 *   - `hidden`   the template does not collect it, so it is not rendered or submitted.
 *   - `optional` shown but not marked required (the static fallback labels every field
 *                "(optional)" so the guest can still supply anything).
 *   - `expected` the template asked for it, so it is shown, marked expected/required for
 *                this template, and submitted when present. The server stays authoritative.
 *
 * The four NAME boxes deliberately have no entry on this scale. They are never config
 * gated: see the component JSDoc, "The name: four boxes, never config-gated".
 */
type FieldVisibility = "hidden" | "optional" | "expected";

/** The contact-field shape resolved from `describe()` (or the static fallback). */
interface ResolvedCollectConfig {
	email: FieldVisibility;
	phone: FieldVisibility;
	dob: FieldVisibility;
	address: FieldVisibility;
}

/**
 * The static fallback used before `describe()` resolves and whenever it returns
 * `{ ok:false }` or throws: show every contact field as optional. This is the form's
 * pre-`describe()` behavior, kept so the component never dead-ends on a probe failure.
 */
const FALLBACK_CONFIG: ResolvedCollectConfig = {
	email: "optional",
	phone: "optional",
	dob: "optional",
	address: "optional",
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
 * collects, since the server 400 is opaque about which one was rejected. The name boxes
 * are always listed (they are always on the form); each template-collected group is
 * added so the guest knows exactly where to look. US spelling; no m-dashes.
 */
function validationFailedHint(config: ResolvedCollectConfig): string {
	const groups = ["your surname and first name"];
	if (config.dob === "expected") groups.push("your date of birth");
	if (config.address !== "hidden")
		groups.push(
			"a complete address (address line 1, city, and country, plus state or region and postal code where your country uses them)",
		);
	if (config.email === "expected") groups.push("your email");
	if (config.phone === "expected") groups.push("your phone number");
	return `Some details could not be accepted. Check ${formatGroupList(groups)}, then confirm again.`;
}

/**
 * The displayed hint for a failed submit. `validation_failed` gets computed copy instead
 * of the static map because only the component knows enough to make it actionable: the
 * server is opaque about WHICH field it rejected, so {@link validationFailedHint} lists
 * the groups this template actually collects.
 *
 * Every other code is a static entry from {@link SUBMIT_ERROR_HINTS}, whose
 * `satisfies Record<code, string>` keeps this exhaustive.
 */
function submitErrorHint(
	code: CollectUserInfoSubmitErrorCode,
	config: ResolvedCollectConfig,
): string {
	if (code === "validation_failed") return validationFailedHint(config);
	return SUBMIT_ERROR_HINTS[code];
}

/**
 * The prefill `CheckInPage` derives from the guest-safe reservation read
 * (`GET /api/checkin/:id`). It carries ONLY what the reservation actually holds.
 *
 * `referenceName` is the reservation's single joined guest name. It is DISPLAY ONLY:
 * shown as read-only context so the guest can confirm whose check-in this is, never
 * seeded into a name box and never submitted. That mirrors what the platform calls a
 * `reference_name` on the session-create wire: a non-authoritative display label, which
 * is exactly what an unsplittable joined string honestly is.
 *
 * `email` IS a real prefill: it seeds the email box verbatim, because an email address
 * has no internal boundary to guess at.
 */
export interface CheckInCollectPrefill {
	referenceName: string;
	email: string;
}

/**
 * The form's field values. Plain strings; empty optionals are dropped on submit.
 *
 * The three given-name boxes are separate strings and each becomes at most ONE element
 * of the `givenNames` array, in this order. The guest typed them into separate boxes, so
 * the boundary between them is one they stated; splitting any single box on whitespace
 * would be a boundary this form invented.
 */
interface CollectFormValues {
	familyName: string;
	firstName: string;
	middleNames: string;
	nameSuffix: string;
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
 * Resolve the geo suggestion into a value the country dropdown can actually show
 * as selected, or `""` for "no pre-selection".
 *
 * Three inputs collapse to the same empty answer, and that is the point: absent
 * (every local run), a documented non-country sentinel already filtered by the
 * Worker, and a code this dropdown does not list. A guest must never see a country
 * pre-selected that they cannot see the name of, and an unrecognized guess is worth
 * nothing next to the risk of one going unnoticed.
 */
function resolveSuggestedCountry(suggested: string | null): string {
	if (!suggested) return "";
	return isSelectableCountry(suggested) ? suggested : "";
}

/**
 * Seed the editable form from the prefill and the resolved country suggestion; the
 * guest fills the rest.
 *
 * Only `email` and `country` are seeded, and they are seeded for opposite reasons.
 * The email is a value the reservation actually HOLDS. The country is a GUESS, which
 * is why it is the one seeded field the form tells the guest about (see the note
 * under the dropdown) and why an unusable guess seeds `""` instead of a plausible
 * default like `US`.
 *
 * Every name box starts EMPTY on purpose: the reservation holds one joined string, so
 * any surname or given-name seed would be a guess too, but unlike a country it is one
 * the guest cannot check at a glance, and accepting a plausible-looking wrong name
 * fails the document-match step without them ever noticing why.
 */
function initialValues(prefill: CheckInCollectPrefill, country: string): CollectFormValues {
	return {
		familyName: "",
		firstName: "",
		middleNames: "",
		nameSuffix: "",
		email: prefill.email,
		phone: "",
		dateOfBirth: "",
		line1: "",
		line2: "",
		city: "",
		region: "",
		postalCode: "",
		country,
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
 * What {@link buildSubmitInput} produces: a ready body, or the actionable hint that
 * explains why there is nothing valid to send. A closed result rather than `null`, so a
 * new refusal cannot be added without giving the guest a reason for it.
 */
type BuildResult =
	| { ok: true; input: CollectUserInfoSubmitInput }
	| { ok: false; hint: string };

/**
 * Build the SDK submit input from the form, trimming and dropping empty optionals.
 *
 * Only the fields the resolved template config renders are submitted: `address` rides
 * only when the address block is shown, and each contact field only when it is not
 * hidden and non-empty.
 *
 * The name boxes have no such gate. They are always rendered, so whatever the guest
 * typed is always sent: there is no config state in which the form shows an input and
 * then silently drops its value.
 *
 * ## No `legalName` key, ever
 *
 * There is no joined-name box on this form and nothing here sets `legalName`, so the
 * body carries no such key at all. That absence is load-bearing: the server reads an
 * absent `legalName` as an OMISSION and leaves an already-captured applicant name
 * untouched, while a `""` is rejected outright by the wire schema. Sending an empty
 * string to mean "the guest did not type one" would clobber a name the property's own
 * system supplied.
 *
 * ## Two refusals, both actionable
 *
 *   - No surname: the wire schema rejects a present blank and the SDK's input type
 *     requires the components pair, so an all-blank name has nothing valid to send.
 *   - A middle name with no first name: `givenNames` compacts, so the middle name would
 *     be promoted into the first slot and screened as the guest's first name.
 *
 * `givenNames` is sent even when EMPTY. That empty array is the documented shape for a
 * person with one name, so it is a positive statement rather than a missing field, and
 * dropping it would make "asked, and there are none" look like "never asked".
 */
function buildSubmitInput(values: CollectFormValues, config: ResolvedCollectConfig): BuildResult {
	const familyName = values.familyName.trim();
	const firstName = values.firstName.trim();
	const middleNames = values.middleNames.trim();
	const nameSuffix = values.nameSuffix.trim();

	if (!familyName) return { ok: false, hint: SURNAME_REQUIRED_HINT };
	if (!firstName && middleNames) return { ok: false, hint: FIRST_NAME_REQUIRED_HINT };

	// Ordered, blank boxes dropped. At most two elements: this form offers two
	// given-name boxes, and each contributes exactly one component.
	const givenNames = [firstName, middleNames].filter((component) => component.length > 0);
	const input: CollectUserInfoSubmitInput = { familyName, givenNames };
	// The suffix rides its OWN key and is OMITTED when blank, never sent as "": the wire
	// schema rejects a present-but-blank component, and an omission leaves a suffix
	// captured elsewhere intact. It is never appended to the surname, which would make
	// the family name disagree with what the document prints.
	if (nameSuffix) input.nameSuffix = nameSuffix;

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
	return { ok: true, input };
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
 * Maximum characters per name box. This is not an approximation of the wire bound, it IS
 * the wire bound: one box holds exactly one name component, and the schema caps each
 * component at 255. Nothing a guest can type here parses in the browser and 422s on the
 * server.
 */
const NAME_COMPONENT_MAX_LEN = 255;

/**
 * The attributes every name box carries, spread into all four so they cannot drift.
 *
 * These are capture fidelity, not cosmetics. A name is not an English word, and a mobile
 * keyboard is tuned as if it were:
 *   - `dir="auto"` lays each box out for the script it actually holds, so a right-to-left
 *     surname can sit beside a Latin given name. Per input, never once on the form.
 *   - `lang=""` declares the content language explicitly unknown, so a name box does not
 *     inherit the page's `lang` and get read with English pronunciation rules.
 *   - `autoCorrect="off"` stops the keyboard rewriting an unfamiliar surname into the
 *     nearest dictionary word. It defaults ON for a text input inside a form.
 *   - `autoCapitalize="none"` stops the keyboard inventing a capital: "van der Berg" and
 *     "de Souza" legitimately begin lowercase and must reproduce verbatim.
 *   - `spellCheck={false}` removes the red underline and the second rewrite path.
 */
const NAME_INPUT_PROPS = {
	dir: "auto",
	lang: "",
	autoCorrect: "off",
	autoCapitalize: "none",
	spellCheck: false,
	maxLength: NAME_COMPONENT_MAX_LEN,
} satisfies ComponentProps<"input">;

/**
 * The collect step. `fetchToken` returns the durable `client_token` (the SDK exchanges +
 * refreshes working tokens internally). It may be a fresh closure on every render, so the
 * collector built from it is rebuilt whenever it changes identity - that is cheap and
 * deliberate, and the collector is NOT held stable. What the ref below stabilizes is the
 * one-shot `describe()` probe, which must run exactly once on mount and must not re-run
 * when the collector is rebuilt. `onComplete` mounts the identity journey.
 */
export function CheckInCollectForm({
	publishableKey,
	fetchToken,
	sdkApiBase,
	prefill,
	suggestedCountry = null,
	onComplete,
	createCollector = defaultCreateCollector,
}: {
	publishableKey: string;
	fetchToken: () => Promise<string>;
	sdkApiBase?: string;
	prefill: CheckInCollectPrefill;
	/**
	 * Alpha-2 country inferred from the guest's connection at the edge
	 * (`GET /api/geo`), or `null` when there is no usable signal - which is EVERY
	 * local run, since `vite dev` and `vite preview` have no Cloudflare edge in
	 * front of them.
	 *
	 * It is a SUGGESTION, and the form treats it as one: it pre-selects the value
	 * so the guest can see it and says out loud where it came from, rather than
	 * quietly seeding a country they never looked at. An unrecognized code is
	 * discarded rather than displayed (see {@link resolveSuggestedCountry}).
	 */
	suggestedCountry?: string | null;
	onComplete: () => void;
	createCollector?: CreateCollector;
}) {
	// Resolved ONCE, at mount. `CheckInPage` renders this form only after both the
	// prefill and the geo read have settled, so there is no later arrival to fold in,
	// and a value the guest has since changed must never be re-applied underneath them.
	const [appliedCountry] = useState(() => resolveSuggestedCountry(suggestedCountry));
	const [values, setValues] = useState<CollectFormValues>(() =>
		initialValues(prefill, appliedCountry),
	);
	const [submitting, setSubmitting] = useState(false);
	const [errorHint, setErrorHint] = useState<string | null>(null);

	// The contact-field shape resolved from `describe()`. Starts on the static fallback so
	// the form is fully usable before the probe resolves and if the probe fails; a
	// successful probe narrows it to the template's collected fields.
	const [config, setConfig] = useState<ResolvedCollectConfig>(FALLBACK_CONFIG);

	function setField<K extends keyof CollectFormValues>(key: K, value: string) {
		setValues((prev) => ({ ...prev, [key]: value }));
	}

	// There is deliberately no progressive disclosure of the name row. Hiding boxes the
	// guest must fill behind a blur they may never perform would be a trap, and with no
	// joined name to derive anything from there is nothing to stage.

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

	/**
	 * Whether to show the "we picked this from your connection" note.
	 *
	 * True only while a suggestion was actually applied AND it is still what is
	 * selected. Both terms matter: with no signal there is nothing to explain, and
	 * once the guest overrides the suggestion the note would be describing a value
	 * that is no longer in the box. Derived on every render from the live value, so
	 * it cannot go stale the way a `useState` flag would.
	 */
	const showCountryNote = appliedCountry !== "" && values.country === appliedCountry;

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		// A body the wire would reject has nothing to gain from a round trip, so point at
		// the box to fix instead (see `buildSubmitInput` for the two refusals).
		const built = buildSubmitInput(values, config);
		if (!built.ok) {
			setErrorHint(built.hint);
			return;
		}
		setSubmitting(true);
		setErrorHint(null);
		try {
			const result = await collector.submit(built.input);
			// `ok` satisfied the collect step; `not_collect_step` means there was no
			// collect step to satisfy on this session. Either way there is nothing left to
			// block on, so advance to the identity journey.
			if (result.ok || result.code === "not_collect_step") {
				onComplete();
				return;
			}
			setErrorHint(submitErrorHint(result.code, config));
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
					Add the details below, then continue to your identity check.
				</CardDescription>
				{/*
				 * The reservation's joined guest name, read-only. It tells the guest whose
				 * check-in this is and gives them the string to transcribe into the boxes
				 * below in the parts THEY choose. It is never submitted and never seeds a
				 * box: see the component JSDoc.
				 */}
				{prefill.referenceName ? (
					<p className="text-sm text-muted-foreground">
						Reservation for {prefill.referenceName}
					</p>
				) : null}
			</CardHeader>
			<CardContent>
				{/*
				 * `gap-3` (0.75rem) is the form's vertical rhythm, and every side-by-side row
				 * below reuses the same `gap-3` for its gutter so the two agree.
				 */}
				<form onSubmit={handleSubmit} className="grid gap-3">
					{/*
					 * The four name boxes. Always rendered, never config-gated: see the
					 * component JSDoc.
					 */}
					<div role="group" aria-label="Your name" className="grid gap-3">
						<p className="text-sm text-muted-foreground">
							Enter each part of your name exactly as your government ID separates them.
							Only your surname is required.
						</p>
						<div className="grid gap-1.5">
							<Label htmlFor="collect-familyName">Surname(s)</Label>
							<Input
								id="collect-familyName"
								autoComplete="family-name"
								required
								placeholder="Garcia Lopez"
								value={values.familyName}
								onChange={(event) => setField("familyName", event.target.value)}
								aria-describedby="collect-familyName-hint"
								{...NAME_INPUT_PROPS}
							/>
							<p id="collect-familyName-hint" className="text-xs text-muted-foreground">
								Your family name as shown on your ID, including any particle such as "van"
								or "de". If you have just one name, enter it here and leave the rest blank.
							</p>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="collect-firstName">First name</Label>
							<Input
								id="collect-firstName"
								autoComplete="given-name"
								placeholder="Mary Ann"
								value={values.firstName}
								onChange={(event) => setField("firstName", event.target.value)}
								aria-describedby="collect-firstName-hint"
								{...NAME_INPUT_PROPS}
							/>
							<p id="collect-firstName-hint" className="text-xs text-muted-foreground">
								Your first name as shown on your ID. If it is more than one word, like Mary
								Ann, type all of it here.
							</p>
						</div>
						{/*
						 * MIDDLE NAME(S) and SUFFIX share a row from 40rem up and stack below it.
						 *
						 * NEITHER box carries helper text, and that is what makes the row align.
						 * `items-end` aligns each cell's BOTTOM edge, which is the input's bottom
						 * edge only while nothing renders below the input. Give ONE of them a hint
						 * and the hints align instead, pushing the inputs out of line again: the
						 * exact defect this replaced, where a long hint under one column and a
						 * short one under another left three inputs at three different heights.
						 * The rule for this form is simple and worth keeping: a box that shares a
						 * row with another carries no text below it. Guidance for these two lives
						 * in the group line above and in their placeholders.
						 *
						 * `items-end` still earns its place: it also absorbs a LABEL that wraps to
						 * two lines in one column and not the other, which is how the same row
						 * broke at narrow widths.
						 */}
						<div className="grid items-end gap-3 sm:grid-cols-2">
							<div className="grid gap-1.5">
								<Label htmlFor="collect-middleNames">Middle name(s)</Label>
								<Input
									id="collect-middleNames"
									autoComplete="additional-name"
									placeholder="Fitzgerald"
									value={values.middleNames}
									onChange={(event) => setField("middleNames", event.target.value)}
									{...NAME_INPUT_PROPS}
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="collect-nameSuffix">Suffix</Label>
								<Input
									id="collect-nameSuffix"
									autoComplete="honorific-suffix"
									placeholder="Jr."
									value={values.nameSuffix}
									onChange={(event) => setField("nameSuffix", event.target.value)}
									{...NAME_INPUT_PROPS}
								/>
							</div>
						</div>
					</div>

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
								inputMode="tel"
								// A placeholder here and none on Email is deliberate: an email address
								// has one universally understood shape, a phone number does not, and
								// the example is what tells the guest to include a country code.
								placeholder="+1 555 123 4567"
								required={config.phone === "expected"}
								value={values.phone}
								onChange={(event) => setField("phone", event.target.value)}
							/>
						</div>
					) : null}

					{config.dob !== "hidden" ? (
						<div className="grid gap-1.5">
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
						/*
						 * A `fieldset` + `legend` for the grouping semantics (a screen reader
						 * announces the group name with each control), but with no border or
						 * padding: a boxed block here was the only framed group on the form and
						 * read as a separate widget rather than as more of the same form.
						 */
						<fieldset className="grid gap-3">
							{/* A `legend` is not a grid item, so the form's `gap-3` does not separate it
						    from the first field. `mb-2` supplies that gap explicitly. */}
						<legend className="mb-2 text-sm font-medium text-muted-foreground">Address</legend>
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
							{/* Same rule as the name row: neither box carries helper text, so
							    `items-end` aligns the inputs and not something under them. */}
							<div className="grid items-end gap-3 sm:grid-cols-2">
								<div className="grid gap-1.5">
									<Label htmlFor="collect-region">State / region (optional)</Label>
									<Input
										id="collect-region"
										autoComplete="address-level1"
										value={values.region}
										onChange={(event) => setField("region", event.target.value)}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="collect-postalCode">Postal code (optional)</Label>
									<Input
										id="collect-postalCode"
										autoComplete="postal-code"
										value={values.postalCode}
										onChange={(event) => setField("postalCode", event.target.value)}
									/>
								</div>
							</div>
							{/*
							 * Country sits alone on a full-width row, so it is free to carry the
							 * note below without breaking anything. That is the rule this form
							 * keeps: a box that SHARES a row carries no text under it, because
							 * `items-end` aligns the bottom of each cell and a note under one
							 * column would align the notes instead of the inputs. State / region
							 * and Postal code share the row above and carry nothing.
							 */}
							<div className="grid gap-1.5">
								<Label htmlFor="collect-country">Country</Label>
								<Select
									id="collect-country"
									name="country"
									autoComplete="country"
									required
									value={values.country}
									onChange={(event) => setField("country", event.target.value)}
									aria-describedby={showCountryNote ? "collect-country-note" : undefined}
								>
									{/*
									 * An explicit empty first option, NOT a silent default. With no
									 * usable geo signal this is what stays selected, and the browser's
									 * own `required` gate then refuses the submit and points at this
									 * control. Defaulting to a plausible country instead would submit
									 * one the guest never chose and never noticed, which is the
									 * failure this whole field is arranged to avoid.
									 */}
									<option value="">Select a country</option>
									{COUNTRY_OPTIONS.map((option) => (
										<option key={option.code} value={option.code}>
											{option.label}
										</option>
									))}
								</Select>
								{/*
								 * Shown only while the pre-selected value is still the suggested one.
								 * The moment the guest picks something else the note stops being true,
								 * so it disappears; pick the suggestion again and it returns. Derived
								 * from the current value rather than tracked in state, so it cannot
								 * describe a selection that is no longer there.
								 */}
								{showCountryNote ? (
									<p id="collect-country-note" className="text-xs text-muted-foreground">
										We picked this from your connection. Change it if it is not where
										you live.
									</p>
								) : null}
							</div>
						</fieldset>
					) : null}

					{errorHint ? <ErrorBanner>{errorHint}</ErrorBanner> : null}

					{/*
					 * The button swaps its own text while in flight, which a screen reader does
					 * not reliably announce on its own. An empty polite region stays silent until
					 * there is something to say.
					 */}
					<div role="status" aria-live="polite" className="sr-only">
						{submitting ? "Confirming your details" : ""}
					</div>

					<Button type="submit" disabled={submitting}>
						{submitting ? "Confirming..." : "Confirm and continue"}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
