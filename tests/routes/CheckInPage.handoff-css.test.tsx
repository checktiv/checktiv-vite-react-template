// @vitest-environment node
/**
 * What this teaches / copy this pattern:
 * A CASCADE test for the one host-owned CSS rule the cross-device handoff depends on
 * (`src/react-app/routes/CheckInPage.css`). It loads the SDK's REAL shipped stylesheet
 * and the page's REAL stylesheet, in the import order `CheckInPage.tsx` uses, into a DOM
 * shaped like the one the SDK builds, and reads the computed `display` of the capture
 * surface with and without the host's `data-checkin-handoff="open"` wrapper.
 *
 * Why this exists, and why the page's own suite does not cover it: `CheckInPage.test.tsx`
 * doubles out `<ChecktivJourney>`, so the real capture DOM never exists there and every
 * cross-device case can only assert the page's `data-checkin-handoff` state flag. Delete
 * `CheckInPage.css` outright and that whole suite stays green while the applicant sees a
 * camera frame stacked under the QR panel. This is the classic producer/consumer wiring
 * hole: `.idv-capture-root` is an UNTYPED STRING CONTRACT with a third-party package, and
 * nothing else in this repo binds the two halves together.
 *
 * It runs in a plain `node` environment and drives happy-dom's `Window` directly (rather
 * than the ambient test DOM) because it needs a FRESH document per state: happy-dom
 * memoizes computed style per element and does not invalidate it when an ancestor
 * attribute changes later, so probing both states in one document reads a stale value and
 * looks like a false negative.
 *
 * It deliberately reads the SOURCE stylesheets, not a build artifact, so it needs no
 * `pnpm build` and fails on `pnpm install` the day the SDK renames the class.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";

/** The stylesheet the SDK ships for the Tier-2 capture frame (`@checktiv/sdk-web/capture-ui/style.css`). */
const SDK_CAPTURE_CSS = readFileSync(
	fileURLToPath(
		new URL("../../node_modules/@checktiv/sdk-web/dist/capture-ui.css", import.meta.url),
	),
	"utf8",
);

/** The ONE host-owned rule, co-located with the page that owns the journey. */
const HOST_CSS = readFileSync(
	fileURLToPath(new URL("../../src/react-app/routes/CheckInPage.css", import.meta.url)),
	"utf8",
);

/** Drop CSS comment blocks, so a class named only in a rationale comment cannot satisfy a check. */
function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Resolve the cascade for one state and return the capture surface's computed `display`
 * plus the SDK panel's, in a FRESH window (see the module doc on happy-dom's memoization).
 *
 * The markup mirrors what the SDK actually builds: the page wraps `<ChecktivJourney>` in
 * the `data-checkin-handoff` div, the idv module renders `.idv-capture-root` inside the
 * journey's element, and the cross-device overlay is appended as a SIBLING inside that
 * same element (`target.appendChild(childContainer)`), which is why the rule has to reach
 * the capture surface without touching the panel.
 */
function resolveCascade(handoffOpen: boolean): { capture: string; panel: string } {
	const win = new Window();
	const doc = win.document;
	const style = doc.createElement("style");
	// Import order matters and is asserted implicitly here: the host sheet is imported
	// AFTER the SDK's in `CheckInPage.tsx`. Specificity is what actually decides the
	// winner (both rules are unlayered), but concatenating in the real order means a
	// regression that relies on order alone cannot hide.
	style.textContent = `${SDK_CAPTURE_CSS}\n${HOST_CSS}`;
	doc.head.appendChild(style);
	doc.body.innerHTML = `
		<div${handoffOpen ? ' data-checkin-handoff="open"' : ""}>
			<div class="checktiv-journey">
				<div class="idv-capture-root"><iframe class="idv-capture-frame"></iframe></div>
				<div><div class="ctv-xdev">QR panel</div></div>
			</div>
		</div>`;
	const displayOf = (selector: string): string => {
		const el = doc.querySelector(selector);
		if (el === null) throw new Error(`fixture is missing ${selector}`);
		return win.getComputedStyle(el).display;
	};
	return { capture: displayOf(".idv-capture-root"), panel: displayOf(".ctv-xdev") };
}

describe("cross-device handoff: the capture surface is hidden by CSS, not by state alone", () => {
	it("binds both halves of the `.idv-capture-root` contract (the SDK's and the host's)", () => {
		// Either side renaming or dropping the class silently breaks the handoff, and this
		// is the assertion that names WHICH side moved when the cascade test below fails.
		// Comments are stripped first: `CheckInPage.css` is mostly a rationale block that
		// names the class in prose, so a raw substring check would keep passing after the
		// real rule was deleted.
		expect(stripCssComments(SDK_CAPTURE_CSS)).toContain(".idv-capture-root");
		expect(stripCssComments(HOST_CSS)).toContain(".idv-capture-root");
	});

	it("hides the SDK capture surface while the handoff owns the screen", () => {
		// The real behavior, resolved through the real cascade: with the host's wrapper
		// flagged open the capture surface must be `display: none`, or the applicant sees a
		// camera frame and a "scan this with your phone" panel at the same time.
		expect(resolveCascade(true).capture).toBe("none");
	});

	it("leaves the capture surface visible when the handoff is not open", () => {
		// The other half of the same rule: the SDK's own `display: contents` must win when
		// the wrapper is absent, so backing out of the handoff restores a working capture.
		expect(resolveCascade(false).capture).toBe("contents");
	});

	it("never touches the SDK's cross-device panel in either state", () => {
		// The panel is a SIBLING of the capture surface inside the journey's DOM. A rule that
		// hid the journey wholesale would take the QR (and the completion poll's UI) with it.
		expect(resolveCascade(true).panel).not.toBe("none");
		expect(resolveCascade(false).panel).not.toBe("none");
	});
});
