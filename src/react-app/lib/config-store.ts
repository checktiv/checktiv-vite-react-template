/**
 * What this teaches / copy this pattern:
 * The visitor's `DemoConfig` (secret key + workflow template id + derived context)
 * is stored ONLY in the browser's `sessionStorage` and is cleared when the tab
 * closes. The secret key is sent per request as a header to this app's own Worker,
 * which forwards it to Checktiv and never stores or logs it; it is never persisted
 * anywhere (browser or server) beyond this tab's `sessionStorage`. That is the
 * "secret key never persisted" invariant expressed in storage choice: session (not
 * local) scope, browser-only.
 *
 * This module is intentionally browser-only (it references the `sessionStorage`
 * global). Unit tests install an in-memory `Storage` shim on `globalThis`.
 */
import type { DemoConfig } from "../../shared/checktiv-config";

const STORAGE_KEY = "checktiv-demo-config";

/** Read the current config, or `null` if none is stored / it is unparseable. */
export function getConfig(): DemoConfig | null {
	const raw = sessionStorage.getItem(STORAGE_KEY);
	if (raw === null) {
		return null;
	}
	try {
		return JSON.parse(raw) as DemoConfig;
	} catch {
		return null;
	}
}

/** Persist the config for the lifetime of the browser tab. */
export function setConfig(config: DemoConfig): void {
	sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** Remove any stored config (e.g. on "reset key" / "reset demo"). */
export function clearConfig(): void {
	sessionStorage.removeItem(STORAGE_KEY);
}
