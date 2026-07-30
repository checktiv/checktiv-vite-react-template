/**
 * What this teaches / copy this pattern:
 * <StatusChip> is a pure, prop-driven component, so it is tested by rendering
 * it to a static HTML string with `react-dom/server` (`renderToStaticMarkup`)
 * and asserting on the markup - no DOM/jsdom dependency required. That keeps
 * this suite in the plain `node` Vitest project (see vitest.config.ts)
 * instead of needing a browser-like test environment this repo does not
 * install (no jsdom/happy-dom/@testing-library/react in package.json).
 *
 * The `satisfies Record<Reservation["status"], …>` map inside the component
 * itself is the real compile-time guard (a new reservation status becomes a
 * `tsc -b` error, since the map would no longer satisfy the Record over every
 * union member). This suite is the runtime backstop proving each of the 4
 * known statuses renders its intended label.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusChip } from "../../src/react-app/components/StatusChip";
import type { Reservation } from "../../src/shared/reservation-types";

const EXPECTED_LABELS: Record<Reservation["status"], string> = {
	draft: "Draft",
	invited: "Invited",
	verifying: "Verifying",
	complete: "Complete",
};

describe("StatusChip (Reservation['status'] -> label)", () => {
	for (const [status, label] of Object.entries(EXPECTED_LABELS) as Array<[Reservation["status"], string]>) {
		it(`renders "${label}" for status="${status}"`, () => {
			const html = renderToStaticMarkup(<StatusChip status={status} />);
			expect(html).toContain(label);
		});
	}
});
