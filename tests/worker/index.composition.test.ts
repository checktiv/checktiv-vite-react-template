/**
 * What this teaches / copy this pattern:
 * Composition-root contract tests for `src/worker/index.ts`, run in the REAL
 * Workers pool (`@cloudflare/vitest-pool-workers`). These do NOT re-test each
 * sub-app's internals (that is `auth.test.ts` / `reservations.route.test.ts` /
 * `checktiv-proxy.contract.test.ts`); they test the WIRING the composition root
 * owns - the cross-cutting gates and the fail-loud 404, which no sub-app can
 * verify on its own:
 *
 *   - `/api/reservations` is ALWAYS mounted AND fully behind `requireStaff`
 *     (reads included - a read returns guest PII): no cookie -> 403; with a valid
 *     staff cookie it is 200 (read) when `env.DB` is present and a structured 501
 *     when it is absent (the deployed, stateless shape).
 *   - An unmatched `/api/*` path returns a structured JSON 404 - NEVER the SPA
 *     `index.html` (which would shadow the fail-loud paths the frontend depends
 *     on). The SPA fallback is the static-assets layer's job, not the Worker's.
 *   - The `/api/checktiv/*` relay is behind `requireStaff` (no staff cookie -> 403,
 *     so it is never an open key relay) EXCEPT the workflow-template LIST
 *     (`GET /api/checktiv/workflow-templates`), which the PRE-LOGIN Setup screen
 *     fetches: it bypasses the staff gate but still requires a valid secret key
 *     (no key -> 401 missing_key, not a 403), so the exemption is scoped and safe.
 *   - `app.onError` (the composition root's global handler) maps an UNCAUGHT
 *     exception to the same structured envelope every route returns, rather than
 *     Hono's bare `text/plain` 500 - `reservations.route.test.ts` cannot see this,
 *     since it exercises `reservationsRoute()` standalone, never through `app`.
 *
 * Env overrides are passed as `app.request`'s third arg (Hono types it
 * `E["Bindings"] | {}`, so a partial/empty object is the intended way to model a
 * missing binding). `env` from the Workers pool supplies the migrated `DB`.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../../src/worker/index";

const TEST_SECRET = "test-only-cookie-hmac-secret-do-not-reuse";

/**
 * Mint a valid staff-session cookie the same way the real login flow does, so
 * the reservation-read tests can get PAST `requireStaff` to exercise the 200/501
 * branches. Returns just the `name=value` pair for the request `cookie` header.
 */
async function staffCookie(): Promise<string> {
	const res = await app.request(
		"/api/auth/login",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "demo", password: "demo" }),
		},
		{ AUTH_COOKIE_SECRET: TEST_SECRET },
	);
	const setCookie = res.headers.getSetCookie().find((line) => line.startsWith("staff_session="));
	if (!setCookie) throw new Error("login did not issue a staff_session cookie");
	return setCookie.split(";")[0];
}

describe("worker composition - /api/reservations (always mounted, fully staff-gated)", () => {
	it("returns 403 for a read with no staff cookie (reads are gated - they return PII)", async () => {
		const res = await app.request("/api/reservations", {}, { DB: env.DB, AUTH_COOKIE_SECRET: TEST_SECRET });
		expect(res.status).toBe(403);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "forbidden" });
	});

	it("returns 200 for a read with a valid staff cookie when env.DB is present", async () => {
		const cookie = await staffCookie();
		const res = await app.request(
			"/api/reservations",
			{ headers: { cookie } },
			{ DB: env.DB, AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("returns a structured 501 (not a throw) with a valid cookie but no env.DB (deployed shape)", async () => {
		const cookie = await staffCookie();
		const res = await app.request(
			"/api/reservations",
			{ headers: { cookie } },
			{ AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("no_persistence");
		expect(body.error).toMatch(/not available in this deployment/i);
	});
});

describe("worker composition - unmatched /api/* is a JSON 404, never the SPA", () => {
	it("returns a structured JSON 404 for an unknown /api path", async () => {
		const res = await app.request("/api/nope", {}, {});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("not_found");
	});
});

describe("worker composition - /api/checktiv/* is staff-gated (except the pre-login template list)", () => {
	it("returns 403 with no staff cookie (not an open key relay)", async () => {
		const res = await app.request(
			"/api/checktiv/sessions/vs_test",
			{},
			{ AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("forbidden");
	});

	it("EXEMPTS GET /api/checktiv/workflow-templates from the staff gate but still requires a key", async () => {
		// No cookie AND no key: if the staff gate applied it would be 403 forbidden.
		// The exemption lets it through to `resolveKey`, which 401s for a missing key -
		// proving the gate is bypassed for THIS route while the key requirement holds.
		const res = await app.request(
			"/api/checktiv/workflow-templates",
			{},
			{ AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("missing_key");
	});

	it("keeps the staff gate on a NON-GET to the same path (exemption is GET-only)", async () => {
		const res = await app.request(
			"/api/checktiv/workflow-templates",
			{ method: "POST" },
			{ AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(403);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "forbidden" });
	});
});

describe("worker composition - reservation writes are staff-gated too (gate is method-agnostic)", () => {
	it("returns 403 for POST /api/reservations with no staff cookie", async () => {
		const res = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					guestName: "Ada",
					guestEmail: "ada@x.co",
					property: "Unit 1",
					checkIn: "2026-08-01",
					checkOut: "2026-08-03",
				}),
			},
			{ DB: env.DB, AUTH_COOKIE_SECRET: TEST_SECRET },
		);
		expect(res.status).toBe(403);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "forbidden" });
	});
});

describe("worker composition - app.onError maps an uncaught exception to the structured envelope", () => {
	it("returns an actionable db:migrate:local hint for D1's 'no such table' error, never the framework's bare 500", async () => {
		// Storage is isolated PER TEST (vitest-pool-workers default), so dropping the
		// table here does not leak into any other test - each starts from the
		// migrated snapshot `tests/apply-migrations.ts` applies. `env.DB` is typed
		// optional (the deployed shape binds none - see that file), but the test
		// harness always binds it, so a missing binding here is a harness bug.
		if (!env.DB) throw new Error("env.DB is not bound - check vitest.workers.jsonc");
		await env.DB.prepare("DROP TABLE reservations").run();
		const cookie = await staffCookie();

		const res = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({
					guestName: "Ada",
					guestEmail: "ada@x.co",
					property: "Unit 1",
					checkIn: "2026-08-01",
					checkOut: "2026-08-03",
				}),
			},
			{ DB: env.DB, AUTH_COOKIE_SECRET: TEST_SECRET },
		);

		expect(res.status).toBe(500);
		expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
		const body = (await res.json()) as { error: string; code: string; status: number };
		expect(body).toMatchObject({ code: "d1_migrations_required", status: 500 });
		expect(body.error).toMatch(/db:migrate:local/);
	});
});
