import { describe, it, expect, afterEach, vi } from "vitest";
import {
	DevCellConfigError,
	parseDevCellOrigin,
	resolveDevCellOrigin,
} from "../../src/shared/dev-cell";
import { devCellSdkApiBase, devCellWorkspaceBaseUrl } from "../../src/react-app/lib/dev-cell";

/**
 * A stand-in non-production origin. It is a `example.com` placeholder on purpose:
 * this repo is public, so no test may pin a real internal hostname (that is the
 * disclosure these tests exist to keep closed).
 */
const DEV_ORIGIN = "https://sdk-api.dev.example.com";
const VAR = "VITE_CHECKTIV_DEV_CELL_SDK_API_BASE";

describe("parseDevCellOrigin (bare-https-origin validator)", () => {
	it("accepts a bare https origin and returns it normalized", () => {
		expect(parseDevCellOrigin(DEV_ORIGIN, VAR)).toBe(DEV_ORIGIN);
		// Trailing slash dropped, host lowercased, surrounding space trimmed.
		expect(parseDevCellOrigin("  https://SDK-API.Dev.Example.com/  ", VAR)).toBe(DEV_ORIGIN);
	});

	it("accepts an explicit port", () => {
		expect(parseDevCellOrigin("https://sdk-api.dev.example.com:8443", VAR)).toBe(
			"https://sdk-api.dev.example.com:8443",
		);
	});

	it("names the offending variable in every error, so the fix is actionable", () => {
		expect(() => parseDevCellOrigin(undefined, VAR)).toThrow(VAR);
		expect(() => parseDevCellOrigin("http://dev.example.com", VAR)).toThrow(VAR);
	});

	/**
	 * Each row is a shape that turns a "trusted" configurable base URL into a
	 * request-forgery primitive. They are asserted one by one rather than as a
	 * single smoke case so a validator that silently drops ONE rule still fails.
	 */
	it.each([
		["missing", undefined],
		["blank", "   "],
		["not a URL at all", "sdk-api.dev.example.com"],
		["a protocol-relative URL", "//sdk-api.dev.example.com"],
		["http, not https", "http://sdk-api.dev.example.com"],
		["a file: URL", "file:///etc/passwd"],
		["userinfo credentials", "https://evil.example@internal.example.com"],
		["a bare IPv4 literal", "https://169.254.169.254"],
		["a bare IPv6 literal", "https://[::1]"],
		["localhost", "https://localhost"],
		["a localhost subdomain", "https://cell.localhost"],
		["a path", "https://sdk-api.dev.example.com/v1"],
		["a query string", "https://sdk-api.dev.example.com/?a=1"],
		["a fragment", "https://sdk-api.dev.example.com/#x"],
	])("rejects %s", (_label, value) => {
		expect(() => parseDevCellOrigin(value, VAR)).toThrow(DevCellConfigError);
	});
});

describe("resolveDevCellOrigin (flag + origin -> origin | null)", () => {
	it("returns null (production behavior) when the flag is unset, empty, or blank", () => {
		expect(resolveDevCellOrigin(undefined, DEV_ORIGIN, VAR)).toBeNull();
		expect(resolveDevCellOrigin("", DEV_ORIGIN, VAR)).toBeNull();
		expect(resolveDevCellOrigin("   ", DEV_ORIGIN, VAR)).toBeNull();
	});

	it("ignores the origin entirely when the flag is off, even if the origin is garbage", () => {
		// A half-configured env must not be able to break the production path: the
		// flag is the only thing that can turn the override on.
		expect(resolveDevCellOrigin(undefined, "http://169.254.169.254", VAR)).toBeNull();
	});

	it("returns the validated origin when the flag is set (any non-blank value)", () => {
		expect(resolveDevCellOrigin("us", DEV_ORIGIN, VAR)).toBe(DEV_ORIGIN);
		expect(resolveDevCellOrigin(" US ", DEV_ORIGIN, VAR)).toBe(DEV_ORIGIN);
	});

	it("THROWS rather than silently falling back to production when the flag is set but the origin is missing", () => {
		// This is the load-bearing case. A silent null here would run LIVE production
		// traffic while the developer believed they were testing a dev cell.
		expect(() => resolveDevCellOrigin("us", undefined, VAR)).toThrow(DevCellConfigError);
		expect(() => resolveDevCellOrigin("us", undefined, VAR)).toThrow(VAR);
	});

	it("THROWS when the flag is set but the origin fails validation", () => {
		expect(() => resolveDevCellOrigin("us", "http://169.254.169.254", VAR)).toThrow(
			DevCellConfigError,
		);
	});
});

describe("client readers (VITE_* build-time env)", () => {
	// A developer's `.env.local` may set these for manual dev-cell testing; stubbing
	// makes each case deterministic regardless of what is ambient, and restoring
	// after every test keeps this file from leaking env state to its neighbors (see
	// the VITE_PERSISTENCE pattern in reservation-store.contract.test.ts).
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns undefined (production behavior) when the flag is unset", () => {
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", undefined);
		expect(devCellSdkApiBase()).toBeUndefined();
		expect(devCellWorkspaceBaseUrl()).toBeUndefined();
	});

	it("reads each origin from its OWN variable when the flag is set", () => {
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", "us");
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL_SDK_API_BASE", DEV_ORIGIN);
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL", "https://workspace.dev.example.com");
		expect(devCellSdkApiBase()).toBe(DEV_ORIGIN);
		expect(devCellWorkspaceBaseUrl()).toBe("https://workspace.dev.example.com");
	});

	it("each reader requires only ITS OWN origin variable", () => {
		// Enabling the flag to exercise the workspace reviewer must not force a
		// developer to also configure the sdk-api data-plane origin they are not using.
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", "us");
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL_SDK_API_BASE", undefined);
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL", "https://workspace.dev.example.com");
		expect(devCellWorkspaceBaseUrl()).toBe("https://workspace.dev.example.com");
		expect(() => devCellSdkApiBase()).toThrow(DevCellConfigError);
	});

	it("throws naming the missing variable when the flag is on without its origin", () => {
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", "us");
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL_SDK_API_BASE", undefined);
		expect(() => devCellSdkApiBase()).toThrow("VITE_CHECKTIV_DEV_CELL_SDK_API_BASE");
	});
});

describe("the module pins no origin of its own", () => {
	it("cannot resolve any origin without an env value", () => {
		// This module used to hold a hardcoded `DEV_CELLS` table of real internal
		// hosts, which shipped in the public bundle. There is now no path to an
		// origin that does not go through env, which is what keeps a non-production
		// hostname out of this public repo. The repo-wide artifact check lives in
		// `scripts/assert-no-dev-cell-in-deploy.mjs`; this is the unit-level half.
		expect(() => resolveDevCellOrigin("us", "", VAR)).toThrow(DevCellConfigError);
		expect(() => resolveDevCellOrigin("any-flag-value", undefined, VAR)).toThrow(
			DevCellConfigError,
		);
	});
});
