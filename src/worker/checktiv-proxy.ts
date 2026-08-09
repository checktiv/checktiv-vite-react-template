/**
 * What this teaches / copy this pattern:
 * A STATELESS, key-forwarding Worker proxy in front of the Checktiv REST API. The
 * browser holds the visitor's `ah_sk_*` secret key in `sessionStorage` and sends it
 * as `X-Checktiv-Key`; this proxy forwards it to the correct regional cell and drops
 * it. Nothing is persisted, and the key / request headers / token-bearing response
 * bodies (`client_token`, `framing_token`, `data_token`) are NEVER logged.
 *
 * Why a proxy at all (vs the browser calling Checktiv directly): CORS + not exposing
 * the raw upstream, and it is the single place where the SSRF host-pinning and the
 * test-mode-only `expected_outcome` drop are enforced.
 *
 * SSRF / host pinning: the upstream base (`apiBase`) is derived ONLY from the key's
 * `<region>` via the STATIC table in `shared/origins.ts` (a closed `us|eu` enum),
 * never from a request header/body/query, and is asserted to be a `*.checktiv.com`
 * host before any fetch. The one request-derived value is the `workspace_token`
 * `origin` BODY field (a Checktiv field a mismatch merely 422s upstream, NOT the
 * resolved host) - see `resolveWorkspaceOrigin`.
 *
 * DEV-TEST-ONLY exception: when the SERVER env var `CHECKTIV_DEV_CELL` is set (never
 * a request/user value), `effectiveApiBase` targets a compile-time-constant dev-cell
 * public-api origin (see `shared/dev-cell.ts`) instead of the key-derived prod host.
 * This is the env-gated hook that lets the demo validate the unpublished CT-377
 * `collect_user_info` submit path against dev-us. It is OFF by default (unset), so
 * the prod path is byte-unchanged, and the override origin is still a static constant,
 * not attacker-controlled. Env-unset before finalizing the public demo.
 *
 * Why raw `POST /v1/sessions` instead of `Checktiv.sessions.create`: the SDK returns
 * only `{ clientToken }` and cannot carry `expected_outcome`, but the demo needs the
 * full `{ data: SessionResponse }` (`id`/`status`/`short_code`/`applicant_url`) to
 * persist and poll. Body shape mirrors the Checktiv REST API's create-session request
 * (see https://docs.checktiv.com).
 *
 * Error mapping + timeout patterns follow the Checktiv REST API's error envelope,
 * which is `{ error: { code, message, details } }`; the 422 origin gate surfaces
 * `code === 'validation_error'` with `details.reason === 'origin_not_permitted'`, so
 * `origin_not_permitted` is NOT a top-level code.
 */
import { Hono, type Context } from "hono";
import {
	deriveKeyContext,
	InvalidKeyError,
	type KeyContext,
} from "../shared/checktiv-config";
import { resolveDevCellOrigins } from "../shared/dev-cell";

/** Default upstream timeout; a Checktiv call is aborted past this and maps to 504. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Least-privilege reviewer capabilities the demo grants by default: READ-only, so
 * the embedded reviewer can view everything without writing a decision/override into
 * the real org's audit + decision rows. `session:decide` is opt-in (test-mode only,
 * behind `DEMO_ALLOW_DECIDE`); `session:override` is never granted here.
 */
const READ_CAPABILITIES = [
	"session:read",
	"evidence:read",
	"report:read",
] as const;

/** The hardcoded public reviewer identity carried by the demo's `wk_*` DATA token. */
const DEMO_ACTOR = { extId: "demo-manager", name: "Demo Manager" } as const;

/**
 * Session-id shape gate before interpolating `:id` into an upstream URL (SSRF
 * defense-in-depth alongside `encodeURIComponent`). Public-API session ids are
 * `vs_<base62>`; reject anything else.
 */
const SESSION_ID_RE = /^vs_[A-Za-z0-9_-]+$/;

/** Env fields this proxy reads. Composed into the full worker env in `index.ts`. */
interface ProxyEnv {
	/** Authoritative deploy-time workspace origin for the `workspace_token` body. */
	PUBLIC_ORIGIN?: string;
	/** `'true'` opts the demo into granting `session:decide` (test mode only). */
	DEMO_ALLOW_DECIDE?: string;
	/**
	 * DEV-TEST-ONLY cell-targeting flag (e.g. `"us"`). Unset in prod (byte-unchanged).
	 * When set, every upstream call targets the compile-time-constant dev-cell
	 * public-api origin (see `shared/dev-cell.ts`) instead of the key-derived prod
	 * host - used to validate the unpublished CT-377 `collect_user_info` submit path
	 * against dev-us. Never request/user-derived. Env-unset before finalizing.
	 */
	CHECKTIV_DEV_CELL?: string;
}

