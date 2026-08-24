// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * The check-in collect step driven through its injectable `createCollector`.
 * The SDK data-plane is NOT hit: the collector's `submit` and `describe` are spies. This
 * proves the component's own wiring - describe() -> contact-field config -> edit ->
 * submit -> typed-result handling -> advance - without a network or the real SDK. The
 * `@checktiv/sdk-web/collect-user-info` module is mocked only so importing the component
 * does not load the real SDK.
 *
 * Two load-bearing groups here:
 *
 *   - **The name boxes are never config gated.** `describe()` reports
 *     `nameComponents: required | requested | optional`, and NO value may hide the boxes
 *     or relax the surname: they are always an accepted wire shape and the only name a
 *     background check can screen. These tests assert they render and behave identically
 *     on every state.
 *   - **There is no `legalName` key on the wire.** Not `null`, not `""` - ABSENT. An
 *     omitted key leaves a name the property's own system seeded on the applicant
 *     intact, where a blank would be rejected outright. The key-absence assertions below
 *     are what stop a "harmless" `legalName: ""` creeping back in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
	CollectUserInfoConfigResult,
	CollectUserInfoSubmitInput,
	CollectUserInfoSubmitResult,
} from "@checktiv/sdk-web/collect-user-info";
import {
	CheckInCollectForm,
	type CheckInCollectPrefill,
	type CreateCollector,
} from "../../src/react-app/components/CheckInCollectForm";

// Keep the real SDK out of the node test runtime; the component injects its collector.
vi.mock("@checktiv/sdk-web/collect-user-info", () => ({
	collectUserInfo: () => ({
		submit: async () => ({ ok: true }),
		describe: async () => ({ ok: false, code: "not_collect_step" }),
	}),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const PREFILL: CheckInCollectPrefill = {
	referenceName: "Ada Lovelace",
	email: "ada@example.com",
};

type SubmitSpy = ReturnType<
	typeof vi.fn<(input: CollectUserInfoSubmitInput) => Promise<CollectUserInfoSubmitResult>>
>;

/** Default `describe()` for suites that do not exercise config narrowing: fall back. */
const fallbackDescribe = async (): Promise<CollectUserInfoConfigResult> => ({
	ok: false,
	code: "not_collect_step",
});

/**
 * Build an `{ ok:true }` describe result.
 *
 * `nameComponents` and the retired `captureStructuredName` boolean are both still on the
 * SDK's config type, and both are supplied here purely to satisfy it. The component
 * reads NEITHER: the name boxes are unconditional. Pinning `captureStructuredName` to
 * `false` doubles as proof of that - a component that read it would hide the very fields
 * a background check requires.
 */
function describeConfig(opts: {
	fields: Array<"email" | "phone" | "dob" | "address">;
	nameComponents: "required" | "requested" | "optional";
}): CollectUserInfoConfigResult {
	return {
		ok: true,
		fields: opts.fields,
		nameComponents: opts.nameComponents,
		captureStructuredName: false,
	};
}

function renderForm(opts: {
	submit: SubmitSpy;
	describe?: () => Promise<CollectUserInfoConfigResult>;
	onComplete?: () => void;
	prefill?: CheckInCollectPrefill;
	/** The edge's country guess; omitted means no signal, the local-dev default. */
	suggestedCountry?: string | null;
}) {
	const onComplete = opts.onComplete ?? vi.fn();
	const describeFn = opts.describe ?? fallbackDescribe;
	const createCollector: CreateCollector = () => ({ submit: opts.submit, describe: describeFn });
	render(
		<CheckInCollectForm
			publishableKey="ah_pk_us_test_x"
			fetchToken={async () => "ct_durable"}
			sdkApiBase={undefined}
			prefill={opts.prefill ?? PREFILL}
			suggestedCountry={opts.suggestedCountry ?? null}
			onComplete={onComplete}
			createCollector={createCollector}
		/>,
	);
	return { onComplete };
}

/** The country dropdown, typed as a `<select>` so `.value` / `.options` are readable. */
function countrySelect(): HTMLSelectElement {
	const el = screen.getByLabelText("Country");
	if (!(el instanceof HTMLSelectElement)) throw new Error("Country is not a <select>");
	return el;
}

/** The copy shown under the dropdown when a geo suggestion is what is selected. */
const COUNTRY_NOTE = /we picked this from your connection/i;

/** Fill the remaining required fields the prefill does not cover (the address block). */
function fillRequiredAddress() {
	fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: "1 Analytical Way" } });
	fireEvent.change(screen.getByLabelText("City"), { target: { value: "London" } });
	// Country is a dropdown: the value must be one of its option values (alpha-2).
	fireEvent.change(screen.getByLabelText("Country"), { target: { value: "GB" } });
}

