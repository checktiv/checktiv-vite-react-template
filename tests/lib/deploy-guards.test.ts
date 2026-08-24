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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_GUARD = fileURLToPath(
	new URL("../../scripts/assert-no-secret-or-drizzle-in-bundle.mjs", import.meta.url),
);
const D1_GUARD = fileURLToPath(
	new URL("../../scripts/assert-no-d1-in-deploy-env.mjs", import.meta.url),
);
const DEV_CELL_GUARD = fileURLToPath(
	new URL("../../scripts/assert-no-dev-cell-in-deploy.mjs", import.meta.url),
);

/** Run a guard script with the given arg; return its exit status. */
function runGuard(scriptPath: string, arg: string): number {
	const result = spawnSync(process.execPath, [scriptPath, arg], { encoding: "utf-8" });
	return result.status ?? 1;
}

/**
 * Build a fixture repo root the dev-cell guard can be pointed at: a `.env.production`,
 * a generated `dist/<worker>/wrangler.json`, and a `dist/client` bundle. Each option
 * overrides one input so a test can make exactly ONE thing wrong and prove that the
 * check responsible for it is the one that fires.
 *
 * The default state is the SAFE one (dev-cell pinned empty, no worker vars, only
 * production hosts in the bundle), so every failing case below differs from a passing
 * deploy by a single field.
 */
