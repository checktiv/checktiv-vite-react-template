/**
 * What this teaches / copy this pattern:
 * Every Checktiv origin the demo talks to is derived from the key's region and
 * pinned to a STATIC table - never read from a request header, body, or query.
 * That is the SSRF defense: because `region` is a closed `us | eu` enum and the
 * hosts are compile-time constants, the resolved base can only ever be one of a
 * fixed set of `*.checktiv.com` hosts, so no attacker-controlled input can redirect
 * an upstream call.
 *
 * Overrides exist ONLY for custom-domain orgs and are still static (edited here in
 * source, never request-derived):
 *   - `workspaceBaseUrl` - the customer-facing reviewer iframe host; the one a
 *     custom-domain org normally re-points.
 *   - `sdkApiBase` - the applicant SDK/mount host; overridable only if the org
 *     fronts the SDK on its own domain (verify per-org; otherwise leave derived).
 *   - `apiBase` (server REST base) is ALWAYS region-derived and is intentionally
 *     NOT overridable - it must stay a canonical `api.<region>.checktiv.com` host.
 *
 * Hosts come from settings.yaml (public-api -> `api`, sdk-api -> `sdk-api`,
 * workspace -> `workspace`) on the `checktiv.com` production domain.
 */
export type Region = "us" | "eu";

export interface Origins {
	/** Server-side public REST base. Region-derived, never overridable. */
	apiBase: string;
	/** Applicant SDK / `mount` host (sdk-api). */
	sdkApiBase: string;
	/** Reviewer workspace iframe host (customer-facing). */
	workspaceBaseUrl: string;
}

/** Static, custom-domain overrides. `apiBase` is deliberately excluded. */
export interface OriginOverrides {
	sdkApiBase?: string;
	workspaceBaseUrl?: string;
}

const REGION_ORIGINS: Record<Region, Origins> = {
	us: {
		apiBase: "https://api.us.checktiv.com",
		sdkApiBase: "https://sdk-api.us.checktiv.com",
		workspaceBaseUrl: "https://workspace.us.checktiv.com",
	},
	eu: {
		apiBase: "https://api.eu.checktiv.com",
		sdkApiBase: "https://sdk-api.eu.checktiv.com",
		workspaceBaseUrl: "https://workspace.eu.checktiv.com",
	},
};

/**
 * Resolve the Checktiv origins for a region, applying static custom-domain
 * overrides for the customer-facing hosts only. `apiBase` stays region-derived.
 */
export function resolveOrigins(
	region: Region,
	overrides?: OriginOverrides,
): Origins {
	const base = REGION_ORIGINS[region];
	return {
		apiBase: base.apiBase,
		sdkApiBase: overrides?.sdkApiBase ?? base.sdkApiBase,
		workspaceBaseUrl: overrides?.workspaceBaseUrl ?? base.workspaceBaseUrl,
	};
}
