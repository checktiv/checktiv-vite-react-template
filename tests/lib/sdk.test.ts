/**
 * What this teaches / copy this pattern:
 * This is a CONTRACT test between the demo (consumer) and `@checktiv/sdk-web`
 * (producer) for the staff REVIEWER surface. It does two things at once:
 *   1. A COMPILE-TIME guard - the builder's output is assigned to the SDK's own
 *      published option type (`WorkspaceConfig`). If the SDK ever changes the shape
 *      it demands, `tsc -b` (via tsconfig.test.json, which IS in the root
 *      `references`) turns red here - not at runtime in front of a reviewer.
 *   2. A RUNTIME check - the required fields the SDK needs (`region`/`getToken` plus
 *      the pinned `theme.colorMode`) are actually present on the object.
 *
 * Non-vacuous by construction: the guard imports the REAL published type. The guard
 * local is then referenced in `expect(...)`, so it is a genuine use (satisfying
 * `noUnusedLocals`) while the type annotation still does the work.
 *
 * The applicant GUEST journey is covered separately in
 * `tests/routes/CheckInPage.test.tsx` (it mounts declaratively via the SDK React
 * provider `<ChecktivJourney>`, so there is no option-builder to guard here).
 *
 * NOTE on imports: `WorkspaceConfig` is published ONLY from the `./workspace`
 * subpath (see node_modules/@checktiv/sdk-web/dist/workspace.d.ts), not the main
 * entry - so it is imported from `@checktiv/sdk-web/workspace`.
 */
import { it, expect } from "vitest";
// Type-level guard: our option builder must satisfy the SDK's own type.
import type { WorkspaceConfig } from "@checktiv/sdk-web/workspace";
import { buildReviewerConfig } from "../../src/react-app/lib/sdk";

it("buildReviewerConfig is assignable to the SDK WorkspaceConfig (compile + runtime)", () => {
	const cfg = buildReviewerConfig({
		region: "us",
		workspaceBaseUrl: "https://workspace.us.checktiv.com",
		getToken: async () => ({ framingToken: "f", dataToken: "d" }),
	});
	// Compile guard: fails `tsc -b` if the SDK WorkspaceConfig contract drifts.
	const reviewerGuard: WorkspaceConfig = cfg;
	expect(cfg.region).toBe("us");
	expect(typeof cfg.getToken).toBe("function");
	// Custom-domain override threads through untouched.
	expect(cfg.workspaceBaseUrl).toBe("https://workspace.us.checktiv.com");
	// The reviewer is pinned to light to match the demo (cross-origin iframe
	// cannot read the host `data-theme`, so the mode must be passed explicitly).
	expect(cfg.theme?.colorMode).toBe("light");
	expect(reviewerGuard).toBe(cfg);
});
