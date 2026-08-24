/**
 * What this teaches / copy this pattern:
 * DEV-TEST-ONLY, env-gated targeting of a NON-production Checktiv cell, and the
 * rule that makes such an override safe.
 *
 * The published `@checktiv/sdk-web` SDK and this demo are PROD-ONLY by
 * construction: every origin the demo talks to is derived from the key's region
 * and pinned to `*.checktiv.com` (see `origins.ts` / the SSRF note in
 * `checktiv-proxy.ts`). This module is the single, deliberate exception used to
 * point the demo at a NON-production Checktiv cell for local testing of the
 * `collect_user_info` submit path.
 *
 * THE SAFETY RULE, stated precisely: an override origin is NEVER derived from a
 * request header, body, query, or any `DemoConfig` user field. It comes ONLY from
 * build-time / deploy-time environment (`VITE_CHECKTIV_DEV_CELL*` client-side,
 * `CHECKTIV_DEV_CELL*` worker-side), which no HTTP request can reach. That
 * non-request-derivation is the whole property - it is what keeps the relay free
 * of an SSRF surface, and it holds for an env value exactly as it held for the
 * hardcoded table this module used to carry.
 *
 * Env is a wider input than a closed table, so the loss of the closed table is
 * paid back with validation instead: `parseDevCellOrigin` accepts ONLY a bare
 * `https:` origin, and rejects userinfo (`https://evil.example@internal/`), IPv4 /
 * IPv6 literals (the `169.254.169.254` cloud-metadata shape), `localhost`, and any
 * path / query / fragment. What that defends against is a DEPLOYER typo, not an
 * attacker: only whoever deploys the Worker can write env, and they could always
 * have edited a source constant instead.
 *
 * Why env rather than constants in this file: the origins are a private
 * non-production estate, and this repo is public. A tracked file cannot hold them
 * without publishing them - in the source, in the built bundle, and permanently in
 * git history. `.env.local` / `.dev.vars` are gitignored, so git structurally
 * cannot publish what is written there.
 *
 * OFF unless configured. With no dev-cell env set, every resolver here returns
 * `null` and the demo keeps its normal production behavior, byte-unchanged. The
 * deployed demo is additionally pinned off in `.env.production`, which Vite ranks
 * ABOVE a generic `.env.local`, and `scripts/assert-no-dev-cell-in-deploy.mjs`
 * fails the deploy if any dev-cell targeting survives into the build anyway.
 */

/**
 * Raised when the dev-cell flag is ON but its paired origin variable is missing or
 * is not a bare `https:` origin. Deliberately FAILS LOUD rather than falling back
 * to production: a silent fallback would run prod traffic while the developer
 * believed they were testing a non-production cell.
 */
export class DevCellConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DevCellConfigError";
	}
}

/** Matches a bare IPv4 literal, which is never a valid dev-cell hostname here. */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Validate one dev-cell origin string and return it NORMALIZED (via `URL.origin`,
 * so the host is lowercased and any trailing slash is dropped - callers append
 * their own path).
 *
 * Accepts only a bare `https:` origin. Every rejection below is a shape that has
 * been used to turn a "trusted" configurable base URL into a request-forgery
 * primitive, so each is refused explicitly rather than left to chance.
 *
 * @param raw the env value (untrimmed); `undefined` / blank is a configuration error
 * @param varName the environment variable name, quoted verbatim in the error so the
 *   developer is told exactly which variable to fix
 * @throws {DevCellConfigError} if `raw` is absent or is not a bare `https:` origin
 */
export function parseDevCellOrigin(raw: string | undefined, varName: string): string {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value.length === 0) {
		throw new DevCellConfigError(
			`Dev-cell targeting is enabled but ${varName} is not set. Set ${varName} to your ` +
				`non-production cell origin in the gitignored .env.local (client) or .dev.vars ` +
				`(worker) - see .dev.vars.example for the format - or clear the dev-cell flag to ` +
				`run against production.`,
		);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DevCellConfigError(
			`${varName} is not a valid URL. Set it to a bare https origin - scheme, host, ` +
				`optional port, nothing else. See .dev.vars.example.`,
		);
	}

	const reject = (reason: string): never => {
		throw new DevCellConfigError(
			`${varName} must be a bare https origin - scheme, host, optional port, nothing ` +
				`else: ${reason}. See .dev.vars.example.`,
		);
	};

	if (url.protocol !== "https:") reject(`the scheme is "${url.protocol}", not "https:"`);
	if (url.username !== "" || url.password !== "") reject("it carries userinfo credentials");
	// `URL.hostname` brackets an IPv6 literal, so the bracket test is sufficient for v6.
	if (IPV4_LITERAL.test(url.hostname)) reject("the host is a bare IPv4 literal");
	if (url.hostname.startsWith("[")) reject("the host is a bare IPv6 literal");
	if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
		reject("the host is localhost");
	}
	if (url.pathname !== "/") reject(`it carries a path ("${url.pathname}")`);
	if (url.search !== "") reject("it carries a query string");
	if (url.hash !== "") reject("it carries a fragment");

	return url.origin;
}

/**
 * Resolve ONE dev-cell origin from its env pair, or `null` for normal production
 * behavior.
 *
 * Each call site asks only for the origin it actually uses (the worker needs the
 * public-api base; the client needs the sdk-api and workspace bases), so enabling
 * the flag on one surface never forces a developer to configure the other's
 * variables.
 *
 * Two rules, and no third state:
 *   - flag blank / absent -> `null`. `rawOrigin` is ignored entirely. This is the
 *     shipped default and the deployed demo's pinned state.
 *   - flag set -> `rawOrigin` MUST parse as a bare https origin, else throw.
 *
 * @param flag the on/off flag value (e.g. `"us"`); case- and space-insensitive
 * @param rawOrigin the paired origin variable's value
 * @param originVarName the paired variable's name, quoted verbatim in any error
 */
export function resolveDevCellOrigin(
	flag: string | undefined,
	rawOrigin: string | undefined,
	originVarName: string,
): string | null {
	if (typeof flag !== "string" || flag.trim().length === 0) {
		return null;
	}
	return parseDevCellOrigin(rawOrigin, originVarName);
}
