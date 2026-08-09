/**
 * What this teaches / copy this pattern:
 * Bring-your-own-key bootstrap - the FIRST screen every visitor hits. The key
 * lives in `sessionStorage` ONLY (via `config-store`): never persisted anywhere
 * else, never logged, never put in the URL. It is intentionally unguarded and
 * unshelled (no `<GuardedRoute>`/`<AppShell>` - see the routing note in
 * `main.tsx`), since there is no `DemoConfig` yet for either of those to check.
 *
 * Workflow-template selection is a DROPDOWN, not a free-text `wt_` field: once
 * the visitor enters a valid secret key AND a matching publishable key, the form
 * auto-fetches the org's workflow templates (secret-key authed, through the
 * same-origin proxy) and lists ONLY the ones this demo can actually run - it filters
 * out templates that include a demo-unsupported applicant step (`custom_form`,
 * which the demo does not render; server-side checks like watchlist
 * / background pair fine with identity verification and are kept). See
 * `isTemplateDemoSupported`. The label is the name, the value is the `wt_` id. Every
 * async state is self-troubleshootable: loading, empty (create one in the console,
 * then reload), no-compatible (every template includes an unsupported applicant step,
 * so use one without it, then reload),
 * and error (check your secret key, then retry) each give an actionable next step,
 * and a "type a template id manually" fallback means neither a template-list
 * outage nor an all-unsupported list ever hard-blocks Setup.
 *
 * Testability: the async list fetch is an injected `fetchTemplates` dep (default
 * wires a one-off `createChecktivClient` over the in-progress keys), so tests
 * drive the dropdown/loading/empty/error/fallback paths with a typed stub and no
 * network - mirroring the `ReservationsView` injectable-inner-component pattern.
 *
 * A `live`-mode key (real verifications, real cost against the visitor's own
 * org) is NOT written/redirected on the first submit - the "Continue" click
 * only reveals a prominent warning and a second, explicit confirm button. That
 * second click is what actually calls `config-store.setConfig` and navigates.
 * Test-mode keys skip the extra step and proceed immediately.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
	assertPublishableKeyMatchesContext,
	deriveKeyContext,
	InvalidKeyError,
	InvalidPublishableKeyError,
	isTemplateDemoSupported,
	isValidWorkflowTemplateId,
	type KeyContext,
} from "../../shared/checktiv-config";
import { setConfig } from "../lib/config-store";
import {
	createChecktivClient,
	type WorkflowTemplateSummary,
} from "../lib/checktiv-client";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Footer } from "../components/Footer";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/** A validated key + template pending the live-mode confirm step. */
interface PendingLiveSubmit {
	secretKey: string;
	publishableKey: string;
	workflowTemplateId: string;
	ctx: KeyContext;
}

/**
 * Injected template-list fetcher. Given the in-progress (valid) keys + derived
 * context, resolves the org's workflow templates. Default impl below; tests
 * inject a stub so no network / `sessionStorage` is needed.
 */
export type FetchTemplates = (
	secretKey: string,
	publishableKey: string,
	ctx: KeyContext,
) => Promise<WorkflowTemplateSummary[]>;

/** Default fetcher: a one-off client scoped to the typed keys (config not yet stored). */
const defaultFetchTemplates: FetchTemplates = async (secretKey, publishableKey, ctx) => {
	const client = createChecktivClient({
		getConfig: () => ({ secretKey, publishableKey, workflowTemplateId: "", ctx }),
	});
	const { templates } = await client.listWorkflowTemplates();
	return templates;
};

/** Async state machine for the workflow-template list. */
type TemplatesState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "loaded"; templates: WorkflowTemplateSummary[] }
	| { kind: "empty" }
	| { kind: "no-compatible" }
	| { kind: "error"; message: string };

/**
 * Try to derive the region-pinned context from the typed keys WITHOUT surfacing
 * an inline error (those show only on submit). Returns null while either key is
 * still incomplete/mismatched, which keeps the auto-fetch from firing early.
 */
