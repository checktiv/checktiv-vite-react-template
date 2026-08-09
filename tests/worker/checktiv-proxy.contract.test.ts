/**
 * What this teaches / copy this pattern:
 * A PROVIDER->CONSUMER contract test, run in the real Workers runtime, that drives
 * the REAL browser client (`createChecktivClient`) against the REAL Worker proxy
 * (`checktivProxy`) with only the upstream Checktiv API stubbed (`fetchImpl`). It
 * proves the whole seam at once - header threading, snake_case applicant casing,
 * the uniform `{ data }` envelope unwrap, the test-mode-only `expected_outcome`
 * drop, and the SSRF-exempt `origin` body field - instead of testing each half
 * against its own hand-built fixture (which would drift silently).
 *
 * The proxy is a Hono factory taking one injected dep `{ fetchImpl }`, so the stub
 * stands in for the upstream `*.checktiv.com` REST call. Per-request env (
 * `PUBLIC_ORIGIN`, `DEMO_ALLOW_DECIDE`) is injected via Hono's `app.request(path,
 * init, env)` third argument, so no Miniflare var wiring is needed.
 */
import { describe, it, expect, vi } from "vitest";
import { checktivProxy } from "../../src/worker/checktiv-proxy";
import {
	createChecktivClient,
	ChecktivClientError,
	type CreateSessionResult,
} from "../../src/react-app/lib/checktiv-client";
import type { DemoConfig } from "../../src/shared/checktiv-config";
import { deriveKeyContext } from "../../src/shared/checktiv-config";

const TEST_KEY = "ah_sk_us_test_x";
const LIVE_KEY = "ah_sk_us_live_x";
const TEMPLATE = "wt_demo";

