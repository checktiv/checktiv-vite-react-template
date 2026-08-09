/**
 * What this teaches / copy this pattern:
 * The browser-side counterpart to the stateless Worker proxy (`worker/checktiv-proxy`).
 * It reads the visitor's `DemoConfig` from the browser-only `config-store` (secret
 * key + workflow template id, held in `sessionStorage`), attaches them as the
 * `X-Checktiv-Key` + `X-Checktiv-Template` request headers, and calls the same-origin
 * proxy at `/api/checktiv/*`. The key is NEVER placed in a URL, body, or log - it
 * rides a header to our own Worker, which forwards it to Checktiv and drops it.
 *
 * The exported RESULT TYPES (`CreateSessionResult` / `WorkspaceTokenResult` /
 * `SessionStatusResult`) are the producer half of a compile-time contract: the
 * pages that consume this client type their mocks against these exports (e.g.
 * `vi.fn<() => Promise<CreateSessionResult>>()` or `satisfies CreateSessionResult`),
 * so a field rename here is a `tsc -b` failure in the consumer's own test rather than
 * a silent runtime drift.
 *
 * `createChecktivClient` takes injected deps (`fetchImpl`, `getConfig`) so the
 * contract test can drive the REAL client against the REAL proxy (`app.request`)
 * with a fixed config, no `sessionStorage` needed. The default singleton
 * `checktivClient` wires the real same-origin `fetch` + `config-store`.
 */
import { getConfig as getStoredConfig } from "./config-store";
import type { DemoConfig } from "../../shared/checktiv-config";

/** Result of a raw `POST /v1/sessions` mint (the fields the booking flow persists and the detail page polls). */
export type CreateSessionResult = {
	id: string;
	clientToken: string;
	applicantUrl: string;
	shortCode: string;
	status: string;
};

/** Result of a `workspace_token` mint (the reviewer embed's short-lived bearers). */
export type WorkspaceTokenResult = {
	framingToken: string;
	dataToken: string;
	expiresAt?: string;
};

/** Result of a session status poll. */
export type SessionStatusResult = {
	id: string;
	status: string;
	// The proxy maps the per-check array through, but this demo intentionally does
	// not render per-check detail (it shows only the reduced session status). The
	// field is kept to document the wire shape you would read for a richer UI.
	checks: unknown[];
};

/** One workflow template as the Setup dropdown consumes it (label = `name`, value = `id`). */
export type WorkflowTemplateSummary = {
	/** The `wt_...` id flowed into `DemoConfig.workflowTemplateId`. */
	id: string;
	/** Human-readable template name for the dropdown label (falls back to `id`). */
	name: string;
	isActive: boolean;
	isDefault: boolean;
	/** The template's step check types; Setup filters to demo-supported templates with this. */
	checkTypes: string[];
};

/** Result of listing the org's workflow templates (backs the Setup dropdown). */
export type ListWorkflowTemplatesResult = {
	templates: WorkflowTemplateSummary[];
};

/** Applicant PII in the snake_case shape the wire `CreateSessionRequest.applicant` expects. */
export interface ApplicantInput {
	first_name: string;
	last_name: string;
	email: string;
}

/** The browser client surface consumed by the demo pages. */
export interface ChecktivClient {
	createSession(
		applicant: ApplicantInput,
		opts?: { expectedOutcome?: string },
	): Promise<CreateSessionResult>;
	mintWorkspaceToken(sessionId: string): Promise<WorkspaceTokenResult>;
	getSession(sessionId: string): Promise<SessionStatusResult>;
	/** List the org's workflow templates (secret-key authed) for the Setup dropdown. */
	listWorkflowTemplates(): Promise<ListWorkflowTemplatesResult>;
}

/** Narrow fetch signature the client needs; DI lets the test target `app.request`. */
type ProxyFetch = (path: string, init: RequestInit) => Promise<Response>;

interface ClientDeps {
	fetchImpl?: ProxyFetch;
	getConfig?: () => DemoConfig | null;
}

