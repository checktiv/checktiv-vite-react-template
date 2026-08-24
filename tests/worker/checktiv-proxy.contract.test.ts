/**
 * What this teaches / copy this pattern:
 * A PROVIDER->CONSUMER contract test, run in the real Workers runtime, that drives
 * the REAL browser client (`createChecktivClient`) against the REAL Worker proxy
 * (`checktivProxy`) with only the upstream Checktiv API stubbed (`fetchImpl`). It
 * proves the whole seam at once - header threading, snake_case applicant casing
 * (the ICAO `family_name` / `given_names[]` shape, forwarded opaquely),
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
import {
	MAX_FORWARDED_ISSUES,
	MAX_ISSUE_MESSAGE_LENGTH,
} from "../../src/shared/checktiv-errors";

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

/**
 * The REAL 422 the dev-us public-api returns for the RETIRED `first_name`/`last_name`
 * pair, captured verbatim (only the request_id trimmed). Driving the proxy with the
 * producer's actual output - rather than a re-typed literal - is what keeps this test
 * honest about the envelope: `details.issues[].keys` names the offending request keys
 * and `details.issues[].message` carries the migration guidance, and neither is
 * reachable from the top-level `code`.
 */
function retiredFieldEnvelope() {
	return new Response(
		JSON.stringify({
			error: {
				type: "https://docs.checktiv.com/api/errors/validation_error",
				code: "validation_error",
				message: "Invalid request body",
				param: "applicant",
				request_id: "req_01a014a6",
				doc_url: "https://docs.checktiv.com/api/errors/validation_error",
				details: {
					issues: [
						{
							code: "unrecognized_keys",
							keys: ["first_name", "last_name"],
							path: ["applicant"],
							message:
								'Unknown field "first_name". first_name was removed. Use given_names, an array of strings: given_names: ["Jose", "Maria"] Unknown field "last_name". last_name was removed. Use family_name.',
						},
					],
				},
			},
		}),
		{ status: 422, headers: { "content-type": "application/json" } },
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
				applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" },
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
		// The snake_case applicant is forwarded straight through, OPAQUELY: the proxy
		// never reshapes it, so the ICAO family_name + given_names[] pair (not only
		// email) survives the round-trip byte for byte, ARRAY INCLUDED.
		expect(sent).toMatchObject({
			workflow_template_id: TEMPLATE,
			applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" },
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
				applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" },
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

/**
 * A stand-in non-production public-api origin. Deliberately an `example.com`
 * placeholder: this repo is public, so no fixture may pin a real internal hostname.
 * The dev-cell origin is now supplied entirely by SERVER env, so a test that wants
 * one supplies it here rather than reading it out of the module under test.
 */
const DEV_CELL_API_BASE = "https://api.dev.example.com";

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
				body: JSON.stringify({ applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" } }),
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
				body: JSON.stringify({ applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" } }),
			},
			{ CHECKTIV_DEV_CELL: "us", CHECKTIV_DEV_CELL_API_BASE: DEV_CELL_API_BASE },
		);
		expect(fetchImpl.mock.calls[0][0]).toBe(`${DEV_CELL_API_BASE}/v1/sessions`);
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
			{ CHECKTIV_DEV_CELL: "us", CHECKTIV_DEV_CELL_API_BASE: DEV_CELL_API_BASE },
		);
		expect(fetchImpl.mock.calls[0][0]).toBe(`${DEV_CELL_API_BASE}/v1/sessions/vs_1`);
	});

	it("CHECKTIV_DEV_CELL set WITHOUT its origin var makes NO upstream call (no silent prod relay)", async () => {
		// The load-bearing failure mode. Before the origin moved into env, an unknown
		// flag fell back to the production host - which, now that the flag no longer
		// carries an origin with it, would mean relaying LIVE production traffic while
		// the operator believed they had targeted a dev cell. It must fail instead, and
		// the assertion that proves that is "the upstream was never contacted".
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		try {
			await app.request(
				"/api/checktiv/sessions",
				{
					method: "POST",
					headers: {
						"X-Checktiv-Key": TEST_KEY,
						"X-Checktiv-Template": TEMPLATE,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" },
					}),
				},
				{ CHECKTIV_DEV_CELL: "us" }, // no CHECKTIV_DEV_CELL_API_BASE
			);
		} catch {
			// The misconfiguration throws; what matters is that no fetch happened.
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a hostile CHECKTIV_DEV_CELL_API_BASE instead of fetching it", async () => {
		// Env is deployer-controlled, not request-controlled, so this is a
		// misconfiguration guard rather than an attacker guard - but the cloud-metadata
		// origin is the shape that turns a configurable base URL into a forgery
		// primitive, so it must never reach `fetch`.
		const fetchImpl = vi.fn().mockResolvedValue(mintEnvelope());
		const app = checktivProxy({ fetchImpl });
		try {
			await app.request(
				"/api/checktiv/sessions",
				{
					method: "POST",
					headers: {
						"X-Checktiv-Key": TEST_KEY,
						"X-Checktiv-Template": TEMPLATE,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" },
					}),
				},
				{ CHECKTIV_DEV_CELL: "us", CHECKTIV_DEV_CELL_API_BASE: "http://169.254.169.254" },
			);
		} catch {
			// The rejected origin throws; what matters is that no fetch happened.
		}
		expect(fetchImpl).not.toHaveBeenCalled();
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
		// SNAKE_CASE on the wire. The public API's workspace_token request body
		// takes `actor.ext_id`, not `actor.extId` (it was snake_cased upstream in
		// CT-401). This assertion previously pinned the camelCase spelling against
		// a MOCKED upstream, so it stayed green for months while every real mint
		// 422'd with `Unknown field "extId". Did you mean "ext_id"?` and the staff
		// reviewer failed to load. Testing our own half against our own fixture is
		// exactly what let the two drift.
		expect(sent.actor).toEqual({ ext_id: "demo-manager", name: "Demo Manager" });
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
			body: JSON.stringify({ applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" } }),
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

	it("FORWARDS the upstream 422 details.issues so the caller learns WHICH field failed", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(retiredFieldEnvelope());
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
		expect(res.status).toBe(422);
		const body = await res.json<{
			error: string;
			code: string;
			details?: { issues: Array<{ message: string; keys?: string[]; path?: string }> };
		}>();
		expect(body.code).toBe("validation_error");

		// The migration guidance is the ONLY place a caller can learn that the retired
		// pair was replaced, so it must survive into the human-facing message - not be
		// collapsed into the generic "check your inputs and retry" sentence.
		expect(body.error).toMatch(/given_names/);
		expect(body.error).toMatch(/family_name/);
		expect(body.error).not.toMatch(/^The verification service rejected the request\.$/);

		// ...and structurally, so a caller can highlight the offending field instead.
		expect(body.details?.issues).toHaveLength(1);
		expect(body.details?.issues[0].keys).toEqual(["first_name", "last_name"]);
		// The upstream path array is joined into the dotted form a caller can search for.
		expect(body.details?.issues[0].path).toBe("applicant");
	});

	it("still DROPS the free-form top-level error.message while forwarding the issues", async () => {
		// The top-level message is unstructured and has been observed echoing
		// key-adjacent request detail, so the asymmetry is deliberate: issues in,
		// message out. This pins that boundary.
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "validation_error",
						message: "leaky upstream detail Bearer ah_sk_us_test_x",
						details: { issues: [{ code: "custom", path: ["applicant", "family_name"], message: "must not be blank" }] },
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
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
			body: JSON.stringify({ applicant: { family_name: "", email: "a@b.co" } }),
		});
		const raw = JSON.stringify(await res.json());
		expect(raw).toContain("applicant.family_name: must not be blank");
		expect(raw).not.toContain("leaky upstream detail");
		expect(raw).not.toContain("ah_sk_");
		expect(raw).not.toContain("Bearer");
	});

	it("DROPS an individual issue whose own text carries a credential marker", async () => {
		// Defense in depth: even if an upstream issue message were to change shape and
		// start echoing the request, no key or bearer token may leave this proxy. The
		// clean issue beside it still gets through, so the scrub is per-issue, not
		// all-or-nothing.
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "validation_error",
						details: {
							issues: [
								{ message: "rejected request authorized by ah_sk_us_test_x", path: ["applicant"] },
								{ message: "must not be blank", path: ["applicant", "family_name"] },
							],
						},
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
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
			body: JSON.stringify({ applicant: { email: "a@b.co" } }),
		});
		const body = await res.json<{ details?: { issues: Array<{ message: string }> } }>();
		expect(body.details?.issues).toHaveLength(1);
		expect(body.details?.issues[0].message).toBe("must not be blank");
		expect(JSON.stringify(body)).not.toContain("ah_sk_");
	});

	it("caps the number of forwarded issues and the length of each message", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "validation_error",
						details: {
							issues: Array.from({ length: 12 }, (_, i) => ({
								message: `issue ${i} ${"x".repeat(1000)}`,
								path: ["applicant"],
							})),
						},
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
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
			body: JSON.stringify({ applicant: { email: "a@b.co" } }),
		});
		const body = await res.json<{ details?: { issues: Array<{ message: string }> } }>();
		expect(body.details?.issues).toHaveLength(MAX_FORWARDED_ISSUES);
		for (const issue of body.details!.issues) {
			expect(issue.message.length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE_LENGTH);
		}
	});

	it("keeps the generic 422 sentence when upstream named no issues", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "validation_error" } }), {
				status: 422,
				headers: { "content-type": "application/json" },
			}),
		);
		const app = checktivProxy({ fetchImpl });
		const res = await app.request("/api/checktiv/sessions", {
			method: "POST",
			headers: {
				"X-Checktiv-Key": TEST_KEY,
				"X-Checktiv-Template": TEMPLATE,
				"content-type": "application/json",
			},
			body: JSON.stringify({ applicant: { email: "a@b.co" } }),
		});
		const body = await res.json<{ error: string; details?: unknown }>();
		expect(body.error).toBe(
			"The verification service rejected the request. Check your inputs and retry.",
		);
		expect(body.details).toBeUndefined();
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
			body: JSON.stringify({ applicant: { family_name: "B", given_names: ["A"], email: "a@b.co" } }),
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
			family_name: "Lovelace",
			given_names: ["Ada"],
			email: "ada@example.com",
		});
		expect(result.id).toBe("vs_1");
		expect(result.clientToken).toBe("ct_x");

		// The client set both headers on the proxy request.
		const proxyInit = toProxy.mock.calls[0][1];
		const proxyHeaders = proxyInit.headers as Record<string, string>;
		expect(proxyHeaders["X-Checktiv-Key"]).toBe(TEST_KEY);
		expect(proxyHeaders["X-Checktiv-Template"]).toBe(TEMPLATE);

		// The structured name fields survive all the way to the upstream wire body,
		// with given_names still an ARRAY (never flattened to a string).
		const sentUpstream = JSON.parse(upstream.mock.calls[0][1].body as string);
		expect(sentUpstream.applicant).toEqual({
			family_name: "Lovelace",
			given_names: ["Ada"],
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
				family_name: "Lovelace",
				given_names: ["Ada"],
				email: "ada@example.com",
			}),
		).rejects.toMatchObject({
			name: "ChecktivClientError",
			code: "missing_client_token",
			status: 502,
		});
		// It is the typed error, not a resolved empty-string result.
		await expect(
			client.createSession({ family_name: "Lovelace", given_names: ["Ada"], email: "ada@example.com" }),
		).rejects.toBeInstanceOf(ChecktivClientError);
	});

	it("a retired-field 422 reaches the CLIENT as actionable guidance, not a generic sentence", async () => {
		// The DX regression this guards: driving the mint with the retired
		// `first_name`/`last_name` pair produces an upstream 422 whose issues explain
		// exactly what replaced them. Before the proxy forwarded `details.issues`, every
		// integrator saw only "check your inputs and retry" and had no way to reach the
		// guidance - the migration was invisible from inside the demo.
		const upstream = vi.fn().mockResolvedValue(retiredFieldEnvelope());
		const app = checktivProxy({ fetchImpl: upstream });
		const client = createChecktivClient({
			fetchImpl: async (path, init) => app.request(path, init, {}),
			getConfig: () => demoConfig(TEST_KEY),
		});

		const error = await client
			// The applicant shape is deliberately NOT the retired one here (it no longer
			// typechecks); the stubbed upstream supplies the 422 this asserts on.
			.createSession({ reference_name: "Ada Lovelace", email: "ada@example.com" })
			.then(
				() => null,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ChecktivClientError);
		const clientError = error as ChecktivClientError;
		expect(clientError.status).toBe(422);
		expect(clientError.code).toBe("validation_error");
		// The guidance is in the thrown message, so the demo's existing error banner
		// (which renders `error.message`) shows it with no consumer change at all.
		expect(clientError.message).toMatch(/given_names/);
		expect(clientError.message).toMatch(/family_name/);
		// ...and structurally, for a caller that wants to highlight the field.
		expect(clientError.issues).toHaveLength(1);
		expect(clientError.issues[0].keys).toEqual(["first_name", "last_name"]);
		expect(clientError.issues[0].path).toBe("applicant");
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
