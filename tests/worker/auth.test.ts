/**
 * What this teaches / copy this pattern:
 * Contract tests for the mock staff-auth gate: `requireStaff` blocks/allows based on
 * a signed cookie, `POST /api/auth/login` sets that cookie with the FULL security
 * flag set (asserted on the raw `Set-Cookie` wire via `Headers.getSetCookie()`, not
 * just cookie presence), and the whole gate fails CLOSED (structured 500, no
 * hardcoded-default fallback) when the cookie-HMAC secret env var is absent. Runs in
 * the Workers pool (not plain Node) so `getSetCookie()` and the Web Crypto HMAC that
 * `hono/cookie` signs with behave exactly as they do in the deployed Worker.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authRoute, requireStaff } from "../../src/worker/auth";

const TEST_SECRET = "test-only-cookie-hmac-secret-do-not-reuse";
/**
 * Both fixtures are explicit, bare partial-Bindings objects (mirroring
 * `tests/worker/index.composition.test.ts`'s pattern for `app.request`'s third
 * arg) rather than the ambient Workers-pool `env` from `cloudflare:test`. The
 * ambient `env` is NOT a reliable "secret absent" fixture: local dev's README has
 * developers create a `.env.local` carrying `AUTH_COOKIE_SECRET` for the real e2e
 * drive, and the Workers pool loads it, so `env.AUTH_COOKIE_SECRET` is only absent
 * on CI, not locally. Passing these fixtures explicitly makes every case below
 * deterministic regardless of what the local environment happens to provide.
 */
const envWithSecret = { AUTH_COOKIE_SECRET: TEST_SECRET };
const envWithoutSecret = {};

/** A tiny host app: the real auth routes plus one protected probe route, mirroring
 * how `worker/index.ts` mounts `authRoute` and gates a staff API route. */
function buildTestApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/", authRoute);
	app.get("/api/staff/ping", requireStaff, (c) => c.json({ ok: true }));
	return app;
}

/** The raw `Set-Cookie` line for `name`, so tests can assert flags on the wire. */
function findSetCookie(res: Response, name: string): string | undefined {
	return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

async function postLogin(
	app: Hono<{ Bindings: Env }>,
	body: unknown,
	testEnv: typeof envWithSecret | typeof envWithoutSecret,
) {
	return app.request(
		"/api/auth/login",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		testEnv,
	);
}

describe("requireStaff", () => {
	it("blocks a request with no cookie", async () => {
		const app = buildTestApp();
		const res = await app.request("/api/staff/ping", {}, envWithSecret);
		expect(res.status).toBe(403);
	});

	it("fails closed with a structured 500 (not a silent 403) when the secret is unset", async () => {
		const app = buildTestApp();
		const res = await app.request("/api/staff/ping", {}, envWithoutSecret);
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ code: "auth_not_configured" });
	});

	it("allows a request bearing the cookie the login route issued", async () => {
		const app = buildTestApp();
		const loginRes = await postLogin(app, { username: "demo", password: "demo" }, envWithSecret);
		expect(loginRes.status).toBe(200);
		const setCookie = findSetCookie(loginRes, "staff_session");
		expect(setCookie).toBeDefined();

		const res = await app.request(
			"/api/staff/ping",
			{ headers: { cookie: setCookie!.split(";")[0] } },
			envWithSecret,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("rejects a tampered cookie value (bad signature)", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/api/staff/ping",
			{ headers: { cookie: "staff_session=not-a-real-signed-value" } },
			envWithSecret,
		);
		expect(res.status).toBe(403);
	});
});

describe("POST /api/auth/login", () => {
	it("rejects wrong credentials and sets no cookie", async () => {
		const app = buildTestApp();
		const res = await postLogin(app, { username: "demo", password: "wrong" }, envWithSecret);
		expect(res.status).toBe(401);
		expect(res.headers.getSetCookie()).toHaveLength(0);
	});

	it("sets a Set-Cookie carrying the full flag set on the wire", async () => {
		const app = buildTestApp();
		const res = await postLogin(app, { username: "demo", password: "demo" }, envWithSecret);
		expect(res.status).toBe(200);
		const setCookie = findSetCookie(res, "staff_session");
		expect(setCookie).toBeDefined();
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toMatch(/SameSite=(Lax|Strict)/);
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toMatch(/Max-Age=\d+/);
	});

	it("fails closed with a structured 500 (never a hardcoded-default secret) when unset", async () => {
		const app = buildTestApp();
		const res = await postLogin(app, { username: "demo", password: "demo" }, envWithoutSecret);
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ code: "auth_not_configured" });
		expect(res.headers.getSetCookie()).toHaveLength(0);
	});
});

describe("POST /api/auth/logout", () => {
	it("clears the cookie on the wire (Max-Age=0)", async () => {
		const app = buildTestApp();
		const res = await app.request("/api/auth/logout", { method: "POST" }, envWithSecret);
		expect(res.status).toBe(200);
		const setCookie = findSetCookie(res, "staff_session");
		expect(setCookie).toBeDefined();
		expect(setCookie).toMatch(/Max-Age=0\b/);
	});
});

describe("GET /api/auth/session", () => {
	it("mirrors requireStaff: 403 unauthenticated, 200 once logged in", async () => {
		const app = buildTestApp();
		const anon = await app.request("/api/auth/session", {}, envWithSecret);
		expect(anon.status).toBe(403);

		const loginRes = await postLogin(app, { username: "demo", password: "demo" }, envWithSecret);
		const setCookie = findSetCookie(loginRes, "staff_session")!;
		const authed = await app.request(
			"/api/auth/session",
			{ headers: { cookie: setCookie.split(";")[0] } },
			envWithSecret,
		);
		expect(authed.status).toBe(200);
	});
});