const EMPTY_PREFILL: CheckInCollectPrefill = { referenceName: "", email: "" };

/**
 * Fill the name boxes the way a guest would (nothing is prefilled there). Only the
 * surname is required; the rest are supplied per test.
 */
function fillName(opts: {
	family: string;
	first?: string;
	middle?: string;
	suffix?: string;
}) {
	fireEvent.change(screen.getByLabelText("Surname(s)"), { target: { value: opts.family } });
	if (opts.first !== undefined) {
		fireEvent.change(screen.getByLabelText("First name"), { target: { value: opts.first } });
	}
	if (opts.middle !== undefined) {
		fireEvent.change(screen.getByLabelText("Middle name(s)"), { target: { value: opts.middle } });
	}
	if (opts.suffix !== undefined) {
		fireEvent.change(screen.getByLabelText("Suffix"), { target: { value: opts.suffix } });
	}
}

describe("CheckInCollectForm", () => {
	it("prefills ONLY the email, shows the reservation name as read-only context, and leaves every name box empty", () => {
		// The load-bearing CT-404 assertion for this component. The reservation holds one
		// joined `guestName` with no stated boundary, so it is DISPLAYED and never seeded
		// into a box: a confidently wrong split is worse than a blank, because the guest
		// tends to accept whatever is already in the box and then fails the document match.
		// There is no legal-name input to accept it into any more either.
		renderForm({ submit: vi.fn() });
		expect(screen.getByLabelText("Email (optional)")).toHaveValue("ada@example.com");
		expect(screen.getByText("Reservation for Ada Lovelace")).toBeInTheDocument();
		expect(screen.queryByLabelText("Legal name")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Surname(s)")).toHaveValue("");
		expect(screen.getByLabelText("First name")).toHaveValue("");
		expect(screen.getByLabelText("Middle name(s)")).toHaveValue("");
		expect(screen.getByLabelText("Suffix")).toHaveValue("");
	});

	it("renders every name box immediately, with no reveal to perform", () => {
		// Hiding boxes the guest must fill behind a blur they may never perform would be a
		// trap, and with no joined name to derive anything from there is nothing to stage.
		renderForm({ submit: vi.fn(), prefill: EMPTY_PREFILL });
		expect(screen.getByLabelText("Surname(s)")).toBeInTheDocument();
		expect(screen.getByLabelText("First name")).toBeInTheDocument();
		expect(screen.getByLabelText("Middle name(s)")).toBeInTheDocument();
		expect(screen.getByLabelText("Suffix")).toBeInTheDocument();
		// Only the surname is required: a person with ONE name fills nothing else, and
		// requiring a first name would lock them out of check-in at the browser gate.
		expect(screen.getByLabelText("Surname(s)")).toBeRequired();
		expect(screen.getByLabelText("First name")).not.toBeRequired();
		expect(screen.getByLabelText("Middle name(s)")).not.toBeRequired();
		expect(screen.getByLabelText("Suffix")).not.toBeRequired();
	});

	it("sends NO legalName key at all, never an empty string", async () => {
		// The distinction this whole change exists to hold. An absent `legalName` is an
		// OMISSION the server honors by leaving an already-captured name intact; a `""` is
		// rejected outright and would clobber a name the property's own system supplied.
		// `toEqual` alone would not catch a present-but-undefined key, so assert absence.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const sent = submit.mock.calls[0][0];
		expect(sent).not.toHaveProperty("legalName");
		expect(Object.keys(sent)).not.toContain("legalName");
	});

	it("keeps a guest-typed multi-token family name intact through submit", () => {
		// The whole point of asking: a family name the guest declares as "Garcia Lopez"
		// must reach the wire as ONE family name, never as two tokens or a trailing
		// surname. A multi-word first name likewise rides as ONE given-name component.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit, prefill: EMPTY_PREFILL });
		fillName({ family: "Garcia Lopez", first: "Mary Ann" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		expect(submit.mock.calls[0][0]).toMatchObject({
			familyName: "Garcia Lopez",
			givenNames: ["Mary Ann"],
		});
	});

	it("keeps first name and middle name(s) as SEPARATE ordered given-name components", async () => {
		// Two boxes, two components, in document order. The boundary between them is one
		// the GUEST stated by choosing boxes; nothing here splits either box's own text.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit, prefill: EMPTY_PREFILL });

		fillName({ family: "Kennedy", first: "John", middle: "Fitzgerald" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0][0]).toMatchObject({
			familyName: "Kennedy",
			givenNames: ["John", "Fitzgerald"],
		});
	});

	it("submits TOP-LEVEL name fields (no nested `name`) and advances on ok", async () => {
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const { onComplete } = renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada", suffix: "Jr." });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0][0]).toEqual({
			familyName: "Lovelace",
			givenNames: ["Ada"],
			nameSuffix: "Jr.",
			address: { line1: "1 Analytical Way", city: "London", country: "GB" },
			email: "ada@example.com",
		});
		// The nested `name` object was DELETED from the SDK, not renamed.
		expect(submit.mock.calls[0][0]).not.toHaveProperty("name");
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
	});

	it("OMITS blank optional name fields rather than sending empty strings", async () => {
		// The wire schema rejects a PRESENT blank (`nameSuffix: ""` is a 422), so an
		// untouched box must be absent from the body, not present and empty. `givenNames`
		// is the one deliberate exception and has its own test below.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const sent = submit.mock.calls[0][0];
		expect(sent).not.toHaveProperty("nameSuffix");
		expect(sent).not.toHaveProperty("legalName");
	});

	it("blocks the submit with an actionable hint when the surname is blank", async () => {
		// Whitespace-only clears HTML `required` but is blank on the wire. Rather than
		// spending a round trip on a guaranteed 422, name the box to fix - and name the
		// one-name case, because that guest has nothing else to type.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const { onComplete } = renderForm({ submit, prefill: EMPTY_PREFILL });

		fillName({ family: "   " });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/surname as printed on your government ID/i);
		expect(alert).toHaveTextContent(/just one name/i);
		expect(submit).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("refuses a middle name with no first name instead of promoting it to the first slot", async () => {
		// `givenNames` is ORDERED and blank boxes drop out, so a middle name with no first
		// name would land in slot 0 and be screened as the guest's first name. Refuse and
		// say which box to fix; a person with one name fills neither box and is unaffected.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit, prefill: EMPTY_PREFILL });

		fillName({ family: "Kennedy", middle: "Fitzgerald" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/Enter your first name, or clear the Middle name\(s\) box/i);
		expect(submit).not.toHaveBeenCalled();
	});

	it("advances when the session has no collect step (not_collect_step)", async () => {
		const submit: SubmitSpy = vi
			.fn()
			.mockResolvedValue({ ok: false, code: "not_collect_step", message: "no step" });
		const { onComplete } = renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		// No error affordance is shown when the step simply does not exist.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows an actionable hint and does NOT advance on a typed error (no dead-end)", async () => {
		const submit: SubmitSpy = vi
			.fn()
			.mockResolvedValue({ ok: false, code: "origin_not_allowed", message: "bad origin" });
		const { onComplete } = renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/not allowlisted for this Checktiv org/i);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("names the boxes to fill on a name_components_required rejection", async () => {
		// This form always sends the components, so the server code is not reachable from a
		// body it builds. It stays on the closed taxonomy with actionable copy anyway: an
		// unmapped code would render a dead-end, which is the failure mode being guarded.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({
			ok: false,
			code: "name_components_required",
			message: "opaque server text",
		});
		const { onComplete } = renderForm({ submit });

		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/needs your name in parts/i);
		expect(alert).toHaveTextContent(/surname/i);
		expect(alert).toHaveTextContent(/first name/i);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("builds the collector with the publishable key and durable-token source", async () => {
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const createCollector = vi.fn<CreateCollector>(() => ({ submit, describe: fallbackDescribe }));
		render(
			<CheckInCollectForm
				publishableKey="ah_pk_us_test_x"
				fetchToken={async () => "ct_durable"}
				sdkApiBase={undefined}
				prefill={PREFILL}
				onComplete={vi.fn()}
				createCollector={createCollector}
			/>,
		);
		const args = createCollector.mock.calls[0][0];
		expect(args.publishableKey).toBe("ah_pk_us_test_x");
		expect(args.apiBase).toBeUndefined();
		await expect(args.fetchToken()).resolves.toBe("ct_durable");
	});

	it("renders only the template-collected contact fields from describe() and marks them expected", async () => {
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const describeFn = async (): Promise<CollectUserInfoConfigResult> =>
			describeConfig({ fields: ["dob", "address"], nameComponents: "required" });
		const { onComplete } = renderForm({ submit, describe: describeFn });

		// describe() narrows the CONTACT fields: email + phone are dropped, dob + address
		// remain. It narrows nothing about the name boxes.
		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Surname(s)")).toBeRequired();
		expect(screen.getByLabelText("First name")).not.toBeRequired();
		// Template-collected fields are shown and marked expected (required, no "(optional)").
		expect(screen.getByLabelText("Date of birth")).toBeRequired();
		expect(screen.getByLabelText("Address line 1")).toBeRequired();

		// Submitting sends only the collected fields; the prefilled email is NOT sent.
		fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-01-02" } });
		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const sent = submit.mock.calls[0][0];
		expect(sent).toEqual({
			familyName: "Lovelace",
			givenNames: ["Ada"],
			dateOfBirth: "1990-01-02",
			address: { line1: "1 Analytical Way", city: "London", country: "GB" },
		});
		expect(sent.email).toBeUndefined();
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
	});

	it("falls back to the full static field set when describe() reports no collect config", async () => {
		const describeFn = async (): Promise<CollectUserInfoConfigResult> => ({
			ok: false,
			code: "not_collect_step",
		});
		renderForm({ submit: vi.fn(), describe: describeFn });

		// Fallback keeps every contact field, each labeled optional and not required.
		expect(await screen.findByLabelText("Email (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Phone (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Date of birth (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Address line 1")).toBeInTheDocument();
		expect(screen.getByLabelText("Email (optional)")).not.toBeRequired();
		// The name boxes are unaffected by a failed probe: still shown, still surname-only.
		expect(screen.getByLabelText("Surname(s)")).toBeRequired();
	});

	it("names the collected field groups in the validation_failed hint", async () => {
		const submit: SubmitSpy = vi
			.fn()
			.mockResolvedValue({ ok: false, code: "validation_failed", message: "opaque 400" });
		const describeFn = async (): Promise<CollectUserInfoConfigResult> =>
			describeConfig({ fields: ["dob", "address"], nameComponents: "required" });
		renderForm({ submit, describe: describeFn });

		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-01-02" } });
		fillName({ family: "Lovelace", first: "Ada" });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		// The name boxes are always on the form, so the hint always names them.
		expect(alert).toHaveTextContent(/your surname and first name/i);
		expect(alert).toHaveTextContent(/your date of birth/i);
		expect(alert).toHaveTextContent(/complete address/i);
		// The address hint names state/region + postal code (country-aware) so a US
		// applicant who left them blank knows where to look (they are required by the
		// server's country-aware completeness even though the form marks them optional).
		expect(alert).toHaveTextContent(/state or region/i);
		expect(alert).toHaveTextContent(/postal code/i);
	});

	it.each(["required", "requested", "optional"] as const)(
		"renders the name boxes identically on nameComponents=%s (never config gated)",
		async (nameComponents) => {
			// THE regression this guards. A form that reads a config value to decide whether
			// to show or require the name boxes can ship a verification that cannot run: the
			// components are the ONLY name shape a background check can screen, and they are
			// always accepted on the wire. Every state renders the same four boxes with the
			// same surname-only requirement.
			renderForm({
				submit: vi.fn(),
				describe: async () => describeConfig({ fields: ["email"], nameComponents }),
			});

			// Wait for the probe to land (phone is dropped by this template's field set).
			await waitFor(() => expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument());
			expect(screen.getByLabelText("Surname(s)")).toBeRequired();
			expect(screen.getByLabelText("First name")).not.toBeRequired();
			expect(screen.getByLabelText("Middle name(s)")).toBeInTheDocument();
			expect(screen.getByLabelText("Suffix")).toBeInTheDocument();
			// The retired boolean on the fixture is `false`; reading it would have hidden
			// every one of them, which is the defect being guarded.
		},
	);

	it("still submits guest-typed components on a nameComponents=optional session", async () => {
		// A box the form RENDERS must never have its value silently dropped, whatever the
		// config says.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({
			submit,
			describe: async () => describeConfig({ fields: [], nameComponents: "optional" }),
		});

		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		fillName({ family: "Lovelace", first: "Ada" });
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0][0]).toEqual({
			familyName: "Lovelace",
			givenNames: ["Ada"],
		});
	});

	it("renders Country as a dropdown of ISO countries, frequent markets first", () => {
		// A free-text "Country (ISO code)" box asked a guest to know that their country
		// is spelled "GB". The dropdown is the fix, and the ORDER is part of it: the
		// frequent markets sit at the top so the common case is one scroll, not 248.
		renderForm({ submit: vi.fn() });
		const select = countrySelect();
		// First option is the explicit empty placeholder, then the frequent block.
		expect(select.options[0].value).toBe("");
		expect(select.options[0].textContent).toBe("Select a country");
		expect(select.options[1].value).toBe("US");
		expect(select.options[2].value).toBe("CA");
		expect(select.options[3].value).toBe("GB");
		// The long tail is present, so an applicant outside those markets is not
		// dead-ended into picking a country that is not theirs.
		const codes = Array.from(select.options).map((o) => o.value);
		expect(codes).toContain("IN");
		expect(codes).toContain("BR");
		expect(codes).toContain("JP");
		expect(codes).toContain("ZW");
		// 248 countries + the placeholder.
		expect(select.options.length).toBe(249);
	});

	it("labels the options with country NAMES, not bare codes", () => {
		// The labels come from `Intl.DisplayNames`, so this also pins that the runtime
		// running these tests actually has the ICU data (a bare-code fallback here would
		// mean the generated-label approach silently degraded).
		renderForm({ submit: vi.fn() });
		const byCode = new Map(
			Array.from(countrySelect().options).map((o) => [o.value, o.textContent]),
		);
		expect(byCode.get("US")).toBe("United States");
		expect(byCode.get("GB")).toBe("United Kingdom");
		expect(byCode.get("JP")).toBe("Japan");
	});

	it("PRE-SELECTS the suggested country and says where it came from", async () => {
		// The non-negotiable pair: the guess must be VISIBLY selected (not implied), and
		// the guest must be told it was a guess so they think to check it.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({ submit, suggestedCountry: "DE" });

		expect(countrySelect().value).toBe("DE");
		expect(screen.getByText(COUNTRY_NOTE)).toBeInTheDocument();
		// And it is what gets submitted, as uppercase alpha-2 - the wire shape is
		// unchanged by the field becoming a dropdown.
		fillName({ family: "Lovelace", first: "Ada" });
		fireEvent.change(screen.getByLabelText("Address line 1"), {
			target: { value: "1 Analytical Way" },
		});
		fireEvent.change(screen.getByLabelText("City"), { target: { value: "Berlin" } });
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0][0].address).toEqual({
			line1: "1 Analytical Way",
			city: "Berlin",
			country: "DE",
		});
	});

	it("drops the note once the guest overrides the suggestion, and brings it back if they undo", () => {
		// The note describes the CURRENT selection. Leaving it up after an override would
		// tell the guest their own choice came from their connection, which is false.
		renderForm({ submit: vi.fn(), suggestedCountry: "DE" });
		expect(screen.getByText(COUNTRY_NOTE)).toBeInTheDocument();

		fireEvent.change(countrySelect(), { target: { value: "FR" } });
		expect(countrySelect().value).toBe("FR");
		expect(screen.queryByText(COUNTRY_NOTE)).not.toBeInTheDocument();

		fireEvent.change(countrySelect(), { target: { value: "DE" } });
		expect(screen.getByText(COUNTRY_NOTE)).toBeInTheDocument();
	});

	it("selects NOTHING when there is no geo signal, rather than defaulting to a country", () => {
		// The local-dev and no-Cloudflare-edge case, and the deliberate design call: a
		// wrong pre-selection the guest does not notice is worse than no pre-selection.
		// The empty placeholder is what stays selected, and the browser's own `required`
		// gate then refuses the submit and points at this control.
		renderForm({ submit: vi.fn(), suggestedCountry: null });
		expect(countrySelect().value).toBe("");
		expect(countrySelect()).toBeRequired();
		expect(screen.queryByText(COUNTRY_NOTE)).not.toBeInTheDocument();
	});

	it("discards a suggestion the dropdown cannot show, instead of displaying a bare code", async () => {
		// The Worker already filters the documented `XX` / `T1` sentinels, so this is the
		// residual case: a well-formed code this list does not carry. Unlike a value a
		// PERSON committed to, a machine guess is worth nothing next to the risk of a
		// guest submitting a country they never read, so it is dropped rather than
		// rendered as an extra option.
		renderForm({ submit: vi.fn(), suggestedCountry: "ZZ" });
		expect(countrySelect().value).toBe("");
		expect(screen.queryByText(COUNTRY_NOTE)).not.toBeInTheDocument();
		expect(
			Array.from(countrySelect().options).some((o) => o.value === "ZZ"),
		).toBe(false);
	});

	it("submits a mononym as familyName with an EMPTY givenNames array", async () => {
		// A person with one name puts the whole name in `familyName` and sends
		// `givenNames: []`. The empty array must be PRESENT (it is the union arm the SDK
		// requires and the documented "asked, and there are none" answer), not omitted, and
		// nothing may tokenize the single value. This ALSO pins the required-mark
		// asymmetry: if "First name" carried `required` the browser would block this
		// submit before the server ever saw it.
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		renderForm({
			submit,
			prefill: EMPTY_PREFILL,
			describe: async () => describeConfig({ fields: [], nameComponents: "required" }),
		});

		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		fillName({ family: "Testmononym" });
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const sent = submit.mock.calls[0][0];
		expect(sent).toEqual({ familyName: "Testmononym", givenNames: [] });
		expect(sent).toHaveProperty("givenNames");
		expect(sent).not.toHaveProperty("legalName");
	});
});
