/**
 * What this teaches / copy this pattern:
 * The Worker composition root. It wires the three sub-apps (`checktivProxy`,
 * `reservationsRoute`, `geoRoute`) into one Hono app and layers the cross-cutting
 * gates on top - the ONE place trust boundaries are enforced, so no individual
 * route has to re-implement them:
 *
 *   - Body-size cap (64 KiB) on every `/api/*` request that carries a body -
 *     defense-in-depth against an oversized-payload memory-abuse.
 *   - A coarse per-IP rate limit on the ENTIRE `/api/checktiv/*` relay. Live
 *     Checktiv mints cost real money, and this demo has NO authentication of any
 *     kind, so the rate limit is the ONLY cost ceiling on the relay - treat it as
 *     load-bearing, not as belt-and-braces. It is a no-op when the
 *     `CHECKTIV_RATE_LIMITER` binding is absent (local dev / tests bind none), so
 *     the same code path runs everywhere.
 *   - `app.onError` catches any UNCAUGHT exception - every route above returns its
 *     OWN structured error and never throws, so this is the backstop for a bug or a
 *     failure no route mapped - and maps it to the SAME `{ error, code, status }`
 *     envelope those routes use (see `checktiv-proxy.ts`'s `mapErrorBody`), never
 *     Hono's bare `text/plain` "Internal Server Error" default. It never echoes the
 *     raw error message or stack (same no-raw-echo discipline as the proxy's
 *     upstream error mapping). The one case worth naming specifically is D1's "no
 *     such table" SQLITE_ERROR: it is exactly what a fresh clone hits on its first
 *     `POST /api/reservations` before running `pnpm db:migrate:local` (README Quick
 *     Start), so it gets a hint pointing at that command instead of a generic retry.
 *
 * NO AUTHENTICATION - what that means for each surface. This demo previously
 * carried a mock `demo`/`demo` signed-cookie staff gate. It was removed: it was
 * never a real access control (the credentials were public and printed on the
 * sign-in page), and it failed closed with a 500 on any deployment that had no
 * cookie-HMAC secret, which broke every `/api` route on the live demo. Nothing
 * replaced it, so EVERY route below answers an unauthenticated caller:
 *
 *   - `/api/checktiv/*` is an open relay in the sense that anyone may CALL it,
 *     but not in the sense that anyone may USE it: this demo is
 *     bring-your-own-key, so the caller must supply their own `ah_sk_*` secret
 *     key per request (`resolveKey` -> 401 `missing_key` without one) and the
 *     Worker holds none of its own. A caller with no key can spend nobody's
 *     money. The per-IP rate limit above bounds a caller who brings a stolen one.
 *   - `/api/reservations` (collection AND item, reads INCLUDED) is now open.
 *     THE CONSEQUENCE, STATED PLAINLY: in local-dev D1 mode a reservation read
 *     returns guest name + email (PII), and the README tells developers to serve
 *     the dev app through a PUBLIC tunnel hostname (Checktiv keys are
 *     origin-pinned, so `localhost` cannot complete the guest flow). While that
 *     tunnel is up, anyone who knows the hostname can `GET /api/reservations` and
 *     read every stored guest name and email. Use fake guest data only, and put
 *     access control on the tunnel itself if you need more. The DEPLOYED demo is
 *     unaffected: `env.production` binds no D1 (`PERSISTENCE: "local"`, enforced
 *     by `scripts/assert-no-d1-in-deploy-env.mjs`), so every reservations route
 *     answers the structured 501 and the Worker stores no guest data at all.
 *   - `GET /api/checkin/:id` was ALREADY deliberately unauthenticated before this
 *     change (the guest never signs in; holding the check-in link is the
 *     capability) and is unchanged - see `reservations.ts`.
 *   - `GET /api/geo` is unauthenticated and needs no gate of its own: it reads no
 *     storage and returns only what the CALLER'S OWN request already told the
 *     edge (their approximate country). There is nothing to scope it to and
 *     nothing it can disclose about anyone else - see `geo.ts`.
 *
 * A production integration authenticates its staff surface with a real IdP and
 * scopes every read to the caller. Copy the Checktiv wiring from this file, never
 * its access-control posture.
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
import { secureHeaders } from "hono/secure-headers";
import { checktivProxy } from "./checktiv-proxy";
import { geoRoute } from "./geo";
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
			/**
			 * DEV-TEST-ONLY cell-targeting flag (e.g. `"us"`). Declared HERE (not via
			 * `wrangler types`) because it is intentionally UNSET in every environment's
			 * `vars` so the prod relay is byte-unchanged; a developer sets it in the
			 * gitignored `.dev.vars` only while exercising the `collect_user_info`
			 * submit path against a non-production cell. When set, the proxy targets
			 * `CHECKTIV_DEV_CELL_API_BASE` (see `shared/dev-cell.ts`).
			 * `scripts/assert-no-dev-cell-in-deploy.mjs` fails the deploy if either
			 * variable reaches `env.production.vars`. Documented in `.dev.vars.example`.
			 */
			CHECKTIV_DEV_CELL?: string;
			/**
			 * DEV-TEST-ONLY dev-cell public-api origin, REQUIRED when
			 * `CHECKTIV_DEV_CELL` is set. Declared here for the same reason as the flag:
			 * it belongs to the gitignored `.dev.vars`, never to `wrangler.jsonc`, so
			 * this repo never carries a non-production hostname.
			 */
			CHECKTIV_DEV_CELL_API_BASE?: string;
		}
	}
}

/** Max bytes accepted on any `/api/*` request body (defense-in-depth). */
const API_BODY_LIMIT_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