/** Narrow fetch signature the proxy needs; DI so tests can stub the upstream. */
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

interface ProxyOptions {
	fetchImpl?: FetchImpl;
	/** Override the upstream timeout (tests pass a tiny value to exercise 504). */
	timeoutMs?: number;
}

/** Sanitized upstream failure descriptor - NEVER the raw Response/JSON body. */
interface UpstreamError {
	status: number;
	code?: string;
	reason?: string;
}

/** Outcome of an upstream call after the `{ data }` envelope is unwrapped. */
type UpstreamOutcome =
	| { kind: "ok"; data: unknown }
	| { kind: "error"; err: UpstreamError }
	| { kind: "timeout" }
	| { kind: "network" };

/**
 * Build the stateless Checktiv proxy sub-app. All routes require `X-Checktiv-Key`.
 * The returned Hono app mounts at `/api/checktiv/*` and is composed in `index.ts`.
 */
export function checktivProxy(options: ProxyOptions = {}): Hono<{
	Bindings: ProxyEnv;
}> {
	const fetchImpl: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const app = new Hono<{ Bindings: ProxyEnv }>();

	// -- POST /api/checktiv/sessions : raw mint ------------------------------
	app.post("/api/checktiv/sessions", async (c) => {
		const resolved = resolveKey(c.req.header("X-Checktiv-Key"));
		if (!resolved.ok) {
			return c.json({ error: resolved.error, code: resolved.code, status: 401 }, 401);
		}
		const { key, ctx } = resolved;
		const apiBase = effectiveApiBase(ctx, c.env);

		const body = await readJsonBody(c.req.raw);
		const applicant = body?.applicant;
		// The workflow template id is a `wt_` id sourced from the `X-Checktiv-Template`
		// header (set by every client call) or, as a fallback, the request body. The
		// applicant journey is provisioned entirely from the session's template.
		const workflowTemplateId =
			c.req.header("X-Checktiv-Template") ??
			(typeof body?.workflowTemplateId === "string" ? body.workflowTemplateId : undefined);
		if (!applicant || !workflowTemplateId) {
			return c.json(
				{
					error:
						"Provide an applicant and a workflow template id (set your template in Setup).",
					code: "invalid_request",
					status: 400,
				},
				400,
			);
		}

		// Wire body mirrors CreateSessionRequest. `expected_outcome` is a TEST-MODE
		// ONLY synthetic-verdict hint: forward it only when present AND the key is a
		// test key; a live key drops it (defense-in-depth - a stale live value would
		// otherwise 422 upstream instead of cleanly no-op'ing).
		const wire: Record<string, unknown> = { applicant, workflow_template_id: workflowTemplateId };
		if (ctx.mode === "test" && typeof body?.expectedOutcome === "string") {
			wire.expected_outcome = body.expectedOutcome;
		}

		const outcome = await callUpstream(fetchImpl, timeoutMs, `${apiBase}/v1/sessions`, {
			key,
			method: "POST",
			body: wire,
		});
		if (outcome.kind !== "ok") {
			return mapFailure(c, outcome);
		}
		const data = asRecord(outcome.data);
		return c.json({
			id: str(data.id),
			clientToken: str(data.client_token),
			applicantUrl: str(data.applicant_url),
			shortCode: str(data.short_code),
			status: str(data.status),
		});
	});

	// -- POST /api/checktiv/sessions/:id/workspace-token : reviewer token ----
	app.post("/api/checktiv/sessions/:id/workspace-token", async (c) => {
		const resolved = resolveKey(c.req.header("X-Checktiv-Key"));
		if (!resolved.ok) {
			return c.json({ error: resolved.error, code: resolved.code, status: 401 }, 401);
		}
		const { key, ctx } = resolved;
		const apiBase = effectiveApiBase(ctx, c.env);

		const sessionId = c.req.param("id");
		if (!SESSION_ID_RE.test(sessionId)) {
			return c.json(
				{ error: "That session id is not valid.", code: "invalid_request", status: 400 },
				400,
			);
		}

		// `origin` is the SSRF-EXEMPT Checktiv body field (a mismatch merely 422s
		// upstream). Source: PUBLIC_ORIGIN env (authoritative), else the incoming
		// browser Origin HEADER - never `new URL(c.req.url).origin`.
		const origin = resolveWorkspaceOrigin(c.env.PUBLIC_ORIGIN, c.req.header("Origin"));

		const capabilities: string[] = [...READ_CAPABILITIES];
		if (c.env.DEMO_ALLOW_DECIDE === "true" && ctx.mode === "test") {
			capabilities.push("session:decide");
		}

		const outcome = await callUpstream(
			fetchImpl,
			timeoutMs,
			`${apiBase}/v1/sessions/${encodeURIComponent(sessionId)}/workspace_token`,
			{ key, method: "POST", body: { origin, actor: DEMO_ACTOR, capabilities } },
		);
		if (outcome.kind !== "ok") {
			return mapFailure(c, outcome);
		}
		const data = asRecord(outcome.data);
		return c.json({
			framingToken: str(data.framing_token),
			dataToken: str(data.data_token),
			expiresAt: typeof data.expires_at === "string" ? data.expires_at : undefined,
		});
	});

	// -- GET /api/checktiv/workflow-templates : list org templates -----------
	// Backs the Setup dropdown. Templates are non-sensitive, but the request
	// still carries the `X-Checktiv-Key` header like every other proxy call, so
	// `resolveKey` (missing/malformed -> 401, host-pinning) applies uniformly.
	// Upstream is public-api `GET /v1/workflow-templates` (secret-key authed,
	// cursor-paginated). The demo fetches a single page of up to 100 rows and
	// maps only the display-relevant fields; a mismatched cell / bad key surfaces
	// through the same sanitized `mapFailure` path as the mint routes.
	app.get("/api/checktiv/workflow-templates", async (c) => {
		const resolved = resolveKey(c.req.header("X-Checktiv-Key"));
		if (!resolved.ok) {
			return c.json({ error: resolved.error, code: resolved.code, status: 401 }, 401);
		}
		const { key, ctx } = resolved;
		const apiBase = effectiveApiBase(ctx, c.env);

		const outcome = await callUpstream(
			fetchImpl,
			timeoutMs,
			`${apiBase}/v1/workflow-templates?limit=100`,
			{ key, method: "GET" },
		);
		if (outcome.kind !== "ok") {
			return mapFailure(c, outcome);
		}
		// The list envelope is `{ data: WorkflowTemplateResponse[], pagination }`;
		// `callUpstream` already unwrapped the top-level `{ data }`, so `outcome.data`
		// IS the array. Map to the minimal display shape the dropdown needs and drop
		// any row without a `wt_` id (defensive against a malformed upstream row).
		const rows = Array.isArray(outcome.data) ? outcome.data : [];
		const templates = rows
			.map((row) => {
				const record = asRecord(row);
				const id = str(record.id);
				return {
					id,
					name: str(record.name) || id,
					isActive: typeof record.is_active === "boolean" ? record.is_active : true,
					isDefault: typeof record.is_default === "boolean" ? record.is_default : false,
					checkTypes: extractCheckTypes(record.document),
				};
			})
			.filter((template) => template.id.startsWith("wt_"));
		return c.json({ templates });
	});

	// -- GET /api/checktiv/sessions/:id : status poll ------------------------
	app.get("/api/checktiv/sessions/:id", async (c) => {
		const resolved = resolveKey(c.req.header("X-Checktiv-Key"));
		if (!resolved.ok) {
			return c.json({ error: resolved.error, code: resolved.code, status: 401 }, 401);
		}
		const { key, ctx } = resolved;
		const apiBase = effectiveApiBase(ctx, c.env);

		const sessionId = c.req.param("id");
		if (!SESSION_ID_RE.test(sessionId)) {
			return c.json(
				{ error: "That session id is not valid.", code: "invalid_request", status: 400 },
				400,
			);
		}

		const outcome = await callUpstream(
			fetchImpl,
			timeoutMs,
			`${apiBase}/v1/sessions/${encodeURIComponent(sessionId)}`,
			{ key, method: "GET" },
		);
		if (outcome.kind !== "ok") {
			return mapFailure(c, outcome);
		}
		const data = asRecord(outcome.data);
		return c.json({
			id: str(data.id),
			status: str(data.status),
			checks: Array.isArray(data.checks) ? data.checks : [],
		});
	});

	return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type KeyResolution =
	| { ok: true; key: string; ctx: KeyContext }
	| { ok: false; error: string; code: string };

/**
 * Resolve the secret key into its region-pinned context. Absent -> 401; malformed
 * -> 401. Asserts the STATIC-derived `apiBase` host ends in `.checktiv.com` (the SDK
 * only checks URL well-formedness, not the host).
 */
function resolveKey(key: string | undefined): KeyResolution {
	if (!key) {
		return {
			ok: false,
			error: "Missing Checktiv key. Complete Setup with your secret key first.",
			code: "missing_key",
		};
	}
	let ctx: KeyContext;
	try {
		ctx = deriveKeyContext(key);
	} catch (err) {
		if (err instanceof InvalidKeyError) {
			return {
				ok: false,
				error: "That Checktiv key is not valid (it must start with ah_sk_).",
				code: "invalid_key",
			};
		}
		throw err;
	}
	if (!new URL(ctx.apiBase).hostname.endsWith(".checktiv.com")) {
		return { ok: false, error: "Refusing to call a non-Checktiv host.", code: "invalid_key" };
	}
	return { ok: true, key, ctx };
}

/**
 * Resolve the upstream public-api base for this request. Prod path: the
 * key-derived `ctx.apiBase` (asserted `*.checktiv.com` in `resolveKey`).
 * DEV-TEST-ONLY: when the SERVER env `CHECKTIV_DEV_CELL` selects a dev cell, use
 * that cell's compile-time-constant public-api origin instead (see
 * `shared/dev-cell.ts`). The override host intentionally bypasses the
 * `.checktiv.com` pin because it is a trusted static constant chosen by a server
 * env flag, NEVER by request/user input, so it introduces no SSRF surface. Unset
 * (the default) returns the prod origin unchanged.
 */
function effectiveApiBase(ctx: KeyContext, env: ProxyEnv | undefined): string {
	// `env` is always present at runtime (Cloudflare provides it), but a Hono
	// `app.request(path, init)` with no third arg leaves it undefined - guard so the
	// prod path never throws on a missing env.
	const devCell = resolveDevCellOrigins(env?.CHECKTIV_DEV_CELL);
	return devCell ? devCell.apiBase : ctx.apiBase;
}

/**
 * Pick the `workspace_token` origin: PUBLIC_ORIGIN env wins; else the browser Origin
 * header (the tunnel-loaded staff page forwards the registered origin). Returns
 * undefined when neither is present, which surfaces upstream as an actionable 422.
 */
function resolveWorkspaceOrigin(
	publicOrigin: string | undefined,
	originHeader: string | undefined,
): string | undefined {
	if (publicOrigin && publicOrigin.length > 0) {
		return publicOrigin;
	}
	return originHeader && originHeader.length > 0 ? originHeader : undefined;
}

/**
 * Perform one upstream call, bounded by an AbortController, and unwrap the `{ data }`
 * envelope. On failure returns ONLY a sanitized `UpstreamError` (status/code/reason)
 * - the raw Response/JSON body (which carries the key on the request and tokens on
 * the response) never escapes this function.
 */
async function callUpstream(
	fetchImpl: FetchImpl,
	timeoutMs: number,
	url: string,
	opts: { key: string; method: "GET" | "POST"; body?: unknown },
): Promise<UpstreamOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let res: Response;
	try {
		const headers: Record<string, string> = { Authorization: `Bearer ${opts.key}` };
		if (opts.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		res = await fetchImpl(url, {
			method: opts.method,
			headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal,
		});
	} catch {
		// No logging: the error object can carry the request (key/headers). Map to a
		// timeout when we aborted, else a generic network failure - both actionable.
		return controller.signal.aborted ? { kind: "timeout" } : { kind: "network" };
	} finally {
		clearTimeout(timer);
	}

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		parsed = undefined;
	}
	if (!res.ok) {
		return { kind: "error", err: extractUpstreamError(res.status, parsed) };
	}
	return { kind: "ok", data: asRecord(parsed).data };
}

