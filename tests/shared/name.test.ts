/**
 * What this teaches / copy this pattern:
 * The pure `splitLegalName` helper the collect form uses for progressive-disclosure
 * name parsing. Table-driven over the token-count boundaries (0/1/2/3+) plus
 * whitespace normalization, so the split contract the UI depends on is pinned
 * without a DOM.
 */
import { describe, it, expect } from "vitest";
import { splitLegalName } from "../../src/shared/name";

describe("splitLegalName", () => {
	it("returns all-empty parts for an empty or whitespace-only name", () => {
		expect(splitLegalName("")).toEqual({ first: "", middle: "", last: "" });
		expect(splitLegalName("   ")).toEqual({ first: "", middle: "", last: "" });
	});

	it("maps a single token to first only", () => {
		expect(splitLegalName("Cher")).toEqual({ first: "Cher", middle: "", last: "" });
	});

	it("maps two tokens to first + last with no middle", () => {
		expect(splitLegalName("Ada Lovelace")).toEqual({
			first: "Ada",
			middle: "",
			last: "Lovelace",
		});
	});

	it("maps three tokens to first / middle / last", () => {
		expect(splitLegalName("Grace Brewster Hopper")).toEqual({
			first: "Grace",
			middle: "Brewster",
			last: "Hopper",
		});
	});

	it("joins the interior tokens into the middle for four or more tokens", () => {
		expect(splitLegalName("Ada King Byron Lovelace")).toEqual({
			first: "Ada",
			middle: "King Byron",
			last: "Lovelace",
		});
	});

	it("collapses surrounding and interior whitespace", () => {
		expect(splitLegalName("  Grace   Brewster   Hopper  ")).toEqual({
			first: "Grace",
			middle: "Brewster",
			last: "Hopper",
		});
	});
});