/** A full `{ data: SessionResponse }` mint envelope the upstream stub returns. */
function mintEnvelope() {
	return new Response(
		JSON.stringify({
			data: {
				id: "vs_1",
				status: "pending",
				client_token: "ct_x",
				short_code: "ABC123",
				applicant_url: "https://verify.us.checktiv.com/s/ABC123",
				checks: [],
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function demoConfig(secretKey: string): DemoConfig {
	return {
		secretKey,
		publishableKey: secretKey.replace("ah_sk_", "ah_pk_"),
		workflowTemplateId: TEMPLATE,
		ctx: deriveKeyContext(secretKey),
	};
}

/** A `{ data, pagination }` workflow-templates list envelope the upstream returns. */
function templatesEnvelope() {
	return new Response(
		JSON.stringify({
			data: [
				{
					id: "wt_default",
					object: "workflow_template",
					name: "Standard check-in",
					is_default: true,
					is_active: true,
					// The `document` sub-object is camelCase (`checkType`) even though the
					// top-level template fields are snake_case.
					document: { steps: [{ type: "check", checkType: "id_verification" }] },
				},
				{
					id: "wt_extra",
					object: "workflow_template",
					name: "Enhanced screening",
					is_default: false,
					is_active: false,
					document: {
						steps: [
							{ type: "check", checkType: "id_verification" },
							{ type: "check", checkType: "collect_user_info" },
						],
					},
				},
			],
			pagination: { next_cursor: null, has_more: false },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

// ---------------------------------------------------------------------------
// Proxy driven directly (explicit headers) - the raw wire contract
// ---------------------------------------------------------------------------

describe("checktivProxy - raw POST /v1/sessions mint", () => {
	it("full SessionResponse round-trips; upstream gets bearer + snake_case wire body", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			headers: {
				"X-Checktiv-Key": TEST_KEY,
				"X-Checktiv-Template": TEMPLATE,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				applicant: { first_name: "A", last_name: "B", email: "a@b.co" },
				expectedOutcome: "approved",
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			id: "vs_1",
			clientToken: "ct_x",
			status: "pending",
			shortCode: "ABC123",
			applicantUrl: "https://verify.us.checktiv.com/s/ABC123",
		});

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.us.checktiv.com/v1/sessions");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TEST_KEY}`,
		);
		const sent = JSON.parse(init.body as string);
		// The snake_case applicant is forwarded straight through: first_name AND
		// last_name (not only email) survive the round-trip.
		expect(sent).toMatchObject({
			workflow_template_id: TEMPLATE,
			applicant: { first_name: "A", last_name: "B", email: "a@b.co" },
			expected_outcome: "approved",
		});
	});

	it("missing X-Checktiv-Key -> 401 and never calls upstream", async () => {
		const fetchImpl = vi.fn();
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			body: "{}",
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(401);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("live-mode DROPS expected_outcome from the forwarded upstream body", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			headers: {
				"X-Checktiv-Key": LIVE_KEY,
				"X-Checktiv-Template": TEMPLATE,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				applicant: { first_name: "A", last_name: "B", email: "a@b.co" },
				expectedOutcome: "approved",
			}),
		});
		expect(res.status).toBe(200);
		const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
		expect(sent).not.toHaveProperty("expected_outcome");
		// live key still resolves to the us REST base
		expect(fetchImpl.mock.calls[0][0]).toBe("https://api.us.checktiv.com/v1/sessions");
	});
});

describe("checktivProxy - dev-cell targeting (DEV-TEST-ONLY)", () => {
	it("prod (no CHECKTIV_DEV_CELL): mint targets the key-derived prod host", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions",
			{
				method: "POST",
				headers: {
					"X-Checktiv-Key": TEST_KEY,
					"X-Checktiv-Template": TEMPLATE,
					"content-type": "application/json",
				},
				body: JSON.stringify({ applicant: { first_name: "A", last_name: "B", email: "a@b.co" } }),
			},
			{}, // no CHECKTIV_DEV_CELL
		);
		expect(fetchImpl.mock.calls[0][0]).toBe("https://api.us.checktiv.com/v1/sessions");
	});

	it("CHECKTIV_DEV_CELL=us: mint targets the non-production public-api origin", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions",
			{
				method: "POST",
				headers: {
					"X-Checktiv-Key": TEST_KEY,
					"X-Checktiv-Template": TEMPLATE,
					"content-type": "application/json",
				},
				body: JSON.stringify({ applicant: { first_name: "A", last_name: "B", email: "a@b.co" } }),
			},
			{ CHECKTIV_DEV_CELL: "us" },
		);
		expect(fetchImpl.mock.calls[0][0]).toBe("https://api-dev.us.example.test/v1/sessions");
	});

	it("CHECKTIV_DEV_CELL=us: the status poll ALSO targets the non-production origin", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ data: { id: "vs_1", status: "processing", checks: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions/vs_1",
			{ method: "GET", headers: { "X-Checktiv-Key": TEST_KEY } },
			{ CHECKTIV_DEV_CELL: "us" },
		);
		expect(fetchImpl.mock.calls[0][0]).toBe("https://api-dev.us.example.test/v1/sessions/vs_1");
	});

	it("an unknown CHECKTIV_DEV_CELL value falls back to the prod host", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions",
			{
				method: "POST",
				headers: {
					"X-Checktiv-Key": TEST_KEY,
					"X-Checktiv-Template": TEMPLATE,
					"content-type": "application/json",
				},
				body: JSON.stringify({ applicant: { first_name: "A", last_name: "B", email: "a@b.co" } }),
			},
			{ CHECKTIV_DEV_CELL: "moon" },
		);
		expect(fetchImpl.mock.calls[0][0]).toBe("https://api.us.checktiv.com/v1/sessions");
	});
});