/**
 * Extract ONLY the safe fields (status/code/details.reason) from an upstream error
 * body. Never returns the raw body - the message field can echo key-adjacent detail.
 */
function extractUpstreamError(status: number, parsed: unknown): UpstreamError {
	const error = asRecord(asRecord(parsed).error);
	const code = typeof error.code === "string" ? error.code : undefined;
	const reason =
		typeof asRecord(error.details).reason === "string"
			? (asRecord(error.details).reason as string)
			: undefined;
	return { status, code, reason };
}

/**
 * Map a sanitized failure to an actionable client response. The mapper is handed
 * only `{ status, code, reason }` - never the raw upstream Response/JSON body - and
 * returns sanitized hint text only.
 */
function mapFailure(
	c: Context<{ Bindings: ProxyEnv }>,
	outcome: Exclude<UpstreamOutcome, { kind: "ok" }>,
) {
	if (outcome.kind === "timeout") {
		return c.json(
			{ error: "The verification service timed out. Please retry.", code: "timeout", status: 504 },
			504,
		);
	}
	if (outcome.kind === "network") {
		return c.json(
			{
				error: "Could not reach the verification service. Please retry.",
				code: "upstream_unreachable",
				status: 502,
			},
			502,
		);
	}
	return c.json(mapErrorBody(outcome.err), mapHttpStatus(outcome.err));
}