/**
 * Security response headers for `/api/*`, which `public/_headers` CANNOT reach.
 *
 * `_headers` is applied by the STATIC-ASSET layer, and `run_worker_first: ["/api/*"]`
 * (wrangler.jsonc) sends `/api/*` straight to this Worker instead - so every JSON
 * response here shipped with none of them. Verified on the live demo: the root
 * document carries CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy and
 * `/api/geo` carries none of the four.
 *
 * This is the deliberately SMALLER set that a JSON response actually benefits from,
 * not a copy of the document-oriented list. What is enabled and why:
 *
 *   - `X-Content-Type-Options: nosniff` - the one that genuinely matters here. It
 *     stops a browser from sniffing a JSON body as HTML or script, which is the whole
 *     MIME-confusion class.
 *   - A "this is not a document" CSP. `default-src 'none'` plus `frame-ancestors
 *     'none'` and `base-uri 'none'` mean that IF a JSON response is ever rendered as
 *     a document (direct navigation, a content-type mistake), it can load nothing,
 *     frame nothing, and be framed by nothing. The SPA's resource CSP deliberately
 *     does NOT do this - it must let the capture iframe load - which is exactly why
 *     the two surfaces get different policies.
 *   - `Cross-Origin-Resource-Policy: same-origin` - keeps another origin from
 *     embedding or reading these responses. It has no document-CSP equivalent, and it
 *     is the header a JSON API wants most after `nosniff`.
 *   - `X-Frame-Options: DENY` - redundant with `frame-ancestors` on modern browsers,
 *     kept for older ones and to match the static set.
 *   - `Referrer-Policy` - marginal on a response nothing navigates from, but it costs
 *     nothing, it covers someone opening an API URL directly in a tab, and matching
 *     the static set's value keeps the two surfaces from disagreeing for no reason.
 *
 * Everything else the middleware would set by default is OFF, each for a stated
 * reason. Turning a header on that does nothing is not free: it teaches a reader to
 * copy it.
 */
app.use(
	"/api/*",
	secureHeaders({
		xContentTypeOptions: "nosniff",
		contentSecurityPolicy: {
			defaultSrc: ["'none'"],
			frameAncestors: ["'none'"],
			baseUri: ["'none'"],
			formAction: ["'none'"],
		},
		crossOriginResourcePolicy: "same-origin",
		xFrameOptions: "DENY",
		referrerPolicy: "strict-origin-when-cross-origin",
		// The Cloudflare ZONE sets HSTS and wins over anything set here or in
		// `public/_headers` - the live demo serves the zone's value, not this repo's.
		// Setting it here would be inert and would teach a reader that this line is
		// what produces the header they see. Set HSTS in the dashboard.
		strictTransportSecurity: false,
		// Deprecated, and its filter introduced vulnerabilities of its own; current
		// guidance is to not send it at all.
		xXssProtection: false,
		// Document-surface headers with nothing to act on in a JSON response.
		// (`permissionsPolicy` needs no entry: the middleware sets none by default,
		// and a JSON response has no document to grant a feature to.)
		crossOriginOpenerPolicy: false,
		originAgentCluster: false,
		xDnsPrefetchControl: false,
		xDownloadOptions: false,
		xPermittedCrossDomainPolicies: false,
	}),
);

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
// This is the ONLY gate on the Checktiv relay - there is no auth layer here or
// anywhere else (see the "NO AUTHENTICATION" note in the module doc). Do not
// remove or loosen it: it is the whole cost ceiling on live mints.
app.use("/api/checktiv/*", rateLimitChecktiv);

// -- Sub-apps: each defines its FULL absolute `/api/...` paths, so mount at "/" --
app.route("/", checktivProxy());
app.route("/", reservationsRoute());
// Binding-free and storage-free: it reports a property of the caller's own
// request, so unlike `reservationsRoute` it answers identically in every
// deployment shape (see `geo.ts` for why it is not a field on `/api/checkin/:id`).
app.route("/", geoRoute());

/**
 * Fail-loud fallback for any `/api/*` path no sub-app matched: a structured JSON
 * 404, never the SPA `index.html`. Registered AFTER the mounts so real routes
 * win; only genuinely-unknown API paths reach here.
 */
app.all("/api/*", (c) =>
	c.json({ error: "That API route was not found.", code: "not_found", status: 404 }, 404),
);

/**
 * True when an error - or any error in its `.cause` chain - is D1's "no such
 * table" SQLITE_ERROR. Chained because drizzle-orm/d1 wraps the raw D1 driver
 * error in its own `DrizzleQueryError`, so the SQLite message lives one or two
 * `.cause` levels down, not on the top-level error (verified against a live,
 * unmigrated local D1: the thrown `DrizzleQueryError.cause.message` is
 * `"D1_ERROR: no such table: reservations: SQLITE_ERROR"`). Both substrings
 * are required so this stays specific to a missing-table failure rather than
 * matching any SQLite error.
 */
function describesMissingTable(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		if (/no such table/i.test(current.message) && /SQLITE_ERROR/i.test(current.message)) {
			return true;
		}
		current = current.cause;
	}
	return false;
}

/**
 * Global error handler - see the "app.onError" bullet in the module doc above
 * for why this exists and what it guarantees (structured envelope, no raw
 * echo, an actionable hint for the fresh-clone "missing migrations" case).
 */
app.onError((err, c) => {
	if (describesMissingTable(err)) {
		return c.json(
			{
				error:
					'The local database schema has not been applied. Run "pnpm db:migrate:local", then retry.',
				code: "d1_migrations_required",
				status: 500,
			},
			500,
		);
	}
	return c.json(
		{ error: "Something went wrong. Please retry.", code: "internal_error", status: 500 },
		500,
	);
});

export default app;