function tryDeriveContext(secretKey: string, publishableKey: string): KeyContext | null {
	try {
		const ctx = deriveKeyContext(secretKey);
		assertPublishableKeyMatchesContext(publishableKey, ctx);
		return ctx;
	} catch {
		return null;
	}
}

/** Order templates for the dropdown: the org default first, then by name. */
function sortTemplates(templates: WorkflowTemplateSummary[]): WorkflowTemplateSummary[] {
	return [...templates].sort((a, b) => {
		if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Injectable inner form. Rendered directly by tests with a stub `fetchTemplates`;
 * the default export wires the real fetcher. `debounceMs` is injectable so tests
 * can drop the auto-fetch debounce to zero.
 */
export function SetupForm({
	fetchTemplates = defaultFetchTemplates,
	debounceMs = 300,
}: {
	fetchTemplates?: FetchTemplates;
	debounceMs?: number;
} = {}) {
	const navigate = useNavigate();
	const [secretKey, setSecretKey] = useState("");
	const [publishableKey, setPublishableKey] = useState("");
	const [workflowTemplateId, setWorkflowTemplateId] = useState("");
	const [keyError, setKeyError] = useState<string | null>(null);
	const [pkError, setPkError] = useState<string | null>(null);
	const [templateError, setTemplateError] = useState<string | null>(null);
	const [pendingLive, setPendingLive] = useState<PendingLiveSubmit | null>(null);
	const [templatesState, setTemplatesState] = useState<TemplatesState>({ kind: "idle" });
	const [manualEntry, setManualEntry] = useState(false);
	// Bumped by Reload / Retry to re-run the auto-fetch effect on demand.
	const [reloadNonce, setReloadNonce] = useState(0);

	/** Non-null only when BOTH keys are well-formed and address the same cell. */
	const keyContext = useMemo(
		() => tryDeriveContext(secretKey, publishableKey),
		[secretKey, publishableKey],
	);

	function proceed(config: PendingLiveSubmit) {
		setConfig(config);
		navigate("/reservations");
	}

	/** Editing any field after the live-mode confirm appears re-opens the form. */
	function resetPendingLive() {
		if (pendingLive !== null) {
			setPendingLive(null);
		}
	}

	// Auto-fetch the org's workflow templates once both keys are valid. All
	// setState happens INSIDE the debounced timer callback (never synchronously
	// in the effect body), so it does not trigger a cascading render; the
	// `cancelled` flag drops a stale in-flight result if the keys change first.
	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(() => {
			const ctx = tryDeriveContext(secretKey, publishableKey);
			if (!ctx) {
				setTemplatesState({ kind: "idle" });
				return;
			}
			setTemplatesState({ kind: "loading" });
			fetchTemplates(secretKey, publishableKey, ctx)
				.then((templates) => {
					if (cancelled) return;
					if (templates.length === 0) {
						// The org has no workflow templates at all.
						setTemplatesState({ kind: "empty" });
						return;
					}
					// This demo can only mount templates whose steps it can render
					// (identity verification only). Keep just those; if the org has
					// templates but none qualify, surface the "no-compatible" guidance.
					const supported = templates.filter((template) =>
						isTemplateDemoSupported(template.checkTypes),
					);
					if (supported.length === 0) {
						setTemplatesState({ kind: "no-compatible" });
						return;
					}
					const sorted = sortTemplates(supported);
					setTemplatesState({ kind: "loaded", templates: sorted });
					// Pre-select the org default (or first) among the supported list so
					// a valid setup is one click away; the visitor can still change it.
					setManualEntry(false);
					setWorkflowTemplateId(sorted[0].id);
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					setTemplatesState({
						kind: "error",
						message:
							error instanceof Error
								? error.message
								: "We could not load your workflow templates.",
					});
				});
		}, debounceMs);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [secretKey, publishableKey, fetchTemplates, debounceMs, reloadNonce]);

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setKeyError(null);
		setPkError(null);
		setTemplateError(null);
		setPendingLive(null);

		if (!isValidWorkflowTemplateId(workflowTemplateId)) {
			setTemplateError('Select a workflow template, or enter a template id that starts with "wt_".');
			return;
		}

		let ctx: KeyContext;
		try {
			ctx = deriveKeyContext(secretKey);
		} catch (err) {
			setKeyError(err instanceof InvalidKeyError ? err.message : "Enter a valid Checktiv secret key.");
			return;
		}

		// The publishable key is what the guest-check-in SDK sends as
		// `X-Publishable-Key` from a third-party origin; cross-check it addresses the
		// same cell as the secret key so a mismatched pk fails fast at Setup.
		try {
			assertPublishableKeyMatchesContext(publishableKey, ctx);
		} catch (err) {
			setPkError(
				err instanceof InvalidPublishableKeyError
					? err.message
					: "Enter a valid Checktiv publishable key.",
			);
			return;
		}

		const config: PendingLiveSubmit = { secretKey, publishableKey, workflowTemplateId, ctx };
		if (ctx.mode === "live") {
			// Hold here - the live-mode warning below is the "before proceeding"
			// gate; only the explicit confirm click below calls proceed().
			setPendingLive(config);
			return;
		}
		proceed(config);
	}

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
				<div className="w-full max-w-sm text-sm text-muted-foreground">
					<p>
						Welcome. This is a sample property-management app that demonstrates integrating
						Checktiv identity verification end to end. Paste your Checktiv keys below to run the
						demo against your own org, then create a booking to see it in action.
					</p>
				</div>

				<Card className="w-full max-w-sm">
					<CardHeader>
						<CardTitle>Connect your Checktiv key</CardTitle>
						<CardDescription>
							Enter a Checktiv secret key and publishable key, then pick a workflow template to
							run this demo against your org. The secret key is kept in this tab's session only -
							it is never persisted or logged. The publishable key is public and only ever leaves
							the browser inside the guest check-in link.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleSubmit} className="grid gap-4">
							<div className="grid gap-1.5">
								<Label htmlFor="secretKey">Secret key</Label>
								<Input
									id="secretKey"
									autoComplete="off"
									placeholder="ah_sk_..."
									value={secretKey}
									onChange={(event) => {
										setSecretKey(event.target.value);
										resetPendingLive();
									}}
									required
								/>
								{keyError ? <p className="text-sm text-destructive">{keyError}</p> : null}
							</div>

							<div className="grid gap-1.5">
								<Label htmlFor="publishableKey">Publishable key</Label>
								<Input
									id="publishableKey"
									autoComplete="off"
									placeholder="ah_pk_..."
									value={publishableKey}
									onChange={(event) => {
										setPublishableKey(event.target.value);
										resetPendingLive();
									}}
									required
								/>
								{pkError ? <p className="text-sm text-destructive">{pkError}</p> : null}
							</div>

							<TemplateField
								state={templatesState}
								keysValid={keyContext !== null}
								manualEntry={manualEntry}
								workflowTemplateId={workflowTemplateId}
								onSelect={(value) => {
									setWorkflowTemplateId(value);
									setTemplateError(null);
									resetPendingLive();
								}}
								onManualChange={(value) => {
									setWorkflowTemplateId(value);
									setTemplateError(null);
									resetPendingLive();
								}}
								onEnterManually={() => setManualEntry(true)}
								onReload={() => {
									setManualEntry(false);
									setReloadNonce((nonce) => nonce + 1);
								}}
							/>
							{templateError ? (
								<p className="text-sm text-destructive">{templateError}</p>
							) : null}

							{pendingLive ? (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
									<strong className="font-medium">Live mode: real verifications run against your org.</strong>{" "}
									This may incur cost. Confirm you want to continue with a live key.
									<Button
										type="button"
										variant="destructive"
										className="mt-3 w-full"
										onClick={() => proceed(pendingLive)}
									>
										Continue with live key
									</Button>
								</div>
							) : (
								<Button type="submit">Continue</Button>
							)}
						</form>
					</CardContent>
				</Card>
			</div>
			<Footer />
		</div>
	);
}