/** Thrown when a proxy call fails; `code` mirrors the proxy's actionable error code. */
export class ChecktivClientError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(message: string, code: string, status: number) {
		super(message);
		this.name = "ChecktivClientError";
		this.code = code;
		this.status = status;
	}
}

/**
 * Build a Checktiv browser client. Injects `fetchImpl` (default same-origin `fetch`)
 * and `getConfig` (default `config-store`) so tests can substitute both.
 */
export function createChecktivClient(deps: ClientDeps = {}): ChecktivClient {
	const fetchImpl: ProxyFetch = deps.fetchImpl ?? ((path, init) => fetch(path, init));
	const getConfig = deps.getConfig ?? getStoredConfig;

	function authHeaders(): Record<string, string> {
		const config = getConfig();
		if (!config) {
			throw new ChecktivClientError(
				"No Checktiv key configured. Complete Setup with your secret key first.",
				"not_configured",
				400,
			);
		}
		return {
			"X-Checktiv-Key": config.secretKey,
			"X-Checktiv-Template": config.workflowTemplateId,
			"content-type": "application/json",
		};
	}

	async function call<T>(path: string, init: RequestInit): Promise<T> {
		const res = await fetchImpl(path, init);
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			throw new ChecktivClientError(
				typeof body.error === "string" ? body.error : "The verification request failed.",
				typeof body.code === "string" ? body.code : "request_failed",
				res.status,
			);
		}
		return body as T;
	}

	/**
	 * Shared mint: POST a `{ applicant, ...extra }` body to the proxy and guard the
	 * empty-`client_token` false-success. `extra` carries the optional test-mode
	 * `expectedOutcome` hint; the proxy attaches the workflow template from the
	 * `X-Checktiv-Template` header.
	 */
	async function mintSession(
		applicant: ApplicantInput,
		extra: { expectedOutcome?: string },
	): Promise<CreateSessionResult> {
		const payload: {
			applicant: ApplicantInput;
			expectedOutcome?: string;
		} = { applicant };
		if (extra.expectedOutcome !== undefined) {
			payload.expectedOutcome = extra.expectedOutcome;
		}
		const result = await call<CreateSessionResult>("/api/checktiv/sessions", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(payload),
		});
		// The proxy's `str()` helper coerces a missing upstream `client_token`
		// to "" (this happens when the key/account cannot mint session tokens)
		// rather than failing. Without this guard the mint would
		// resolve as a false success: staff sees "invited" and a check-in link
		// carrying an empty token that the guest page then rejects. Turn the
		// empty token into a clear, recoverable client error at the boundary so
		// the caller's mint-failure handling (draft + actionable "Re-invite")
		// fires instead.
		if (!result.clientToken) {
			throw new ChecktivClientError(
				"Checktiv did not return a check-in token for this session. Make sure your Checktiv key has session (working-token) creation enabled for your account, then retry.",
				"missing_client_token",
				502,
			);
		}
		return result;
	}

	return {
		createSession(applicant, opts) {
			return mintSession(applicant, { expectedOutcome: opts?.expectedOutcome });
		},
		mintWorkspaceToken(sessionId) {
			return call<WorkspaceTokenResult>(
				`/api/checktiv/sessions/${encodeURIComponent(sessionId)}/workspace-token`,
				{ method: "POST", headers: authHeaders(), body: "{}" },
			);
		},
		getSession(sessionId) {
			return call<SessionStatusResult>(
				`/api/checktiv/sessions/${encodeURIComponent(sessionId)}`,
				{ method: "GET", headers: authHeaders() },
			);
		},
		listWorkflowTemplates() {
			// A GET carries no body, but `authHeaders()` still threads
			// `X-Checktiv-Key` (the proxy's list route ignores the template header).
			return call<ListWorkflowTemplatesResult>("/api/checktiv/workflow-templates", {
				method: "GET",
				headers: authHeaders(),
			});
		},
	};
}

/** Default browser singleton: same-origin `fetch` + `config-store`. */
export const checktivClient: ChecktivClient = createChecktivClient();
