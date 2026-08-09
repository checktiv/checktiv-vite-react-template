/**
 * What this teaches / copy this pattern:
 * DEV-TEST-ONLY, env-gated targeting of a NON-production Checktiv cell.
 *
 * The published `@checktiv/sdk-web` SDK and this demo are PROD-ONLY by
 * construction: every origin the demo talks to is derived from the key's region
 * and pinned to `*.checktiv.com` (see `origins.ts` / the SSRF note in
 * `checktiv-proxy.ts`). This module is the single, deliberate exception used to
 * validate an UNPUBLISHED SDK capability (CT-377 `collect_user_info` mode b)
 * against the dev-us cell BEFORE the SDK is published.
 *
 * SSRF-safe by construction: the override origins are COMPILE-TIME CONSTANTS in
 * the static `DEV_CELLS` table below and are selected ONLY by a build-time /
 * deploy-time env FLAG (`VITE_CHECKTIV_DEV_CELL` client-side,
 * `CHECKTIV_DEV_CELL` worker-side) - NEVER derived from a request header, body,
 * query, or any `DemoConfig` user field. An unknown / empty flag resolves to
 * `null`, i.e. the demo keeps its normal prod behavior (byte-unchanged). The
 * resolver is a PURE function of the flag string so both the client reader and
 * the worker proxy share one contract and it is unit-testable without env.
 *
 * REMOVE / env-unset before the public demo is finalized: this must never ship
 * enabled. It is OFF by default (no `.env` / `.dev.vars` entry sets it).
 */

/** The set of dev-cell origins a given flag selects. */
export interface DevCellOrigins {
	/**
	 * sdk-api origin the browser SDK data-plane calls. Passed to
	 * `collectUserInfo({ session: { apiBase } })` so the token-exchange + submit
	 * fetches hit the dev cell instead of the pk-derived prod sdk-api.
	 */
	sdkApiBase: string;
	/**
	 * public-api (server REST) origin the mint proxy targets instead of the
	 * key-derived prod `api.<region>.checktiv.com`.
	 */
	apiBase: string;
	/**
	 * Workspace (staff reviewer iframe) origin passed to `mountReviewer`'s
	 * `workspaceBaseUrl`, instead of the region-derived prod
	 * `workspace.<region>.checktiv.com`.
	 */
	workspaceBaseUrl: string;
}

/**
 * Static, compile-time table of dev-cell origins keyed by flag value. The ONLY
 * source of override origins - nothing here is request-derived. Add a cell here
 * (never accept an origin from user input).
 */
const DEV_CELLS: Record<string, DevCellOrigins> = {
	us: {
		sdkApiBase: "https://sdk-api-dev.us.autohost-dev.uk",
		apiBase: "https://api-dev.us.autohost-dev.uk",
		workspaceBaseUrl: "https://workspace-dev.us.autohost-dev.uk",
	},
};

/**
 * Resolve dev-cell origins from a flag string, or `null` for prod behavior.
 * Pure: the flag is the only input. An unknown/empty flag returns `null`, which
 * every caller treats as "use the normal prod origins" - so the default (unset)
 * path is prod-unchanged.
 *
 * @param flag the env flag value (e.g. `"us"`); case/space-insensitive.
 */
export function resolveDevCellOrigins(flag: string | undefined): DevCellOrigins | null {
	if (typeof flag !== "string") {
		return null;
	}
	const normalized = flag.trim().toLowerCase();
	if (normalized.length === 0) {
		return null;
	}
	return DEV_CELLS[normalized] ?? null;
}
