/**
 * What this teaches / copy this pattern:
 * The CLIENT-side reader for the DEV-TEST-ONLY cell override (see
 * `src/shared/dev-cell.ts` for the safety rule these values obey). It reads the
 * build-time `VITE_CHECKTIV_DEV_CELL*` variables Vite inlines into the bundle and
 * resolves each through the shared, pure resolver, returning the origins to pass
 * as `collectUserInfo({ session: { apiBase } })` and `mountReviewer`'s
 * `workspaceBaseUrl`.
 *
 * These are BUILD-TIME env vars, NOT `DemoConfig` user fields - so an attacker
 * cannot redirect the SDK data-plane by editing sessionStorage. They are unset by
 * default, so both readers return `undefined` and the SDK falls back to the
 * pk-/region-derived production origins (production behavior byte-unchanged).
 *
 * To point a local run at your own non-production cell, set all three in the
 * GITIGNORED `.env.local` (never in the tracked `.env`, which would publish your
 * internal hostnames):
 *
 *   VITE_CHECKTIV_DEV_CELL=us
 *   VITE_CHECKTIV_DEV_CELL_SDK_API_BASE=https://sdk-api.dev.example.com
 *   VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL=https://workspace.dev.example.com
 *
 * Setting the flag without its paired origin THROWS rather than silently running
 * production, and the error names the missing variable.
 */
import { resolveDevCellOrigin } from "../../shared/dev-cell";

/** `import.meta.env.VITE_*` is typed `any` by Vite; narrow to a string or undefined. */
function envString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * The dev-cell sdk-api origin to pass as `collectUserInfo`'s `apiBase`, or
 * `undefined` when the dev-cell flag is unset (the SDK then derives the
 * production sdk-api origin from the publishable key).
 *
 * @throws {import("../../shared/dev-cell").DevCellConfigError} if the flag is set
 *   but `VITE_CHECKTIV_DEV_CELL_SDK_API_BASE` is missing or is not a bare https origin
 */
export function devCellSdkApiBase(): string | undefined {
	return (
		resolveDevCellOrigin(
			envString(import.meta.env.VITE_CHECKTIV_DEV_CELL),
			envString(import.meta.env.VITE_CHECKTIV_DEV_CELL_SDK_API_BASE),
			"VITE_CHECKTIV_DEV_CELL_SDK_API_BASE",
		) ?? undefined
	);
}

/**
 * The dev-cell workspace origin to pass as `mountReviewer`'s `workspaceBaseUrl`,
 * or `undefined` when the dev-cell flag is unset (the SDK then derives the
 * production workspace origin from the region).
 *
 * @throws {import("../../shared/dev-cell").DevCellConfigError} if the flag is set
 *   but `VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL` is missing or is not a bare
 *   https origin
 */
export function devCellWorkspaceBaseUrl(): string | undefined {
	return (
		resolveDevCellOrigin(
			envString(import.meta.env.VITE_CHECKTIV_DEV_CELL),
			envString(import.meta.env.VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL),
			"VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL",
		) ?? undefined
	);
}