/** Sanitized, actionable client body per upstream status - no raw echo. */
function mapErrorBody(err: UpstreamError): { error: string; code: string; status: number } {
	if (err.status === 401 || err.status === 403) {
		return {
			error: "Your Checktiv key is not authorized for this action. Check the key's scopes.",
			code: "forbidden",
			status: err.status === 401 ? 401 : 403,
		};
	}
	if (err.status === 402) {
		// Out of credits: a NON-retry, actionable hint (retrying an unpaid org just
		// 402s again). The console top-up is the in-product next step.
		return {
			error: "Your Checktiv org is out of credits. Top up to continue.",
			code: "payment_required",
			status: 402,
		};
	}
	if (err.status === 404) {
		return { error: "That verification session was not found.", code: "not_found", status: 404 };
	}
	if (err.status === 422) {
		if (err.code === "validation_error" && err.reason === "origin_not_permitted") {
			return {
				error:
					"This workspace origin is not permitted for your org. Set your workspace origin in the Checktiv console, then retry.",
				code: "origin_not_permitted",
				status: 422,
			};
		}
		return {
			error: "The verification service rejected the request. Check your inputs and retry.",
			code: "validation_error",
			status: 422,
		};
	}
	if (err.status === 429) {
		return { error: "Rate limit reached. Please wait a moment and retry.", code: "rate_limited", status: 429 };
	}
	if (err.status >= 500) {
		return {
			error: "The verification service is temporarily unavailable. Please retry.",
			code: "upstream_unavailable",
			status: 503,
		};
	}
	return { error: "The verification request failed. Please retry.", code: "upstream_error", status: 502 };
}

