#!/usr/bin/env node
/**
 * What this teaches / copy this pattern:
 * A post-build safety gate that fails the build if the client bundle ever ships
 * something it must not. After the client bundle is built, it greps every emitted
 * `dist/client` chunk for two classes of literal that must NEVER reach the browser:
 *
 *   1. Drizzle / SQLite table DDL - proof a `src/worker/db/schema.ts` table (or
 *      a `drizzle-orm` import) leaked into the client cone. The browser
 *      `Reservation` types are HAND-AUTHORED in the Drizzle-free
 *      `src/shared/reservation-types.ts`; nothing under `src/react-app/**` may
 *      import `src/worker/db/**` or `drizzle-orm` (type-only included - a
 *      single-file transpile does not reliably elide a plain import). The
 *      sentinels are STRING-LITERAL arguments to `sqliteTable(...)` /
 *      `text("...")` (snake_case column names) or raw migration DDL, so they
 *      SURVIVE minification (string args are not renamed the way identifiers
 *      are) and cannot collide with the camelCase names the client actually uses.
 *
 *   2. The `ah_sk_` secret-key prefix - proof a visitor's Checktiv key (which
 *      lives ONLY in `sessionStorage` and transits as a request header) somehow
 *      got baked into a committed/built client chunk. It must never appear.
 *
 * Wired into `package.json`'s `deploy` script as a pre-deploy GATE (after
 * `vite build`, before `wrangler deploy`), so a leaking bundle cannot ship.
 *
 * Usage:
 *   node scripts/assert-no-secret-or-drizzle-in-bundle.mjs          # scans ./dist/client
 *   node scripts/assert-no-secret-or-drizzle-in-bundle.mjs <dir>    # scans <dir> (tests)
 *
 * Exit codes: 0 = clean; 1 = a sentinel was found (or the default bundle dir was
 * empty - a non-vacuous-guard check so the deploy path can't silently pass with
 * an un-built bundle).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_SCAN_DIR = join(REPO_ROOT, "dist", "client");

/**
 * Substring literals that must NEVER appear in a client bundle - each is a
 * DEFINITIVE Drizzle/DDL marker that cannot collide with legitimate client or
 * third-party code:
 *   - `sqliteTable(` / `CREATE TABLE` - if `src/worker/db/schema.ts` or the
 *     migration ever leaks into a client chunk, one of these WILL appear. These
 *     are the ground-truth markers of a real schema/DDL leak.
 *   - `guest_name` / `guest_email` - the reservations schema-SPECIFIC snake_case
 *     column names (string args to `text("...")`). The client refers to the same
 *     fields in camelCase (`guestName`, `guestEmail`), so a snake_case hit is DDL.
 *
 * DELIBERATELY DROPPED (were collision-prone false positives): `session_id`
 * (the third-party `@checktiv/sdk-web` bundle uses this as its OWN field name),
 * and `check_in` / `check_out` (generic tokens that appear in unrelated code).
 * `guest_name` + `guest_email` are specific enough to prove a reservations-table
 * leak on their own, and `sqliteTable(` / `CREATE TABLE` catch ANY table/DDL leak
 * regardless of which columns it carries. Exported so the unit test can assert
 * membership without re-listing the catalog.
 */
export const SUBSTRING_SENTINELS = [
	"sqliteTable(",
	"CREATE TABLE",
	"guest_name",
	"guest_email",
];

/**
 * A FULL Checktiv secret key: `ah_sk_<region>_<mode>_<>=16-char random tail>`.
 * We match the whole key, NOT the bare `ah_sk_` prefix, on purpose: the client
 * key PARSER legitimately ships to the browser (Setup validates the pasted key
 * in-browser before storing it in sessionStorage), and it contains the anchored
 * regex SOURCE `^ah_sk_(us|eu)_(test|live)_.+$` (see
 * `src/shared/checktiv-config.ts`) plus the short Setup input placeholder
 * `ah_sk_...`. Neither the regex source (after `ah_sk_` it reads `(`, not a
 * literal `us`/`eu`) nor the short placeholder has a long random tail, so neither
 * matches this pattern - only an actual baked key (region + mode + a real ~40-char
 * random tail) does. A short region+mode-only prefix does NOT satisfy `{16,}`.
 */
