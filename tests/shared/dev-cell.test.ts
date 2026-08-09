import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveDevCellOrigins } from "../../src/shared/dev-cell";
import { devCellWorkspaceBaseUrl } from "../../src/react-app/lib/dev-cell";

describe("resolveDevCellOrigins (env-flag -> static dev-cell origins)", () => {
	it("resolves the us dev cell to its compile-time-constant origins", () => {
		expect(resolveDevCellOrigins("us")).toEqual({
			sdkApiBase: "https://sdk-api-dev.us.autohost-dev.uk",
			apiBase: "https://api-dev.us.autohost-dev.uk",
			workspaceBaseUrl: "https://workspace-dev.us.autohost-dev.uk",
		});
	});

	it("is case- and whitespace-insensitive", () => {
		const expected = {
			sdkApiBase: "https://sdk-api-dev.us.autohost-dev.uk",
			apiBase: "https://api-dev.us.autohost-dev.uk",
			workspaceBaseUrl: "https://workspace-dev.us.autohost-dev.uk",
		};
		expect(resolveDevCellOrigins("US")).toEqual(expected);
		expect(resolveDevCellOrigins("  us  ")).toEqual(expected);
	});

	it("returns null (prod behavior) for unset / empty / unknown flags", () => {
		expect(resolveDevCellOrigins(undefined)).toBeNull();
		expect(resolveDevCellOrigins("")).toBeNull();
		expect(resolveDevCellOrigins("   ")).toBeNull();
		expect(resolveDevCellOrigins("eu")).toBeNull(); // no eu dev cell configured
		expect(resolveDevCellOrigins("prod")).toBeNull();
	});

	it("only ever returns a static autohost-dev.uk host (no request-derived origin)", () => {
		const resolved = resolveDevCellOrigins("us");
		expect(resolved).not.toBeNull();
		expect(new URL(resolved!.apiBase).hostname.endsWith(".autohost-dev.uk")).toBe(true);
		expect(new URL(resolved!.sdkApiBase).hostname.endsWith(".autohost-dev.uk")).toBe(true);
		expect(new URL(resolved!.workspaceBaseUrl).hostname.endsWith(".autohost-dev.uk")).toBe(
			true,
		);
	});
});

describe("devCellWorkspaceBaseUrl (client reader)", () => {
	// A root `.env` may or may not set VITE_CHECKTIV_DEV_CELL; vi.stubEnv lets each
	// case control the value deterministically regardless of what's ambient, and
	// restoring after every test keeps this file from leaking env state to its
	// neighbors (see the VITE_PERSISTENCE pattern in reservation-store.contract.test.ts).
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the us dev-cell workspace origin when the flag is set", () => {
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", "us");
		expect(devCellWorkspaceBaseUrl()).toBe("https://workspace-dev.us.autohost-dev.uk");
	});

	it("returns undefined (prod behavior) when the flag is unset", () => {
		vi.stubEnv("VITE_CHECKTIV_DEV_CELL", undefined);
		expect(devCellWorkspaceBaseUrl()).toBeUndefined();
	});
});
