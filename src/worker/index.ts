/**
 * What this teaches / copy this pattern:
 * The Worker composition root. It wires the three sub-apps
 * (`checktivProxy`, `authRoute`, `reservationsRoute`) into one Hono app and
 * layers the cross-cutting gates on top - the ONE place trust boundaries are
 * enforced, so no individual route has to re-implement them:
 *
 *   - Body-size cap (64 KiB) on every `/api/*` request that carries a body -
 *     defense-in-depth against an oversized-payload memory-abuse.
 *   - A coarse per-IP rate limit on the ENTIRE `/api/checktiv/*` relay. Live
 *     Checktiv mints cost real money, and the staff gate below is a MOCK gate
 *     with public credentials (see `auth.ts`), so it provides essentially no
 *     abuse protection on its own. The rate limit is the actual cost ceiling.
 *     It is a no-op when the `CHECKTIV_RATE_LIMITER` binding is absent (local
 *     dev / tests bind none), so the same code path runs everywhere.
 *   - `requireStaff` on the `/api/checktiv/*` mount (every real proxy consumer is
 *     a staff page - the guest check-in page talks to Checktiv directly via its
 *     `client_token`, never this relay), with ONE exemption: the workflow-template
 *     LIST (`GET /api/checktiv/workflow-templates`) is fetched from the PRE-LOGIN
 *     Setup screen, so it is not staff-gated (it still requires a valid secret key
 *     and is rate-limited; templates are non-PII). AND `requireStaff` on the ENTIRE
 *     `/api/reservations` mount, READS INCLUDED. In local-dev D1 mode a
 *     reservation read returns guest name + email (PII), and the dev origin is a
 *     public tunnel hostname, so leaving reads open would expose that PII to any
 *     unauthenticated caller. Every real consumer is an authenticated staff page
 *     (GuardedRoute + cookie) by the time it calls, so gating reads has no
 *     functional downside. This is what stops the relay being an open,
 *     unauthenticated key-forwarding proxy.
 *
 * Unmatched `/api/*` returns a structured JSON 404 - NEVER the SPA
 * `index.html`. Serving the SPA shell for an unknown `/api` path would shadow
 * the fail-loud 404/501 paths the frontend's store-error handling depends on.
 * The SPA fallback (`not_found_handling: "single-page-application"`) applies to
 * NON-`/api` routes only, and is enforced by the static-assets layer, not here:
 * `wrangler.jsonc`'s `run_worker_first: ["/api/*"]` invokes this Worker for
 * `/api/*` requests ONLY; every other path is served straight from the built
 * client bundle, so the SPA and the Worker never contend for a route.
 *
 * No permissive CORS: the browser and this Worker are same-origin, so there is
 * NO `Access-Control-Allow-Origin` header set anywhere. A cross-origin caller is
 * blocked by the browser's default same-origin policy.
 *
 * Dual-mode persistence (`wrangler.jsonc`): local dev binds D1 (`DB`) and sets
 * `PERSISTENCE=d1`; the deployed Worker (`env.production`) binds NO D1 and sets
 * `PERSISTENCE=local`, so reservations live in the staff browser's
 * `localStorage` and the deployed Worker persists NOTHING server-side. The
 * `reservationsRoute()` is ALWAYS mounted and branches internally on `env.DB`
 * (structured 501 when absent), so the stateless deployed shape is a live,
 * tested code path rather than an omitted mount.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { checktivProxy } from "./checktiv-proxy";
import { authRoute, requireStaff } from "./auth";
import { reservationsRoute } from "./reservations";

declare global {
	namespace Cloudflare {
		interface Env {
			/**
			 * `"true"` opts the demo into granting the test-mode-only `session:decide`
			 * reviewer capability; absent (the safe default) grants the READ subset
			 * only. Declared HERE rather than by `wrangler types` because it is
			 * intentionally UNSET in every environment's `vars` (so the generator does
			 * not emit it) - it is an opt-in a deployer sets via `.dev.vars` (local) or
			 * `env.production.vars` only when demoing the decision flow. `PUBLIC_ORIGIN`,
			 * `CHECKTIV_RATE_LIMITER`, `DB`, and `PERSISTENCE` ARE emitted by
			 * `wrangler types` (they appear in `wrangler.jsonc`), so they live in the
			 * generated `worker-configuration.d.ts`, not here.
			 */
			DEMO_ALLOW_DECIDE?: string;
		}
	}
}