describe("checktivProxy - GET /v1/workflow-templates list", () => {
	it("maps the { data, pagination } envelope to a { templates } display shape", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(templatesEnvelope());
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/workflow-templates", {
			method: "GET",
			headers: { "X-Checktiv-Key": TEST_KEY },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			templates: [
				{
					id: "wt_default",
					name: "Standard check-in",
					isActive: true,
					isDefault: true,
					checkTypes: ["id_verification"],
				},
				{
					id: "wt_extra",
					name: "Enhanced screening",
					isActive: false,
					isDefault: false,
					checkTypes: ["id_verification", "collect_user_info"],
				},
			],
		});

		// upstream: secret-key bearer, GET, the /v1/workflow-templates path (single page)
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.us.checktiv.com/v1/workflow-templates?limit=100");
		expect(init.method).toBe("GET");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
	});

	it("missing X-Checktiv-Key -> 401 and never calls upstream", async () => {
		const fetchImpl = vi.fn();
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/workflow-templates", { method: "GET" });
		expect(res.status).toBe(401);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("drops rows without a wt_ id and falls back to the id when name is absent", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ id: "wt_named", name: "Has a name" },
						{ id: "wt_nameless" }, // no name -> label falls back to the id
						{ id: "not_a_template", name: "Garbage row" }, // wrong prefix -> dropped
					],
					pagination: { next_cursor: null, has_more: false },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/workflow-templates", {
			method: "GET",
			headers: { "X-Checktiv-Key": TEST_KEY },
		});
		expect(res.status).toBe(200);
		const body = await res.json<{ templates: Array<{ id: string; name: string }> }>();
		expect(body.templates.map((t) => t.id)).toEqual(["wt_named", "wt_nameless"]);
		expect(body.templates[1].name).toBe("wt_nameless");
	});

	it("maps an upstream 401 to a sanitized, actionable forbidden response (no raw echo)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "unauthorized", message: "bad key ah_sk_us_test_x" },
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/workflow-templates", {
			method: "GET",
			headers: { "X-Checktiv-Key": TEST_KEY },
		});
		expect(res.status).toBe(401);
		expect(JSON.stringify(await res.json())).not.toContain("ah_sk_");
	});
});

describe("checktivProxy - workspace-token mint", () => {
	it("unwraps the { data } envelope (framingToken/dataToken are defined)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						framing_token: "f",
						data_token: "d",
						expires_at: "2026-07-27T00:00:00.000Z",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request(
			"/api/checktiv/sessions/vs_1/workspace-token",
			{
				method: "POST",
				headers: { "X-Checktiv-Key": TEST_KEY, "content-type": "application/json" },
				body: "{}",
			},
			{ PUBLIC_ORIGIN: "https://demo.example" },
		);
		expect(res.status).toBe(200);
		const body = await res.json<{ framingToken?: string; dataToken?: string }>();
		expect(body).toMatchObject({ framingToken: "f", dataToken: "d" });
		expect(body.framingToken).toBeDefined();
		expect(body.dataToken).toBeDefined();

		// upstream body least-privilege READ capabilities + demo-manager actor
		const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
		expect(sent.capabilities).toEqual([
			"session:read",
			"evidence:read",
			"report:read",
		]);
		expect(sent.actor).toEqual({ extId: "demo-manager", name: "Demo Manager" });
		expect(sent.origin).toBe("https://demo.example");
	});

	it("origin falls back to the browser Origin HEADER when PUBLIC_ORIGIN is unset", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: { framing_token: "f", data_token: "d", expires_at: "x" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions/vs_1/workspace-token",
			{
				method: "POST",
				headers: {
					"X-Checktiv-Key": TEST_KEY,
					"content-type": "application/json",
					Origin: "https://tunnel.example",
				},
				body: "{}",
			},
			{}, // no PUBLIC_ORIGIN
		);
		const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
		// origin == the request Origin header, NOT the internal request URL.
		expect(sent.origin).toBe("https://tunnel.example");
	});

	it("does NOT grant session:decide by default (least privilege)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: { framing_token: "f", data_token: "d", expires_at: "x" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		await app.request(
			"/api/checktiv/sessions/vs_1/workspace-token",
			{
				method: "POST",
				headers: { "X-Checktiv-Key": TEST_KEY, "content-type": "application/json" },
				body: "{}",
			},
			{ PUBLIC_ORIGIN: "https://demo.example" }, // DEMO_ALLOW_DECIDE unset
		);
		const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
		expect(sent.capabilities).not.toContain("session:decide");
		expect(sent.capabilities).not.toContain("session:override");
	});
});

