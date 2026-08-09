/**
 * What this teaches / copy this pattern:
 * The CLIENT-side reader for the DEV-TEST-ONLY cell override (see
 * `src/shared/dev-cell.ts`). It reads the build-time `VITE_CHECKTIV_DEV_CELL`
 * flag Vite inlines into the bundle and resolves it through the shared, pure
 * resolver, returning the dev-cell origins to pass as the
 * `collectUserInfo({ session: { apiBase } })` and `mountReviewer`'s
 * `workspaceBaseUrl` overrides.
 *
 * The flag is a BUILD-TIME env var, NOT a `DemoConfig` user field - so an
 * attacker cannot redirect the SDK data-plane by editing sessionStorage. It is
 * UNSET by default (see `.env` / `.env.production`), so `devCellSdkApiBase()`
 * and `devCellWorkspaceBaseUrl()` return `undefined` and the SDK falls back to
 * the pk-/region-derived prod origins (prod behavior byte-unchanged).
 * DEV-TEST-ONLY: env-unset before finalizing the public demo.
 */
import { resolveDevCellOrigins } from "../../shared/dev-cell";

/**
 * The dev-cell sdk-api origin to pass as `collectUserInfo`'s `apiBase`, or
 * `undefined` when the dev-cell flag is unset (the SDK then derives the prod
 * sdk-api origin from the publishable key).
 */
export function devCellSdkApiBase(): string | undefined {
	// `import.meta.env.VITE_*` is typed `any` by Vite; narrow to a string flag.
	const flag: unknown = import.meta.env.VITE_CHECKTIV_DEV_CELL;
	return resolveDevCellOrigins(typeof flag === "string" ? flag : undefined)?.sdkApiBase;
}

/**
 * The dev-cell workspace origin to pass as `mountReviewer`'s
 * `workspaceBaseUrl`, or `undefined` when the dev-cell flag is unset (the SDK
 * then derives the prod workspace origin from the region).
 */
export function devCellWorkspaceBaseUrl(): string | undefined {
	// `import.meta.env.VITE_*` is typed `any` by Vite; narrow to a string flag.
	const flag: unknown = import.meta.env.VITE_CHECKTIV_DEV_CELL;
	return resolveDevCellOrigins(typeof flag === "string" ? flag : undefined)?.workspaceBaseUrl;
}
