// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * <SetupForm> is the bring-your-own-key bootstrap - the FIRST screen every
 * visitor hits. We render the injectable inner `SetupForm` (NOT the default
 * export) inside a bare `MemoryRouter` (no `<AppShell>`, matching its unshelled
 * contract) with a real "/reservations" route
 * standing in for the redirect target and a real "wt_" list route. The template
 * list fetch is an INJECTED dep (`fetchTemplates`) with `debounceMs={0}`, so the
 * dropdown / loading / empty / error / manual-fallback paths are driven with a
 * typed stub and no network. Navigation is asserted the black-box way: after a
 * successful submit, the "/reservations" route's content appears - not by mocking
 * `useNavigate`. `config-store` IS mocked (a `sessionStorage` side effect this
 * suite does not want to depend on a browser-storage shim to observe).
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { SetupForm, type FetchTemplates } from "../../src/react-app/routes/SetupPage";
import type { WorkflowTemplateSummary } from "../../src/react-app/lib/checktiv-client";
import * as configStore from "../../src/react-app/lib/config-store";

vi.mock("../../src/react-app/lib/config-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/react-app/lib/config-store")>();
	return { ...actual, setConfig: vi.fn() };
});

const VALID_TEST_KEY = "ah_sk_us_test_abc123";
const VALID_LIVE_KEY = "ah_sk_us_live_abc123";
const VALID_TEST_PK = "ah_pk_us_test_abc123";
const VALID_LIVE_PK = "ah_pk_us_live_abc123";

const TEMPLATES: WorkflowTemplateSummary[] = [
	{
		id: "wt_standard",
		name: "Standard check-in",
		isActive: true,
		isDefault: true,
		checkTypes: ["id_verification"],
	},
	{
		id: "wt_enhanced",
		name: "Enhanced screening",
		isActive: true,
		isDefault: false,
		checkTypes: ["id_verification"],
	},
];

const US_TEST_CTX = {
	region: "us",
	mode: "test",
	apiBase: "https://api.us.checktiv.com",
	sdkApiBase: "https://sdk-api.us.checktiv.com",
	workspaceBaseUrl: "https://workspace.us.checktiv.com",
} as const;

