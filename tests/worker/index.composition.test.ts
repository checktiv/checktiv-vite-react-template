/**
 * What this teaches / copy this pattern:
 * Composition-root contract tests for `src/worker/index.ts`, run in the REAL
 * Workers pool (`@cloudflare/vitest-pool-workers`). These do NOT re-test each
 * sub-app's internals (that is `reservations.route.test.ts` /
 * `checktiv-proxy.contract.test.ts`); they test the WIRING the composition root
 * owns - the cross-cutting gates and the fail-loud 404, which no sub-app can
 * verify on its own:
 *
 *   - `/api/reservations` is ALWAYS mounted: 200 (read) when `env.DB` is present
 *     and a structured 501 when it is absent (the deployed, stateless shape).
 *   - An unmatched `/api/*` path returns a structured JSON 404 - NEVER the SPA
 *     `index.html` (which would shadow the fail-loud paths the frontend depends
 *     on). The SPA fallback is the static-assets layer's job, not the Worker's.
 *   - The per-IP rate limit is wired across the WHOLE `/api/checktiv/*` relay and
 *     runs BEFORE the key check. This demo has no authentication (see the "NO
 *     AUTHENTICATION" note in `index.ts`), so that limit is the only cost ceiling
 *     on live mints and these are its regression guard: a 429 short-circuits the
 *     relay, and the limiter is consulted even for a request carrying no key.
 *   - The relay is bring-your-own-key: with no `ah_sk_*` it is a 401
 *     `missing_key`, so an unauthenticated caller cannot spend anyone's money.
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

/**
 * A stub `CHECKTIV_RATE_LIMITER` binding. The real binding only exists on the
 * deployed Worker (`env.production.ratelimits` in `wrangler.jsonc`) and the
 * Workers pool binds none, so the limit path is only reachable in a test by
 * injecting one. `outcome` decides whether this stub admits or rejects, and
 * `calls` records the keys it saw so a test can prove the middleware ran.
 */
function stubLimiter(outcome: boolean) {
	const calls: string[] = [];
	const limiter: RateLimit = {
		limit: async ({ key }) => {
			calls.push(key ?? "");
			return { success: outcome };
		},
	};
	return { limiter, calls };
}

describe("worker composition - /api/reservations (always mounted, no auth gate)", () => {
	it("returns 200 for a read when env.DB is present", async () => {
		const res = await app.request("/api/reservations", {}, { DB: env.DB });
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("returns a structured 501 (not a throw) with no env.DB (the deployed shape)", async () => {
		const res = await app.request("/api/reservations", {}, {});
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

describe("worker composition - the per-IP rate limit is the relay's only cost ceiling", () => {
	it("short-circuits a rate-limited request with a structured 429 before the route runs", async () => {
		const { limiter, calls } = stubLimiter(false);
		const res = await app.request(
			"/api/checktiv/sessions",
			{
				method: "POST",
				headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
				body: JSON.stringify({}),
			},
			{ CHECKTIV_RATE_LIMITER: limiter },
		);
		expect(res.status).toBe(429);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "rate_limited" });
		// Keyed on the real edge IP, not a placeholder.
		expect(calls).toEqual(["203.0.113.7"]);
	});

	it("covers a keyless GET too, so an unauthenticated caller cannot bypass the limiter", async () => {
		// The limiter must run BEFORE the key check: a caller with no `ah_sk_*` is
		// exactly the abusive case the ceiling exists for, and if the 401 fired first
		// they could hammer the relay for free.
		const { limiter, calls } = stubLimiter(false);
		const res = await app.request(
			"/api/checktiv/workflow-templates",
			{ headers: { "CF-Connecting-IP": "203.0.113.8" } },
			{ CHECKTIV_RATE_LIMITER: limiter },
		);
		expect(res.status).toBe(429);
		expect(calls).toEqual(["203.0.113.8"]);
	});

	it("lets a request through when the limiter admits it (the limit is not a blanket block)", async () => {
		const { limiter, calls } = stubLimiter(true);
		const res = await app.request(
			"/api/checktiv/workflow-templates",
			{},
			{ CHECKTIV_RATE_LIMITER: limiter },
		);
		// Admitted by the limiter, then stopped by the key requirement below.
		expect(res.status).toBe(401);
		expect(calls).toHaveLength(1);
	});
});

describe("worker composition - the relay is bring-your-own-key (no key, no spend)", () => {
	it("returns 401 missing_key for a relay call carrying no secret key", async () => {
		const res = await app.request("/api/checktiv/workflow-templates", {}, {});
		expect(res.status).toBe(401);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "missing_key" });
	});

	it("returns 401 missing_key for the session mint too (not just the template list)", async () => {
		const res = await app.request(
			"/api/checktiv/sessions",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			},
			{},
		);
		expect(res.status).toBe(401);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "missing_key" });
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
			{ DB: env.DB },
		);

		expect(res.status).toBe(500);
		expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
		const body = (await res.json()) as { error: string; code: string; status: number };
		expect(body).toMatchObject({ code: "d1_migrations_required", status: 500 });
		expect(body.error).toMatch(/db:migrate:local/);
	});
});

/**
 * `public/_headers` is applied by the STATIC-ASSET layer, which `/api/*` never
 * reaches (`run_worker_first` in wrangler.jsonc). These assert the Worker sets the
 * JSON-appropriate subset itself - both the headers that MUST be there and the
 * document-oriented ones that deliberately must NOT, since silently regaining the
 * full document set would be a regression in the opposite direction.
 */
describe("worker composition - /api/* carries its own security headers", () => {
	it("sets the JSON-appropriate set on a successful API response", async () => {
		const res = await app.request("/api/geo", {}, {});
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		// The "if this is ever rendered as a document it can do nothing" policy.
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("base-uri 'none'");
	});

	it("also covers the fail-loud JSON 404, not just matched routes", async () => {
		// The gate is registered before the sub-app mounts, so it wraps the fallback.
		// A header set only on happy paths would miss every error response.
		const res = await app.request("/api/nope", {}, {});
		expect(res.status).toBe(404);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	});

	it("does NOT ship the document-oriented headers a JSON response has no use for", async () => {
		// Each of these is a default the middleware would set if the options were
		// copied wholesale. Turning on a header that does nothing is not free - it
		// teaches a reader to copy it.
		const res = await app.request("/api/geo", {}, {});
		expect(res.headers.get("permissions-policy")).toBeNull();
		expect(res.headers.get("x-xss-protection")).toBeNull();
		expect(res.headers.get("x-dns-prefetch-control")).toBeNull();
		expect(res.headers.get("x-download-options")).toBeNull();
		expect(res.headers.get("x-permitted-cross-domain-policies")).toBeNull();
		expect(res.headers.get("origin-agent-cluster")).toBeNull();
		expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
		// HSTS is owned by the Cloudflare zone, which overrides anything set here.
		expect(res.headers.get("strict-transport-security")).toBeNull();
	});
});
