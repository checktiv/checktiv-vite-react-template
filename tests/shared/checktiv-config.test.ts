import { describe, it, expect } from "vitest";
import {
	assertPublishableKeyMatchesContext,
	deriveKeyContext,
	InvalidKeyError,
	InvalidPublishableKeyError,
	isTemplateDemoSupported,
	isValidPublishableKey,
	parsePublishableKey,
} from "../../src/shared/checktiv-config";

describe("deriveKeyContext (key-prefix -> origins contract)", () => {
	it("maps us/test key to us origins", () => {
		const c = deriveKeyContext("ah_sk_us_test_abc123");
		expect(c).toMatchObject({
			region: "us",
			mode: "test",
			apiBase: "https://api.us.checktiv.com",
			sdkApiBase: "https://sdk-api.us.checktiv.com",
			workspaceBaseUrl: "https://workspace.us.checktiv.com",
		});
	});
	it("maps eu/live key to eu origins and mode=live", () => {
		const c = deriveKeyContext("ah_sk_eu_live_x");
		expect(c.apiBase).toBe("https://api.eu.checktiv.com");
		expect(c.mode).toBe("live");
	});
	it("accepts live keys (real demo keys are live) and derives mode", () => {
		expect(deriveKeyContext("ah_sk_us_live_x").mode).toBe("live");
		expect(deriveKeyContext("ah_sk_us_test_x").mode).toBe("test");
	});
	it("rejects non-secret / malformed keys", () => {
		expect(() => deriveKeyContext("ah_pk_us_live_x")).toThrow(InvalidKeyError);
		expect(() => deriveKeyContext("nope")).toThrow(InvalidKeyError);
	});
});

describe("parsePublishableKey (pk-prefix -> region/mode)", () => {
	it("parses region + mode from a well-formed pk", () => {
		expect(parsePublishableKey("ah_pk_us_test_abc")).toEqual({ region: "us", mode: "test" });
		expect(parsePublishableKey("ah_pk_eu_live_xyz")).toEqual({ region: "eu", mode: "live" });
	});
	it("rejects a secret key or any malformed prefix", () => {
		expect(() => parsePublishableKey("ah_sk_us_test_abc")).toThrow(InvalidPublishableKeyError);
		expect(() => parsePublishableKey("nope")).toThrow(InvalidPublishableKeyError);
	});
});

describe("isValidPublishableKey", () => {
	it("accepts a well-formed pk and rejects everything else", () => {
		expect(isValidPublishableKey("ah_pk_us_test_abc")).toBe(true);
		expect(isValidPublishableKey("ah_sk_us_test_abc")).toBe(false);
		expect(isValidPublishableKey("")).toBe(false);
	});
});

describe("assertPublishableKeyMatchesContext (defensive cross-check)", () => {
	const ctx = deriveKeyContext("ah_sk_us_test_abc");
	it("passes when the pk addresses the same cell as the secret key", () => {
		expect(() => assertPublishableKeyMatchesContext("ah_pk_us_test_xyz", ctx)).not.toThrow();
	});
	it("throws when the pk region or mode differs from the secret key", () => {
		expect(() => assertPublishableKeyMatchesContext("ah_pk_eu_test_xyz", ctx)).toThrow(
			InvalidPublishableKeyError,
		);
		expect(() => assertPublishableKeyMatchesContext("ah_pk_us_live_xyz", ctx)).toThrow(
			/different region or mode/i,
		);
	});
	it("throws on a malformed pk", () => {
		expect(() => assertPublishableKeyMatchesContext("ah_sk_us_test_xyz", ctx)).toThrow(
			InvalidPublishableKeyError,
		);
	});
});

describe("isTemplateDemoSupported (blocks only custom_form)", () => {
	it("true for identity verification alone", () => {
		expect(isTemplateDemoSupported(["id_verification"])).toBe(true);
	});
	it("true when identity verification is paired with server-side checks (NOT filtered)", () => {
		expect(isTemplateDemoSupported(["id_verification", "watchlist"])).toBe(true);
		expect(isTemplateDemoSupported(["id_verification", "background_us_criminal", "background_global"])).toBe(true);
	});
	it("true for server-side checks only (no applicant-rendered blocker)", () => {
		expect(isTemplateDemoSupported(["watchlist"])).toBe(true);
	});
	it("true for collect_user_info now that the collect surface (mode b) supports it", () => {
		// CT-377: `collect_user_info` is demonstrated by the /collect surface, so it is
		// no longer a demo-unsupported step.
		expect(isTemplateDemoSupported(["collect_user_info"])).toBe(true);
		expect(isTemplateDemoSupported(["id_verification", "collect_user_info"])).toBe(true);
	});
	it("false when the template includes custom_form (still not rendered by the demo)", () => {
		expect(isTemplateDemoSupported(["id_verification", "custom_form"])).toBe(false);
		expect(isTemplateDemoSupported(["custom_form"])).toBe(false);
	});
	it("true for an empty / unreadable step list (not blocked)", () => {
		expect(isTemplateDemoSupported([])).toBe(true);
	});
});
