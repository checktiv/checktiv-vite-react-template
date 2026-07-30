import { describe, it, expect, beforeEach } from "vitest";
import { getConfig, setConfig, clearConfig } from "../../src/react-app/lib/config-store";
import type { DemoConfig } from "../../src/shared/checktiv-config";

/**
 * config-store is browser-only (it reads the global `sessionStorage`). The node
 * test project has no `sessionStorage`, so install a small in-memory shim that
 * implements the DOM `Storage` interface before each test. This keeps the store
 * itself idiomatic (uses the browser global) while remaining unit-testable.
 */
class MemoryStorage implements Storage {
	private map = new Map<string, string>();
	get length(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
	}
	getItem(key: string): string | null {
		return this.map.has(key) ? (this.map.get(key) as string) : null;
	}
	key(index: number): string | null {
		return Array.from(this.map.keys())[index] ?? null;
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

const sampleConfig: DemoConfig = {
	secretKey: "ah_sk_us_test_abc123",
	publishableKey: "ah_pk_us_test_abc123",
	workflowTemplateId: "wt_demo",
	ctx: {
		region: "us",
		mode: "test",
		apiBase: "https://api.us.checktiv.com",
		sdkApiBase: "https://sdk-api.us.checktiv.com",
		workspaceBaseUrl: "https://workspace.us.checktiv.com",
	},
};

beforeEach(() => {
	globalThis.sessionStorage = new MemoryStorage();
});

describe("config-store (sessionStorage round-trip)", () => {
	it("set -> get returns the same DemoConfig", () => {
		expect(getConfig()).toBeNull();
		setConfig(sampleConfig);
		expect(getConfig()).toEqual(sampleConfig);
	});

	it("clear removes the stored config", () => {
		setConfig(sampleConfig);
		clearConfig();
		expect(getConfig()).toBeNull();
	});
});