export const SECRET_KEY_PATTERN = /ah_sk_(?:us|eu)_(?:test|live)_[A-Za-z0-9_-]{16,}/;

/** Fixed label for a secret-key hit. We NEVER echo the matched key itself (it
 * could be a real leaked secret) - only that the full-key pattern matched. */
const SECRET_KEY_LABEL = "ah_sk_ full-key pattern";

/**
 * Every leak marker present in a JS text blob: the substring sentinels plus the
 * full-key secret pattern. Returns human-readable labels (never the matched key).
 * Exported for unit testing.
 *
 * @param {string} jsText - Built JS file contents
 * @returns {string[]} The leak labels that appear in `jsText`
 */
export function findLeaks(jsText) {
	const found = [];
	for (const sentinel of SUBSTRING_SENTINELS) {
		if (jsText.includes(sentinel)) found.push(sentinel);
	}
	if (SECRET_KEY_PATTERN.test(jsText)) found.push(SECRET_KEY_LABEL);
	return found;
}

/**
 * Recursively collect `.js` files under `dir`. Missing dir -> empty list.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function walkJs(dir) {
	const files = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkJs(full));
		} else if (extname(entry.name) === ".js") {
			files.push(full);
		}
	}
	return files;
}

/**
 * Scan `dir` for sentinel hits.
 *
 * @param {string} dir
 * @returns {{ scanned: number, hits: Array<{ file: string, literals: string[] }> }}
 */
export function scanDir(dir) {
	const files = walkJs(dir);
	const hits = [];
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const literals = findLeaks(text);
		if (literals.length > 0) hits.push({ file, literals });
	}
	return { scanned: files.length, hits };
}

function main() {
	const argDir = process.argv[2];
	const scanDir_ = argDir ? resolve(process.cwd(), argDir) : DEFAULT_SCAN_DIR;
	const isDefault = !argDir;

	let dirExists = false;
	try {
		dirExists = statSync(scanDir_).isDirectory();
	} catch {
		dirExists = false;
	}

	console.log("  no-secret-or-drizzle-in-bundle assert");
	console.log(
		`  substring sentinels (${SUBSTRING_SENTINELS.length}): ${SUBSTRING_SENTINELS.join(", ")}`,
	);
	console.log(`  secret-key pattern: ${SECRET_KEY_PATTERN.source}`);
	console.log(`  scanning: ${relative(REPO_ROOT, scanDir_) || scanDir_}`);

	const { scanned, hits } = scanDir(scanDir_);
	console.log(`  ${scanned} JS file(s) scanned`);

	// Non-vacuous guard: on the DEFAULT deploy path, an empty/absent bundle dir
	// means the bundle was not built - fail loud rather than silently pass.
	if (isDefault && (!dirExists || scanned === 0)) {
		console.error(
			"\n  result: dist/client is empty or missing - the client bundle was not built.",
		);
		console.error("  Run `vite build` before this guard (the `deploy` script does).");
		process.exit(1);
	}

	if (hits.length === 0) {
		console.log("  result: clean (no Drizzle/DDL table leak, no full Checktiv key)");
		process.exit(0);
	}

	console.error(`\n  result: ${hits.length} client file(s) leak guarded literals\n`);
	for (const h of hits) {
		console.error(`  ${relative(REPO_ROOT, h.file)}`);
		console.error(`    literals: ${h.literals.join(", ")}`);
	}
	console.error(
		"\n  Fix (Drizzle/DDL): a client chunk transitively imports `src/worker/db/**`\n" +
			"  or `drizzle-orm`. Keep browser types on the hand-authored\n" +
			"  `src/shared/reservation-types.ts`; nothing under `src/react-app/**` may\n" +
			"  import the worker DB layer (type-only included).\n" +
			"  Fix (ah_sk_): a secret key was baked into a chunk. The key lives only in\n" +
			"  sessionStorage and transits as a request header - never inline it.\n",
	);
	process.exit(1);
}

// Only run CLI side-effects on direct invocation; importing (tests) does not.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