/**
 * The workflow-template field: a dropdown once templates load, with a manual
 * `wt_` free-text fallback for the idle / empty / error / opted-out states. Every
 * non-loaded state offers an actionable next step (reload, retry, or type an id),
 * so a template-list outage never dead-ends Setup.
 */
function TemplateField({
	state,
	keysValid,
	manualEntry,
	workflowTemplateId,
	onSelect,
	onManualChange,
	onEnterManually,
	onReload,
}: {
	state: TemplatesState;
	keysValid: boolean;
	manualEntry: boolean;
	workflowTemplateId: string;
	onSelect: (value: string) => void;
	onManualChange: (value: string) => void;
	onEnterManually: () => void;
	onReload: () => void;
}) {
	// The dropdown renders only for a loaded list the visitor has not opted out of.
	if (state.kind === "loaded" && !manualEntry) {
		return (
			<div className="grid gap-1.5">
				<Label htmlFor="workflowTemplate">Workflow template</Label>
				<select
					id="workflowTemplate"
					value={workflowTemplateId}
					onChange={(event) => onSelect(event.target.value)}
					className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					<option value="" disabled>
						Select a workflow template
					</option>
					{state.templates.map((template) => (
						<option key={template.id} value={template.id}>
							{template.name}
							{template.isActive ? "" : " (inactive)"}
						</option>
					))}
				</select>
				<button
					type="button"
					onClick={onEnterManually}
					className="justify-self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					Enter a template id manually
				</button>
			</div>
		);
	}

	if (state.kind === "loading") {
		return (
			<div className="grid gap-1.5">
				<Label htmlFor="workflowTemplate">Workflow template</Label>
				<p className="text-sm text-muted-foreground">Loading templates...</p>
			</div>
		);
	}

	// Idle / empty / no-compatible / error / manual-entry: the free-text `wt_`
	// fallback input.
	const helpText =
		state.kind === "error"
			? `We could not load your templates: ${state.message} Check your secret key, then retry, or enter a template id below.`
			: state.kind === "empty"
				? "No workflow templates were found for this org. Create one in the Checktiv console, then reload, or enter a template id below."
				: state.kind === "no-compatible"
					? "All of your workflow templates include an applicant step this demo does not render (custom_form). Use or create a workflow template without that step, then reload, or enter a template id below."
					: manualEntry
						? "Enter the workflow template id, or reload to pick from the list."
						: keysValid
							? "Enter a workflow template id, or wait for the list to load."
							: "Enter your secret and publishable keys to load templates, or type a template id.";

	return (
		<div className="grid gap-1.5">
			<Label htmlFor="workflowTemplate">Workflow template id</Label>
			<Input
				id="workflowTemplate"
				autoComplete="off"
				placeholder="wt_..."
				value={workflowTemplateId}
				onChange={(event) => onManualChange(event.target.value)}
				required
			/>
			<p className="text-xs text-muted-foreground">{helpText}</p>
			{state.kind === "error" ||
			state.kind === "empty" ||
			state.kind === "no-compatible" ||
			manualEntry ? (
				<button
					type="button"
					onClick={onReload}
					className="justify-self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					{state.kind === "error" ? "Retry" : "Reload templates"}
				</button>
			) : null}
		</div>
	);
}

/**
 * Route entry: the unguarded/unshelled Setup screen wiring the real template
 * fetcher. Kept a thin wrapper so the injectable `SetupForm` is what tests drive.
 */
export default function SetupPage() {
	return <SetupForm />;
}
