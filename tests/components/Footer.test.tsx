/**
 * What this teaches / copy this pattern:
 * <Footer> is a pure, prop-less component, so it is tested by rendering to a
 * static HTML string with `react-dom/server` (`renderToStaticMarkup`) - no DOM
 * needed, keeping this suite in the plain `node` Vitest project. It asserts the
 * demo label plus all three outbound links, and that each link opens in a new tab
 * with `rel="noopener noreferrer"` (so the opened page cannot reach back via
 * `window.opener`).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Footer } from "../../src/react-app/components/Footer";

describe("Footer", () => {
	const html = renderToStaticMarkup(<Footer />);

	it("labels the app as a Checktiv demo", () => {
		expect(html).toContain("Demo app.");
		expect(html).toMatch(/Checktiv identity-verification integration/i);
	});

	it("links to Checktiv, the docs, and the GitHub repo, each opening a new opener-isolated tab", () => {
		expect(html).toContain('href="https://checktiv.com"');
		expect(html).toContain('href="https://docs.checktiv.com"');
		expect(html).toContain('href="https://github.com/checktiv/checktiv-vite-react-template"');
		// Every link opens in a new tab with opener isolation.
		const relCount = (html.match(/rel="noopener noreferrer"/g) ?? []).length;
		const blankCount = (html.match(/target="_blank"/g) ?? []).length;
		expect(relCount).toBe(3);
		expect(blankCount).toBe(3);
	});
});