/** HTTP status the proxy responds with for a given upstream failure. */
function mapHttpStatus(err: UpstreamError): 401 | 402 | 403 | 404 | 422 | 429 | 502 | 503 {
	if (err.status === 401) return 401;
	if (err.status === 402) return 402;
	if (err.status === 403) return 403;
	if (err.status === 404) return 404;
	if (err.status === 422) return 422;
	if (err.status === 429) return 429;
	if (err.status >= 500) return 503;
	return 502;
}

/** Best-effort JSON body read; returns an empty record on any parse failure. */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
	try {
		return asRecord(await req.json());
	} catch {
		return {};
	}
}

/** Coerce an unknown to a plain record for safe field access. */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Coerce a wire field to a string ("" when absent) for the typed result shape. */
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Collect the step check types from a workflow template's `document`. Setup uses
 * these to filter the dropdown to templates this demo can render. The `document`
 * sub-object is camelCase even though the top-level template fields are snake_case,
 * so each step's check type reads as `step.checkType`; we also accept `check_type`
 * defensively. Anything unparseable (no `document`, no `steps` array, empty/non-string
 * check types) collapses to `[]`.
 */
function extractCheckTypes(document: unknown): string[] {
	const steps = asRecord(document).steps;
	if (!Array.isArray(steps)) {
		return [];
	}
	return steps
		.map((step) => {
			const record = asRecord(step);
			return str(record.checkType) || str(record.check_type);
		})
		.filter((checkType) => checkType.length > 0);
}
