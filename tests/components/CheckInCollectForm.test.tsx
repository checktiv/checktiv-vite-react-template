// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * The check-in collect step (CT-377 mode b) driven through its injectable `createCollector`.
 * The SDK data-plane is NOT hit: the collector's `submit` and `describe` are spies. This
 * proves the component's own wiring - describe() -> field config -> prefill -> edit ->
 * submit -> typed-result handling -> advance - without a network or the real SDK. The
 * `@checktiv/sdk-web/collect-user-info` module is mocked only so importing the component
 * does not load the real SDK.
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
	legalName: "Ada Lovelace",
	first: "Ada",
	last: "Lovelace",
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

function renderForm(opts: {
	submit: SubmitSpy;
	describe?: () => Promise<CollectUserInfoConfigResult>;
	onComplete?: () => void;
	prefill?: CheckInCollectPrefill;
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
			onComplete={onComplete}
			createCollector={createCollector}
		/>,
	);
	return { onComplete };
}

/** Fill the remaining required fields the prefill does not cover (the address block). */
function fillRequiredAddress() {
	fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: "1 Analytical Way" } });
	fireEvent.change(screen.getByLabelText("City"), { target: { value: "London" } });
	fireEvent.change(screen.getByLabelText("Country (ISO code)"), { target: { value: "GB" } });
}

const EMPTY_PREFILL: CheckInCollectPrefill = { legalName: "", first: "", last: "", email: "" };

describe("CheckInCollectForm", () => {
	it("reveals the structured name breakdown on mount for a prefilled legal name", () => {
		renderForm({ submit: vi.fn() });
		expect(screen.getByLabelText("Legal name")).toHaveValue("Ada Lovelace");
		expect(screen.getByLabelText("First name")).toHaveValue("Ada");
		expect(screen.getByLabelText("Last name")).toHaveValue("Lovelace");
		expect(screen.getByLabelText("Email (optional)")).toHaveValue("ada@example.com");
	});

	it("hides the structured name fields until the legal name is entered and blurred", () => {
		renderForm({ submit: vi.fn(), prefill: EMPTY_PREFILL });
		// Only the legal-name field is shown initially - no structured breakdown.
		expect(screen.getByLabelText("Legal name")).toHaveValue("");
		expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Middle name")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Last name")).not.toBeInTheDocument();
	});

	it("parses a three-part legal name into first / middle / last on blur", () => {
		renderForm({ submit: vi.fn(), prefill: EMPTY_PREFILL });
		const legalName = screen.getByLabelText("Legal name");
		fireEvent.change(legalName, { target: { value: "Grace Brewster Hopper" } });
		fireEvent.blur(legalName);

		expect(screen.getByLabelText("First name")).toHaveValue("Grace");
		expect(screen.getByLabelText("Middle name")).toHaveValue("Brewster");
		expect(screen.getByLabelText("Last name")).toHaveValue("Hopper");
	});

	it("does not clobber manually edited structured fields when the legal name is re-blurred", () => {
		renderForm({ submit: vi.fn(), prefill: EMPTY_PREFILL });
		const legalName = screen.getByLabelText("Legal name");
		fireEvent.change(legalName, { target: { value: "Ada Lovelace" } });
		fireEvent.blur(legalName);

		// Guest corrects the first name by hand...
		fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
		// ...then edits + re-blurs the legal name: the manual correction must survive.
		fireEvent.change(legalName, { target: { value: "Ada King Lovelace" } });
		fireEvent.blur(legalName);

		expect(screen.getByLabelText("First name")).toHaveValue("Augusta");
		expect(screen.getByLabelText("Middle name")).toHaveValue("");
		expect(screen.getByLabelText("Last name")).toHaveValue("Lovelace");
	});

	it("submits the built input and advances (onComplete) on ok", async () => {
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const { onComplete } = renderForm({ submit });

		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0][0]).toEqual({
			legalName: "Ada Lovelace",
			name: { first: "Ada", last: "Lovelace" },
			address: { line1: "1 Analytical Way", city: "London", country: "GB" },
			email: "ada@example.com",
		});
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
	});

	it("advances when the session has no collect step (not_collect_step)", async () => {
		const submit: SubmitSpy = vi
			.fn()
			.mockResolvedValue({ ok: false, code: "not_collect_step", message: "no step" });
		const { onComplete } = renderForm({ submit });

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

		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/not allowlisted for this Checktiv org/i);
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

	it("renders only the template-collected fields from describe() and marks them expected", async () => {
		const submit: SubmitSpy = vi.fn().mockResolvedValue({ ok: true });
		const describeFn = async (): Promise<CollectUserInfoConfigResult> => ({
			ok: true,
			fields: ["dob", "address"],
			captureStructuredName: true,
		});
		const { onComplete } = renderForm({ submit, describe: describeFn });

		// describe() narrows the form: email + phone are dropped, dob + address remain.
		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument();
		// Structured name is still collected (captureStructuredName is true).
		expect(screen.getByLabelText("First name")).toBeInTheDocument();
		expect(screen.getByLabelText("Last name")).toBeInTheDocument();
		// Template-collected fields are shown and marked expected (required, no "(optional)").
		expect(screen.getByLabelText("Date of birth")).toBeRequired();
		expect(screen.getByLabelText("Address line 1")).toBeRequired();

		// Submitting sends only the collected fields; the prefilled email is NOT sent.
		fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-01-02" } });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const sent = submit.mock.calls[0][0];
		expect(sent).toEqual({
			legalName: "Ada Lovelace",
			name: { first: "Ada", last: "Lovelace" },
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

		// Fallback keeps every field, each labeled optional and not required.
		expect(await screen.findByLabelText("Email (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Phone (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Date of birth (optional)")).toBeInTheDocument();
		expect(screen.getByLabelText("Address line 1")).toBeInTheDocument();
		expect(screen.getByLabelText("Email (optional)")).not.toBeRequired();
	});

	it("names the collected field groups in the validation_failed hint", async () => {
		const submit: SubmitSpy = vi
			.fn()
			.mockResolvedValue({ ok: false, code: "validation_failed", message: "opaque 400" });
		const describeFn = async (): Promise<CollectUserInfoConfigResult> => ({
			ok: true,
			fields: ["dob", "address"],
			captureStructuredName: true,
		});
		renderForm({ submit, describe: describeFn });

		await waitFor(() => expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument());
		fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-01-02" } });
		fillRequiredAddress();
		fireEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/your legal name/i);
		expect(alert).toHaveTextContent(/your date of birth/i);
		expect(alert).toHaveTextContent(/complete address/i);
		// The address hint names state/region + postal code (country-aware) so a US
		// applicant who left them blank knows where to look (they are required by the
		// server's country-aware completeness even though the form marks them optional).
		expect(alert).toHaveTextContent(/state or region/i);
		expect(alert).toHaveTextContent(/postal code/i);
	});
});