function renderSetup(fetchTemplates: FetchTemplates) {
	return render(
		<MemoryRouter initialEntries={["/setup"]}>
			<Routes>
				<Route
					path="/setup"
					element={<SetupForm fetchTemplates={fetchTemplates} debounceMs={0} />}
				/>
				<Route path="/reservations" element={<div>Reservations Home</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

function fillKeys(secretKey: string, publishableKey: string) {
	fireEvent.change(screen.getByLabelText(/secret key/i), { target: { value: secretKey } });
	fireEvent.change(screen.getByLabelText(/publishable key/i), {
		target: { value: publishableKey },
	});
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
}

describe("SetupForm (bring-your-own-key bootstrap)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// This repo's Vitest config does not set `test.globals: true`, so RTL's
	// auto-cleanup never registers - unmount explicitly, or later tests' queries
	// match leftover DOM from earlier `render()` calls in this file.
	afterEach(() => {
		cleanup();
	});

	it("valid test key + pk auto-loads templates into a dropdown; selecting one writes the DemoConfig and navigates", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		// The dropdown appears once the list loads (label = name, value = wt_ id).
		// Exact "Workflow template" targets the SELECT, never the "Workflow template
		// id" fallback input, so findBy waits for the loaded dropdown.
		const select = await screen.findByLabelText("Workflow template");
		expect(select.tagName).toBe("SELECT");
		expect(screen.getByRole("option", { name: /standard check-in/i })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /enhanced screening/i })).toBeInTheDocument();
		// The fetcher was called with the typed keys + derived context.
		expect(fetchTemplates).toHaveBeenCalledWith(VALID_TEST_KEY, VALID_TEST_PK, US_TEST_CTX);

		// Choosing a non-default template flows its id through to the config. (The
		// org default being pre-selected is covered by the live-mode test, which
		// submits without changing the selection and gets `wt_standard`.)
		fireEvent.change(select, { target: { value: "wt_enhanced" } });
		submit();

		expect(configStore.setConfig).toHaveBeenCalledWith({
			secretKey: VALID_TEST_KEY,
			publishableKey: VALID_TEST_PK,
			workflowTemplateId: "wt_enhanced",
			ctx: US_TEST_CTX,
		});
		expect(screen.getByText("Reservations Home")).toBeInTheDocument();
	});

	it("an invalid secret key surfaces the InvalidKeyError message, never fetches templates, and does not navigate", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		// A pk in the secret slot: derivation fails, so the list never fetches and
		// the manual `wt_` fallback stays visible.
		fillKeys("ah_pk_us_live_x", VALID_TEST_PK);
		fireEvent.change(await screen.findByLabelText("Workflow template id"), {
			target: { value: "wt_demo" },
		});
		submit();

		expect(screen.getByText(/enter a valid checktiv secret key/i)).toBeInTheDocument();
		expect(fetchTemplates).not.toHaveBeenCalled();
		expect(configStore.setConfig).not.toHaveBeenCalled();
		expect(screen.queryByText("Reservations Home")).not.toBeInTheDocument();
	});

	it("a malformed publishable key surfaces an inline pk error and does not navigate", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, "not-a-pk");
		fireEvent.change(await screen.findByLabelText("Workflow template id"), {
			target: { value: "wt_demo" },
		});
		submit();

		expect(screen.getByText(/valid checktiv publishable key/i)).toBeInTheDocument();
		expect(fetchTemplates).not.toHaveBeenCalled();
		expect(configStore.setConfig).not.toHaveBeenCalled();
		expect(screen.queryByText("Reservations Home")).not.toBeInTheDocument();
	});

	it("a publishable key for a different cell than the secret key fails with an inline error", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		// us/test secret key but an eu publishable key: same-cell cross-check fails.
		fillKeys(VALID_TEST_KEY, "ah_pk_eu_test_abc123");
		fireEvent.change(await screen.findByLabelText("Workflow template id"), {
			target: { value: "wt_demo" },
		});
		submit();

		expect(screen.getByText(/different region or mode/i)).toBeInTheDocument();
		expect(configStore.setConfig).not.toHaveBeenCalled();
		expect(screen.queryByText("Reservations Home")).not.toBeInTheDocument();
	});

	it("switching to manual entry and typing a non-wt_ id fails fast with an inline error", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);
		await screen.findByLabelText("Workflow template"); // wait for the loaded dropdown

		fireEvent.click(screen.getByRole("button", { name: /enter a template id manually/i }));
		const manual = await screen.findByLabelText("Workflow template id");
		fireEvent.change(manual, { target: { value: "bad-template" } });
		submit();

		expect(screen.getByText(/starts with "wt_"/i)).toBeInTheDocument();
		expect(configStore.setConfig).not.toHaveBeenCalled();
		expect(screen.queryByText("Reservations Home")).not.toBeInTheDocument();
	});

	it("a live-mode key renders the live-mode warning before proceeding, then a second confirm writes the config and navigates", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(TEMPLATES);
		renderSetup(fetchTemplates);
		fillKeys(VALID_LIVE_KEY, VALID_LIVE_PK);
		await screen.findByLabelText("Workflow template"); // dropdown loaded + default selected
		submit();

		// Warning is rendered and nothing has been written/navigated yet.
		expect(screen.getByText(/real verifications run against your org/i)).toBeInTheDocument();
		expect(configStore.setConfig).not.toHaveBeenCalled();
		expect(screen.queryByText("Reservations Home")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /continue with live key/i }));

		expect(configStore.setConfig).toHaveBeenCalledWith({
			secretKey: VALID_LIVE_KEY,
			publishableKey: VALID_LIVE_PK,
			workflowTemplateId: "wt_standard",
			ctx: {
				region: "us",
				mode: "live",
				apiBase: "https://api.us.checktiv.com",
				sdkApiBase: "https://sdk-api.us.checktiv.com",
				workspaceBaseUrl: "https://workspace.us.checktiv.com",
			},
		});
		expect(screen.getByText("Reservations Home")).toBeInTheDocument();
	});

	it("shows a loading state while the template list is in flight", async () => {
		let resolveFetch: (templates: WorkflowTemplateSummary[]) => void = () => {};
		const fetchTemplates = vi.fn<FetchTemplates>().mockReturnValue(
			new Promise<WorkflowTemplateSummary[]>((resolve) => {
				resolveFetch = resolve;
			}),
		);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		expect(await screen.findByText(/loading templates/i)).toBeInTheDocument();
		resolveFetch(TEMPLATES);
		await screen.findByLabelText("Workflow template");
	});

	it("empty state: no templates -> actionable message + reload + manual fallback", async () => {
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue([]);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		expect(await screen.findByText(/no workflow templates were found/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /reload templates/i })).toBeInTheDocument();
		// The manual `wt_` fallback input is available so setup is never dead-ended.
		expect(screen.getByLabelText(/workflow template id/i)).toBeInTheDocument();
	});

	it("error state: fetch failure -> retry + manual fallback that still lets setup proceed", async () => {
		const fetchTemplates = vi
			.fn<FetchTemplates>()
			.mockRejectedValue(new Error("template service unavailable."));
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		expect(await screen.findByText(/could not load your templates/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

		// Graceful fallback: type a wt_ id manually and setup still completes.
		fireEvent.change(screen.getByLabelText(/workflow template id/i), {
			target: { value: "wt_manual" },
		});
		submit();

		expect(configStore.setConfig).toHaveBeenCalledWith(
			expect.objectContaining({ workflowTemplateId: "wt_manual" }),
		);
		expect(screen.getByText("Reservations Home")).toBeInTheDocument();
	});

	it("keeps IDV + server-side-check templates, filters out only custom_form ones", async () => {
		const mixed: WorkflowTemplateSummary[] = [
			{
				id: "wt_idv_watchlist",
				name: "IDV plus watchlist",
				isActive: true,
				isDefault: true,
				// Server-side watchlist runs without an applicant screen -> KEPT.
				checkTypes: ["id_verification", "watchlist"],
			},
			{
				id: "wt_with_custom_form",
				name: "IDV plus custom form",
				isActive: true,
				isDefault: false,
				// custom_form is applicant-rendered + unsupported -> filtered.
				checkTypes: ["id_verification", "custom_form"],
			},
		];
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(mixed);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		const select = await screen.findByLabelText("Workflow template");
		expect(select.tagName).toBe("SELECT");
		// The IDV + watchlist template is offered; only the custom_form one is filtered.
		expect(screen.getByRole("option", { name: /idv plus watchlist/i })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /idv plus custom form/i })).not.toBeInTheDocument();

		// The pre-selected id is the supported template, so setup completes with it.
		submit();
		expect(configStore.setConfig).toHaveBeenCalledWith(
			expect.objectContaining({ workflowTemplateId: "wt_idv_watchlist" }),
		);
	});

	it("keeps a collect_user_info template now that the collect surface supports it", async () => {
		const withCollect: WorkflowTemplateSummary[] = [
			{
				id: "wt_idv_collect",
				name: "IDV plus info collection",
				isActive: true,
				isDefault: true,
				// collect_user_info is now demo-supported -> KEPT.
				checkTypes: ["id_verification", "collect_user_info"],
			},
		];
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(withCollect);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		const select = await screen.findByLabelText("Workflow template");
		expect(select.tagName).toBe("SELECT");
		expect(screen.getByRole("option", { name: /idv plus info collection/i })).toBeInTheDocument();
	});

	it("no-compatible state: every template includes custom_form -> guidance message, no dropdown", async () => {
		const unsupported: WorkflowTemplateSummary[] = [
			{
				id: "wt_full",
				name: "Full onboarding",
				isActive: true,
				isDefault: true,
				checkTypes: ["id_verification", "custom_form"],
			},
			{
				id: "wt_custom_watchlist",
				name: "Custom form plus watchlist",
				isActive: true,
				isDefault: false,
				checkTypes: ["custom_form", "watchlist"],
			},
		];
		const fetchTemplates = vi.fn<FetchTemplates>().mockResolvedValue(unsupported);
		renderSetup(fetchTemplates);
		fillKeys(VALID_TEST_KEY, VALID_TEST_PK);

		expect(
			await screen.findByText(/custom_form/i),
		).toBeInTheDocument();
		// No dropdown is rendered; the manual `wt_` fallback stays available.
		expect(screen.queryByLabelText("Workflow template")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Workflow template id")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /reload templates/i })).toBeInTheDocument();
	});
});
