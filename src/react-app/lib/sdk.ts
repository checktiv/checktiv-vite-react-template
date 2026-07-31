/**
 * What this teaches / copy this pattern:
 * A thin, typed wrapper around `@checktiv/sdk-web`'s staff REVIEWER surface:
 *   - `workspace(...).mount('reviewer', ...)` -> the staff reviewer iframe.
 *
 * The applicant GUEST journey is NOT wrapped here: it mounts declaratively via the
 * SDK's React provider `<ChecktivJourney>` (`@checktiv/sdk-web/react`) directly in
 * `src/react-app/routes/CheckInPage.tsx`, so there is no imperative guest-mount
 * helper to keep. The reviewer path stays imperative because it renders an iframe
 * relay (not a React tree) and needs the `WorkspaceConfig` framing/data-token seam.
 *
 * `buildReviewerConfig` returns the CONCRETE inferred type via `satisfies
 * WorkspaceConfig` (not a return annotation) so callers keep
 * `.region`/`.workspaceBaseUrl` access while the `satisfies` clause still fails
 * `tsc -b` if the SDK contract drifts; the same guard is re-asserted in
 * `tests/lib/sdk.test.ts`.
 *
 * apiBase discipline (SSRF / correct-host): the reviewer's host override is
 * `workspaceBaseUrl` (`config.ctx.workspaceBaseUrl`), NEVER the public-api REST base
 * (`config.ctx.apiBase`) nor the sdk-api origin. Do not cross them.
 */
import type { SdkRegion } from "@checktiv/sdk-web";
import {
	workspace,
	type WorkspaceConfig,
	type WorkspaceGetToken,
	type ChecktivWorkspaceEvent,
	type ReviewerHandle,
} from "@checktiv/sdk-web/workspace";

/** Inputs the demo threads into the reviewer `workspace(...)` client. */
export interface ReviewerConfigInput {
	readonly region: SdkRegion;
	/** Custom-domain reviewer host override (`config.ctx.workspaceBaseUrl`). */
	readonly workspaceBaseUrl?: string;
	/** Supplies the framing + data tokens the reviewer iframe needs. */
	readonly getToken: WorkspaceGetToken;
}

/**
 * Build the reviewer `WorkspaceConfig`. Returns the concrete inferred type (via
 * `satisfies WorkspaceConfig`) so callers keep `.region`/`.workspaceBaseUrl` access;
 * the `satisfies` clause fails compilation if the SDK's reviewer config drifts.
 * The reviewer's `theme.colorMode` is pinned to `light` (a cross-origin iframe
 * cannot read the host `data-theme` - see the inline note below).
 */
export function buildReviewerConfig(input: ReviewerConfigInput) {
	return {
		region: input.region,
		workspaceBaseUrl: input.workspaceBaseUrl,
		getToken: input.getToken,
		// Pin the reviewer to LIGHT to match this demo's theme. Unlike the guest
		// journey (whose managed capture reads the host's `data-theme` because it
		// renders in-page), the reviewer is a cross-origin iframe and CANNOT read
		// the host document, so the color mode MUST be passed explicitly here or it
		// falls back to the reviewer's own default (dark). This demo is fixed-light
		// (`<html data-theme="light">`); a themed host would forward its live mode.
		theme: { colorMode: "light" },
	} satisfies WorkspaceConfig;
}

/** Everything `mountReviewer` needs: the workspace config plus the mount target. */
export interface MountReviewerInput extends ReviewerConfigInput {
	readonly sessionId: string;
	/** Navigation/error events from the reviewer iframe relay. */
	readonly onEvent?: (event: ChecktivWorkspaceEvent) => void;
}

/**
 * Mount the staff reviewer iframe for `sessionId` into `target`.
 *
 * @returns the SDK's `ReviewerHandle` (call `.destroy()` to unmount).
 */
export function mountReviewer(
	target: HTMLElement,
	input: MountReviewerInput,
): ReviewerHandle {
	const client = workspace(
		buildReviewerConfig({
			region: input.region,
			workspaceBaseUrl: input.workspaceBaseUrl,
			getToken: input.getToken,
		}),
	);
	return client.mount("reviewer", {
		sessionId: input.sessionId,
		target,
		onEvent: input.onEvent,
	});
}