/** Max bytes accepted on any `/api/*` request body (defense-in-depth). */
const API_BODY_LIMIT_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

/**
 * Cap the request-body size on every `/api/*` route. GET/HEAD carry no body so
 * this is a no-op for them; POST/PATCH are bounded before their handler reads
 * `c.req.json()`. Returns a structured, actionable 413 rather than letting an
 * oversized body through.
 */
app.use(
	"/api/*",
	bodyLimit({
		maxSize: API_BODY_LIMIT_BYTES,
		onError: (c) =>
			c.json(
				{
					error: "That request body is too large. Trim it and retry.",
					code: "payload_too_large",
					status: 413,
				},
				413,
			),
	}),
);

/**
 * Coarse per-IP rate limit on the whole Checktiv relay. Keyed on the visitor's
 * real edge IP (`CF-Connecting-IP`). A no-op when `CHECKTIV_RATE_LIMITER` is
 * unbound (local dev / tests), so the relay behaves identically everywhere
 * except that the deployed Worker enforces the ceiling.
 */
const rateLimitChecktiv = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const limiter = c.env.CHECKTIV_RATE_LIMITER;
	if (limiter) {
		const key = c.req.header("CF-Connecting-IP") ?? "unknown";
		const { success } = await limiter.limit({ key });
		if (!success) {
			return c.json(
				{
					error: "Too many verification requests. Please wait a moment and retry.",
					code: "rate_limited",
					status: 429,
				},
				429,
			);
		}
	}
	await next();
});

// -- Cross-cutting gates (registered BEFORE the sub-app mounts so they wrap) --
// requireStaff covers the ENTIRE mount for both surfaces (collection + item
// paths), reads included - it fails closed with a structured 500 when
// AUTH_COOKIE_SECRET is absent (see auth.ts), which is why it is layered here
// rather than re-implemented per route.
app.use("/api/checktiv/*", rateLimitChecktiv);
// `requireStaff` gates the whole Checktiv relay EXCEPT the workflow-template LIST:
// it is fetched from the PRE-LOGIN Setup screen (the visitor picks a template while
// entering their keys, before the staff login), so gating it on the staff cookie would
// make the Setup dropdown always 403. It is still not an open proxy - it requires a
// valid secret key (`resolveKey` -> 401 without one) and is rate-limited above - and
// workflow templates are non-PII org config, so exempting only this GET is safe. Every
// other `/api/checktiv/*` route (session mint, workspace token, status) stays gated.
app.use("/api/checktiv/*", async (c, next) => {
	if (c.req.method === "GET" && c.req.path === "/api/checktiv/workflow-templates") {
		return next();
	}
	return requireStaff(c, next);
});
app.use("/api/reservations", requireStaff);
app.use("/api/reservations/*", requireStaff);

// -- Sub-apps: each defines its FULL absolute `/api/...` paths, so mount at "/" --
app.route("/", checktivProxy());
app.route("/", authRoute);
app.route("/", reservationsRoute());

/**
 * Fail-loud fallback for any `/api/*` path no sub-app matched: a structured JSON
 * 404, never the SPA `index.html`. Registered AFTER the mounts so real routes
 * win; only genuinely-unknown API paths reach here.
 */
app.all("/api/*", (c) =>
	c.json({ error: "That API route was not found.", code: "not_found", status: 404 }, 404),
);

export default app;