describe("checktivProxy - error mapping", () => {
	it("maps a 422 origin_not_permitted to an actionable, sanitized 422 (no raw echo)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "validation_error",
						message: "leaky upstream detail Bearer ah_sk_us_test_x",
						details: { reason: "origin_not_permitted" },
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request(
			"/api/checktiv/sessions/vs_1/workspace-token",
			{
				method: "POST",
				headers: { "X-Checktiv-Key": TEST_KEY, "content-type": "application/json" },
				body: "{}",
			},
			{ PUBLIC_ORIGIN: "https://demo.example" },
		);
		expect(res.status).toBe(422);
		const body = await res.json<{ code?: string }>();
		expect(body.code).toBe("origin_not_permitted");
		// sanitized hint only - never echoes the raw upstream message (which held the key)
		expect(JSON.stringify(body)).not.toContain("ah_sk_");
		expect(JSON.stringify(body)).not.toContain("Bearer");
	});

	it("maps an upstream 402 to an actionable, NON-retry out-of-credits 402", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "payment_required",
						message: "insufficient credits for org (key ah_sk_us_test_x)",
					},
				}),
				{ status: 402, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			headers: {
				"X-Checktiv-Key": TEST_KEY,
				"X-Checktiv-Template": TEMPLATE,
				"content-type": "application/json",
			},
			body: JSON.stringify({ applicant: { first_name: "A", last_name: "B", email: "a@b.co" } }),
		});
		expect(res.status).toBe(402);
		const body = await res.json<{ error: string; code: string; status: number }>();
		expect(body.code).toBe("payment_required");
		expect(body.status).toBe(402);
		// A credits problem is NOT retryable - the hint must not tell them to retry,
		// and it must be sanitized (no raw upstream message echoing the key).
		expect(body.error).toMatch(/out of credits/i);
		expect(body.error).not.toMatch(/retry/i);
		expect(JSON.stringify(body)).not.toContain("ah_sk_");
	});

	it("times out to 504 when the upstream never resolves within the bound", async () => {
		const fetchImpl = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const app = checktivProxy({ fetchImpl, timeoutMs: 5 });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			headers: {
				"X-Checktiv-Key": TEST_KEY,
				"X-Checktiv-Template": TEMPLATE,
				"content-type": "application/json",
			},
			body: JSON.stringify({ applicant: { first_name: "A", last_name: "B", email: "a@b.co" } }),
		});
		expect(res.status).toBe(504);
	});
});

// ---------------------------------------------------------------------------
// The REAL browser client driven against the REAL proxy (closes the seam)
// ---------------------------------------------------------------------------

