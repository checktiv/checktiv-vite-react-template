/// <reference types="node" />
/**
 * What this teaches / copy this pattern:
 * NON-VACUOUS proof that the two pre-deploy guards actually discriminate. A guard
 * that never fails is worthless, so each is exercised against BOTH a fixture that
 * MUST fail and one that MUST pass - if either direction is wrong the test breaks.
 * The guards are run as real subprocesses (`node scripts/<guard>.mjs <fixture>`)
 * so the test proves the CLI exit code the `deploy` script actually gates on, not
 * just an imported helper's return value.
 *
 * Runs in the plain-Node vitest project (it needs `child_process` + `fs`, not the
 * Workers runtime); the triple-slash node reference pulls in `@types/node`, which
 * the test project's explicit `types` array otherwise omits.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_GUARD = fileURLToPath(
	new URL("../../scripts/assert-no-secret-or-drizzle-in-bundle.mjs", import.meta.url),
);
const D1_GUARD = fileURLToPath(
	new URL("../../scripts/assert-no-d1-in-deploy-env.mjs", import.meta.url),
);

/** Run a guard script with the given arg; return its exit status. */
function runGuard(scriptPath: string, arg: string): number {
	const result = spawnSync(process.execPath, [scriptPath, arg], { encoding: "utf-8" });
	return result.status ?? 1;
}

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "checktiv-deploy-guards-"));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("assert-no-secret-or-drizzle-in-bundle", () => {
	it("FAILS (non-zero) on a bundle chunk that leaks a FULL secret key AND a Drizzle table", () => {
		const dir = mkdtempSync(join(workDir, "leak-both-"));
		writeFileSync(
			join(dir, "chunk.js"),
			'const k = "ah_sk_us_live_AAAAAAAAAAAAAAAAAAAA";\n' +
				'export const t = sqliteTable("reservations", {});',
		);
		expect(runGuard(BUNDLE_GUARD, dir)).not.toBe(0);
	});

	it("FAILS (non-zero) on a full baked secret key alone (>=16-char random tail)", () => {
		const dir = mkdtempSync(join(workDir, "secret-"));
		writeFileSync(join(dir, "app.js"), 'const k = "ah_sk_eu_test_ZmFrZWtleTEyMzQ1Njc4OTA";');
		expect(runGuard(BUNDLE_GUARD, dir)).not.toBe(0);
	});

	it("FAILS (non-zero) on a reservations schema leak (sqliteTable + guest_name)", () => {
		const dir = mkdtempSync(join(workDir, "drizzle-"));
		writeFileSync(
			join(dir, "chunk.js"),
			'export const t = sqliteTable("reservations", { guestName: text("guest_name") });',
		);
		expect(runGuard(BUNDLE_GUARD, dir)).not.toBe(0);
	});

	it("PASSES (zero) on the recalibrated false positives: key PARSER source + Setup placeholder + third-party session_id/check_in", () => {
		// This encodes the two verified false positives the guard must NOT trip on:
		// (1) the client key parser legitimately ships the anchored regex SOURCE and
		// the short `ah_sk_...` placeholder (Setup validates keys in-browser);
		// (2) `@checktiv/sdk-web` uses `session_id`/`check_in` as its OWN field names.
		const dir = mkdtempSync(join(workDir, "clean-"));
		writeFileSync(
			join(dir, "app.js"),
			"const KEY_RE = /^ah_sk_(us|eu)_(test|live)_.+$/;\n" +
				'const placeholder = "ah_sk_...";\n' +
				'const fields = ["session_id", "check_in", "check_out"];\n' +
				"console.log(KEY_RE, placeholder, fields);",
		);
		expect(runGuard(BUNDLE_GUARD, dir)).toBe(0);
	});
});

describe("assert-no-d1-in-deploy-env", () => {
	it("FAILS (non-zero) when env.production carries a d1_databases binding", () => {
		const path = join(workDir, "with-d1.jsonc");
		writeFileSync(
			path,
			`{
				// deployed origin (https:// inside a string must NOT be read as a comment)
				"name": "x",
				"env": { "production": {
					"vars": { "PUBLIC_ORIGIN": "https://sdk-demo.checktiv.com" },
					"d1_databases": [ { "binding": "DB", "database_name": "x", "database_id": "y" } ]
				} }
			}`,
		);
		expect(runGuard(D1_GUARD, path)).not.toBe(0);
	});

	it("PASSES (zero) when env.production binds no D1 (https:// value parses cleanly)", () => {
		const path = join(workDir, "no-d1.jsonc");
		writeFileSync(
			path,
			`{
				"name": "x",
				// top-level D1 is fine (local dev); env.production must have none
				"d1_databases": [ { "binding": "DB", "database_name": "x", "database_id": "y" } ],
				"env": { "production": {
					"vars": { "PUBLIC_ORIGIN": "https://sdk-demo.checktiv.com" },
				} }
			}`,
		);
		expect(runGuard(D1_GUARD, path)).toBe(0);
	});

	it("FAILS (non-zero) when env.production is missing entirely (no vacuous pass)", () => {
		const path = join(workDir, "no-prod.jsonc");
		writeFileSync(path, `{ "name": "x", "env": {} }`);
		expect(runGuard(D1_GUARD, path)).not.toBe(0);
	});
});