function makeFixtureRoot(
	parent: string,
	options: {
		envProduction?: string;
		envLocal?: string;
		workerVars?: Record<string, string>;
		targetEnvironment?: string;
		/** Emit a config with NO `targetEnvironment` - what a plain `vite build` produces. */
		omitTargetEnvironment?: boolean;
		bundleJs?: string;
		/** Contents of an EXTENSIONLESS `_headers` file in the bundle. */
		bundleHeadersFile?: string;
		omitBundle?: boolean;
		omitGeneratedConfig?: boolean;
	} = {},
): string {
	const root = mkdtempSync(join(parent, "root-"));
	writeFileSync(
		join(root, ".env.production"),
		options.envProduction ??
			"VITE_CHECKTIV_DEV_CELL=\nVITE_CHECKTIV_DEV_CELL_SDK_API_BASE=\nVITE_CHECKTIV_DEV_CELL_WORKSPACE_BASE_URL=\n",
	);
	if (options.envLocal !== undefined) writeFileSync(join(root, ".env.local"), options.envLocal);

	if (!options.omitGeneratedConfig) {
		const workerDir = join(root, "dist", "demo_worker");
		mkdirSync(workerDir, { recursive: true });
		writeFileSync(
			join(workerDir, "wrangler.json"),
			JSON.stringify({
				name: "demo",
				...(options.omitTargetEnvironment
					? {}
					: { targetEnvironment: options.targetEnvironment ?? "production" }),
				vars: options.workerVars ?? {
					PERSISTENCE: "local",
					PUBLIC_ORIGIN: "https://sdk-demo.checktiv.com",
				},
			}),
		);
	}

	if (!options.omitBundle) {
		const clientDir = join(root, "dist", "client");
		mkdirSync(clientDir, { recursive: true });
		writeFileSync(
			join(clientDir, "app.js"),
			options.bundleJs ?? 'const base = "https://sdk-api.us.checktiv.com";\nconsole.log(base);',
		);
		if (options.bundleHeadersFile !== undefined) {
			writeFileSync(join(clientDir, "_headers"), options.bundleHeadersFile);
		}
	}
	return root;
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

describe("assert-no-dev-cell-in-deploy", () => {
	it("PASSES (zero) on a clean production deploy: pinned-empty env, no worker vars, production-only bundle", () => {
		// The baseline every failing case below differs from by exactly one field. If
		// this ever fails, the guard is rejecting a SAFE deploy and the fixture, not
		// the deploy, is what needs looking at.
		expect(runGuard(DEV_CELL_GUARD, makeFixtureRoot(workDir))).toBe(0);
	});

	// --- Check 1: resolved client env -------------------------------------------
	it("FAILS when .env.production itself enables the dev-cell flag", () => {
		const root = makeFixtureRoot(workDir, { envProduction: "VITE_CHECKTIV_DEV_CELL=us\n" });
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("FAILS when a dev-cell ORIGIN var is set even though the flag itself is empty", () => {
		// Prefix matching, not an exact-name list: a half-configured env still means a
		// non-production hostname would be inlined into the public bundle.
		const root = makeFixtureRoot(workDir, {
			envProduction: "VITE_CHECKTIV_DEV_CELL=\nVITE_CHECKTIV_DEV_CELL_SDK_API_BASE=https://sdk-api.dev.example.com\n",
		});
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("PASSES when .env.local sets the flag but .env.production pins it empty (mode-specific outranks generic)", () => {
		// This is the documented Vite precedence the whole `.env.production` pin relies
		// on. If Vite ever changed it, this test - not a production incident - is what
		// would tell us. https://vite.dev/guide/env-and-mode
		const root = makeFixtureRoot(workDir, {
			envLocal: "VITE_CHECKTIV_DEV_CELL=us\nVITE_CHECKTIV_DEV_CELL_SDK_API_BASE=https://sdk-api.dev.example.com\n",
		});
		expect(runGuard(DEV_CELL_GUARD, root)).toBe(0);
	});

	// --- Check 2: generated worker deploy config --------------------------------
	it("FAILS when the generated deploy config carries CHECKTIV_DEV_CELL in vars", () => {
		const root = makeFixtureRoot(workDir, {
			workerVars: { PERSISTENCE: "local", CHECKTIV_DEV_CELL: "us" },
		});
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("FAILS when the generated deploy config carries CHECKTIV_DEV_CELL_API_BASE in vars", () => {
		const root = makeFixtureRoot(workDir, {
			workerVars: { PERSISTENCE: "local", CHECKTIV_DEV_CELL_API_BASE: "https://api.dev.example.com" },
		});
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("PASSES when worker vars merely CONTAIN the substring but do not start with it", () => {
		// Guards against a sloppy `includes()` rewrite that would fail an innocent var.
		const root = makeFixtureRoot(workDir, {
			workerVars: { PERSISTENCE: "local", DEMO_CHECKTIV_DEV_CELL_NOTES: "see .dev.vars.example" },
		});
		expect(runGuard(DEV_CELL_GUARD, root)).toBe(0);
	});

	// --- Check 3: built client bundle -------------------------------------------
	it("FAILS on a bundle referencing a host that is not on the production allowlist", () => {
		// The env-independent check: this is what catches a non-production origin
		// hardcoded back into SOURCE, where neither cause-check can see it.
		const root = makeFixtureRoot(workDir, {
			bundleJs: 'const base = "https://sdk-api-dev.us.internal.example";',
		});
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("PASSES on a bundle carrying only production Checktiv origins and namespace URIs", () => {
		// The calibrated false positives: SVG/JSON-Schema namespace URIs and framework
		// dev-warning links are identifiers, not destinations, and legitimately ship.
		const root = makeFixtureRoot(workDir, {
			bundleJs:
				'const ns = "http://www.w3.org/2000/svg";\n' +
				'const schema = "https://json-schema.org/draft/2020-12/schema";\n' +
				'const warn = "https://react.dev/link/rules-of-hooks";\n' +
				'const api = "https://api.eu.checktiv.com";\n' +
				'const embed = "https://embed.us.checktiv.com";\n' +
				"console.log(ns, schema, warn, api, embed);",
		});
		expect(runGuard(DEV_CELL_GUARD, root)).toBe(0);
	});

	it("FAILS on a non-allowlisted host in an EXTENSIONLESS _headers file", () => {
		// `public/_headers` is copied into the bundle and has no extension. It was one
		// of the places a real internal hostname was found, so an extension-only scan
		// would skip a known leak site.
		const root = makeFixtureRoot(workDir, {
			bundleHeadersFile: '# camera=(self "https://embed-dev.us.internal.example")\n',
		});
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("PASSES on an RFC 2606 example.com placeholder in a comment", () => {
		// Reserved for documentation and unresolvable, so a placeholder is not a
		// disclosure. Allowed by RULE, so the allowlist keeps meaning "a real
		// production origin" rather than drifting into a grab bag.
		const root = makeFixtureRoot(workDir, {
			bundleHeadersFile: '# camera=(self "https://embed.dev.example.com")\n',
			bundleJs: 'const doc = "https://sdk-api.dev.example.org";',
		});
		expect(runGuard(DEV_CELL_GUARD, root)).toBe(0);
	});

	// --- Non-vacuous guards: a check that cannot see its input must FAIL ---------
	it("FAILS when dist/client is missing entirely (no vacuous pass on an unbuilt bundle)", () => {
		const root = makeFixtureRoot(workDir, { omitBundle: true });
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("FAILS when the generated deploy config is missing (no vacuous pass on an unbuilt worker)", () => {
		const root = makeFixtureRoot(workDir, { omitGeneratedConfig: true });
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("FAILS when the generated config has NO targetEnvironment (a plain, non-production build)", () => {
		// Verified against a real `vite build` with no CLOUDFLARE_ENV: it emits no
		// `targetEnvironment` and resolves the TOP-LEVEL, D1-bound config. Blessing that
		// artifact would say nothing about what the production deploy actually ships.
		const root = makeFixtureRoot(workDir, { omitTargetEnvironment: true });
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});

	it("FAILS when the generated config targets some OTHER environment", () => {
		const root = makeFixtureRoot(workDir, { targetEnvironment: "staging" });
		expect(runGuard(DEV_CELL_GUARD, root)).not.toBe(0);
	});
});