describe("createChecktivClient -> checktivProxy end to end", () => {
	it("client sets BOTH X-Checktiv-Key and X-Checktiv-Template; casing survives", async () => {
		const upstream = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl: upstream });

		// Capture what the client sends to the proxy, then delegate to app.request.
		const toProxy = vi.fn(async (path: string, init: RequestInit) =>
			app.request(path, init, { PUBLIC_ORIGIN: "https://demo.example" }),
		);
		const client = createChecktivClient({
			fetchImpl: toProxy,
			getConfig: () => demoConfig(TEST_KEY),
		});

		const result: CreateSessionResult = await client.createSession({
			first_name: "Ada",
			last_name: "Lovelace",
			email: "ada@example.com",
		});
		expect(result.id).toBe("vs_1");
		expect(result.clientToken).toBe("ct_x");

		// The client set both headers on the proxy request.
		const proxyInit = toProxy.mock.calls[0][1];
		const proxyHeaders = proxyInit.headers as Record<string, string>;
		expect(proxyHeaders["X-Checktiv-Key"]).toBe(TEST_KEY);
		expect(proxyHeaders["X-Checktiv-Template"]).toBe(TEMPLATE);

		// The split name fields survive all the way to the upstream wire body.
		const sentUpstream = JSON.parse(upstream.mock.calls[0][1].body as string);
		expect(sentUpstream.applicant).toEqual({
			first_name: "Ada",
			last_name: "Lovelace",
			email: "ada@example.com",
		});
	});

	it("rejects with ChecktivClientError when the mint omits client_token (token creation disabled)", async () => {
		// The upstream mint succeeds (200) but returns NO client_token - the exact
		// shape produced when the key/account cannot mint session tokens. The proxy's
		// str() helper coerces the absent field to "", so without the client-side
		// guard this would resolve as a false success. Assert it rejects instead.
		const upstream = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						id: "vs_1",
						status: "pending",
						short_code: "ABC123",
						applicant_url: "https://verify.us.checktiv.com/s/ABC123",
						checks: [],
						// client_token intentionally omitted
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const app = checktivProxy({ fetchImpl: upstream });
		const client = createChecktivClient({
			fetchImpl: async (path, init) =>
				app.request(path, init, { PUBLIC_ORIGIN: "https://demo.example" }),
			getConfig: () => demoConfig(TEST_KEY),
		});

		await expect(
			client.createSession({
				first_name: "Ada",
				last_name: "Lovelace",
				email: "ada@example.com",
			}),
		).rejects.toMatchObject({
			name: "ChecktivClientError",
			code: "missing_client_token",
			status: 502,
		});
		// It is the typed error, not a resolved empty-string result.
		await expect(
			client.createSession({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" }),
		).rejects.toBeInstanceOf(ChecktivClientError);
	});

	it("client.mintWorkspaceToken and getSession round-trip through the proxy", async () => {
		const upstream = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: { framing_token: "f", data_token: "d", expires_at: "x" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ data: { id: "vs_1", status: "completed", checks: [{ type: "idv" }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		const app = checktivProxy({ fetchImpl: upstream });
		const client = createChecktivClient({
			fetchImpl: async (path, init) =>
				app.request(path, init, { PUBLIC_ORIGIN: "https://demo.example" }),
			getConfig: () => demoConfig(TEST_KEY),
		});

		const wtk = await client.mintWorkspaceToken("vs_1");
		expect(wtk.framingToken).toBe("f");
		expect(wtk.dataToken).toBe("d");

		const status = await client.getSession("vs_1");
		expect(status.status).toBe("completed");
		expect(status.checks).toHaveLength(1);
	});

	it("client.listWorkflowTemplates round-trips the { templates } shape through the proxy", async () => {
		const upstream = vi.fn().mockResolvedValue(templatesEnvelope());
		const app = checktivProxy({ fetchImpl: upstream });
		const client = createChecktivClient({
			fetchImpl: async (path, init) => app.request(path, init, {}),
			getConfig: () => demoConfig(TEST_KEY),
		});

		const { templates } = await client.listWorkflowTemplates();
		expect(templates).toEqual([
			{
				id: "wt_default",
				name: "Standard check-in",
				isActive: true,
				isDefault: true,
				checkTypes: ["id_verification"],
			},
			{
				id: "wt_extra",
				name: "Enhanced screening",
				isActive: false,
				isDefault: false,
				checkTypes: ["id_verification", "collect_user_info"],
			},
		]);
		// The client threaded X-Checktiv-Key so the proxy authed against the upstream.
		expect(upstream.mock.calls[0][0]).toBe(
			"https://api.us.checktiv.com/v1/workflow-templates?limit=100",
		);
	});
});
