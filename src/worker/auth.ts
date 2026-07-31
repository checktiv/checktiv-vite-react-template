/**
 * What this teaches / copy this pattern:
 * A stateless, signed-cookie staff-auth gate for the demo's staff pages
 * (`/reservations`, `/reservations/:id`) using `hono/cookie`'s signed-cookie
 * helpers (HMAC-SHA256 over Web Crypto - no extra dependency). `POST /api/auth/login`
 * checks hardcoded demo credentials and, on success, issues a cookie with the FULL
 * security flag set (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, an explicit
 * `Max-Age`); `requireStaff` verifies that signature on every guarded request.
 * `SameSite=Lax` is the CSRF defense for this demo's cookie-only state-changing
 * endpoints (`/api/reservations` mutations, `/api/auth/logout`) - there is no CSRF
 * token because there is no per-user session to bind one to.
 *
 * FAIL CLOSED, always: both `requireStaff` and `POST /api/auth/login` return a
 * structured `500` if `AUTH_COOKIE_SECRET` is unset, rather than falling back to a
 * hardcoded signing secret. A hardcoded fallback would be a committed-secret smell
 * (anyone reading this source could forge a valid cookie for every deployment that
 * forgot to set the env var); failing loud instead makes the misconfiguration
 * visible immediately.
 *
 * IMPORTANT: this is a MOCK gate, not real auth. Credentials are a single public
 * `demo`/`demo` pair, there is no user registry, and the signed cookie carries no
 * per-user identity - it only proves "someone who knows the demo password logged
 * in," so there are no per-user session-ownership checks. Integrate a real
 * authentication provider (your own IdP) before shipping anything like this to
 * production.
 */
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

declare global {
	namespace Cloudflare {
		interface Env {
			/**
			 * HMAC secret used to sign/verify the staff-session cookie. Never committed -
			 * provisioned locally via `.dev.vars` and for deploy via `wrangler secret put`.
			 * Optional in the type because the whole point of the fail-closed
			 * checks below is that it CAN be absent (a misconfigured deployment) and the
			 * gate must handle that, not assume it away.
			 */
			AUTH_COOKIE_SECRET?: string;
		}
	}
}

/** The one hardcoded demo account. Public and well-known by design: this gate
 * exists to demonstrate a staff-only surface, not to keep anyone out. The real
 * cost ceiling on live mints is the per-IP rate limit, not this credential. */
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo";

const STAFF_COOKIE_NAME = "staff_session";
/** The only value the cookie ever carries - its presence with a valid signature
 * IS the session; there is no per-user identity to distinguish. */
const STAFF_SESSION_VALUE = "staff";
/** 8 hours: long enough for one demo sitting, short enough that a stale signed
 * cookie left in a shared browser does not grant access indefinitely. */
const STAFF_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

const COOKIE_FLAGS = {
	httpOnly: true,
	secure: true,
	sameSite: "Lax",
	path: "/",
} as const;

/** Structured, actionable body for the fail-closed 500 both `requireStaff` and
 * `POST /api/auth/login` return when `AUTH_COOKIE_SECRET` is unset. */
const AUTH_NOT_CONFIGURED_BODY = {
	error: "Staff auth is not configured on this deployment (missing AUTH_COOKIE_SECRET).",
	code: "auth_not_configured",
} as const;

export const authRoute = new Hono<{ Bindings: Env }>();

authRoute.post("/api/auth/login", async (c) => {
	const secret = c.env.AUTH_COOKIE_SECRET;
	if (!secret) {
		return c.json(AUTH_NOT_CONFIGURED_BODY, 500);
	}

	let body: { username?: unknown; password?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Expected a JSON body.", code: "invalid_body" }, 400);
	}

	if (body.username !== DEMO_USERNAME || body.password !== DEMO_PASSWORD) {
		return c.json({ error: "Invalid demo credentials.", code: "invalid_credentials" }, 401);
	}

	await setSignedCookie(c, STAFF_COOKIE_NAME, STAFF_SESSION_VALUE, secret, {
		...COOKIE_FLAGS,
		maxAge: STAFF_SESSION_MAX_AGE_SECONDS,
	});
	return c.json({ ok: true });
});

authRoute.post("/api/auth/logout", (c) => {
	deleteCookie(c, STAFF_COOKIE_NAME, COOKIE_FLAGS);
	return c.json({ ok: true });
});

/** Blocks a request unless it carries a validly signed staff-session cookie.
 * Fails closed (structured 500) if the deployment has no HMAC secret configured -
 * there is no way to verify a signature without one, so treating that as "not
 * logged in" (403) would mask a broken deployment as a normal auth prompt. */
export const requireStaff = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const secret = c.env.AUTH_COOKIE_SECRET;
	if (!secret) {
		return c.json(AUTH_NOT_CONFIGURED_BODY, 500);
	}

	const value = await getSignedCookie(c, secret, STAFF_COOKIE_NAME);
	if (value !== STAFF_SESSION_VALUE) {
		return c.json({ error: "Staff login required.", code: "forbidden" }, 403);
	}
	await next();
});

/**
 * Bridges the HttpOnly staff-session cookie to the browser: `useSession()`
 * (`react-app/lib/auth-client.ts`) cannot read the cookie itself (that is the
 * point of `HttpOnly`), so it probes this route instead. Reuses `requireStaff`
 * directly, so "logged in" here means exactly what it means everywhere else.
 */
authRoute.get("/api/auth/session", requireStaff, (c) => c.json({ authenticated: true }));
