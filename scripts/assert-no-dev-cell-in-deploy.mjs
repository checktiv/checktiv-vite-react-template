#!/usr/bin/env node
/**
 * What this teaches / copy this pattern:
 * A pre-deploy gate that fails a PRODUCTION deploy carrying NON-PRODUCTION cell
 * targeting. The public demo must always talk to production Checktiv origins; a
 * deploy that points it at an internal dev cell sends visitors' live publishable
 * keys to a cell those keys are not issued for (403s on `/sdk/v1/working-token`),
 * and it publishes internal hostnames in the client bundle.
 *
 * This has fired for real. A tracked `.env` was flipped to `VITE_CHECKTIV_DEV_CELL=us`
 * for local testing and rode along into a deploy; the class of mistake has produced
 * six bad production deploys. The only prior protection was someone remembering.
 *
 * WHY THREE CHECKS, NOT ONE. A guard that inspects only the file the last incident
 * touched is not a guard - it is a memorial. Dev-cell targeting can enter a deploy
 * through two independent channels, and the third check catches the case where it
 * bypasses both:
 *
 *   1. CLIENT ENV (cause). Vite inlines `VITE_*` into the browser bundle at build
 *      time, resolved across `.env`, `.env.local`, `.env.production`,
 *      `.env.production.local` AND the process environment. Reading one file would
 *      miss the other four sources, so this uses Vite's own `loadEnv` to resolve the
 *      real precedence chain rather than re-implementing it.
 *   2. WORKER VARS (cause). `env.production.vars` in `wrangler.jsonc` sets the
 *      server-side flag. This reads the GENERATED `dist/<worker>/wrangler.json` rather
 *      than the hand-written source, because that generated file is - in Cloudflare's own
 *      words - "the configuration that is used for preview and deployment", already
 *      flattened for the selected `CLOUDFLARE_ENV`. Checking the source file would
 *      mean re-implementing environment inheritance and could disagree with what
 *      wrangler actually ships.
 *      https://developers.cloudflare.com/workers/vite-plugin/tutorial/
 *   3. BUILT BUNDLE (effect). Every `http(s)://host` literal in `dist/client` must be
 *      on an allowlist of public/production hosts. This is env-independent, so it
 *      catches a non-production origin HARDCODED back into source - a path neither
 *      cause-check can see - and it is the check that keeps internal hostnames out of
 *      the published artifact regardless of how they got there.
 *
 * KNOWN LIMIT, stated because a comment must not claim more than the code enforces:
 * a var set with `wrangler secret put` or in the Cloudflare dashboard is invisible to
 * every local check here. Check 3 still catches its client-side effect, but a
 * dashboard-set `CHECKTIV_DEV_CELL_API_BASE` on the deployed Worker cannot be
 * detected from this repo. Do not set dev-cell vars that way.
 *
 * Wired into `package.json`'s `deploy` script as a pre-deploy GATE (after
 * `CLOUDFLARE_ENV=production vite build`, before `wrangler deploy`).
 *
 * Usage:
 *   node scripts/assert-no-dev-cell-in-deploy.mjs           # checks the real repo + build
 *   node scripts/assert-no-dev-cell-in-deploy.mjs <rootDir>  # checks a fixture tree (tests)
 *
 * Exit codes: 0 = clean; 1 = dev-cell targeting found, or an input needed to reach a
 * verdict was missing (an unbuilt bundle, a missing generated config, a build that was
 * not a production build). Every ambiguity resolves toward FAILING - a guard that
 * cannot see the artifact must not bless it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { parseJsonc } from "./assert-no-d1-in-deploy-env.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** The Vite mode the `deploy` script builds with. Env is resolved for this mode. */
const DEPLOY_MODE = "production";

/**
 * Any env var whose name starts with one of these selects or configures a
 * non-production cell. Matched by PREFIX, not by exact name, so a future
 * `*_DEV_CELL_SOMETHING_ELSE` variable is covered the day it is added rather than
 * the day someone remembers to update this list.
 */
export const DEV_CELL_CLIENT_PREFIX = "VITE_CHECKTIV_DEV_CELL";
export const DEV_CELL_WORKER_PREFIX = "CHECKTIV_DEV_CELL";

/**
 * Hosts a PUBLIC production build is allowed to reference. An allowlist, not a
 * denylist, on purpose: a denylist can only catch hostnames someone thought to
 * write down, and the whole failure being guarded is a hostname nobody thought
 * about. Anything new fails and gets a human look.
 *
 * Note what is NOT here and cannot be: the internal non-production apex. Naming it
 * would put the very hostname this guard exists to remove back into the public repo.
 * The allowlist is therefore built only from public, production, already-published
 * hosts.
 *
 *   - Checktiv production cells (both regions - the demo picks its region at runtime
 *     from the pasted key, so either can be the live one) plus the public docs/site.
 *   - XML/JSON-Schema NAMESPACE URIs from SVG and schema literals. These are
 *     identifiers, never fetched.
 *   - Framework dev-warning links (`react.dev`, `reactrouter.com`, `github.com`).
 *   - `localhost`, which is not an internal Checktiv host and cannot leak anything.
 */
export const ALLOWED_BUNDLE_HOSTS = new Set([
	// Checktiv production, both regions.
	"checktiv.com",
	"docs.checktiv.com",
	"api.us.checktiv.com",
	"api.eu.checktiv.com",
	"sdk-api.us.checktiv.com",
	"sdk-api.eu.checktiv.com",
	"sdk.us.checktiv.com",
	"sdk.eu.checktiv.com",
	"embed.us.checktiv.com",
	"embed.eu.checktiv.com",
	"workspace.us.checktiv.com",
	"workspace.eu.checktiv.com",
	"sdk-demo.checktiv.com",
	// Namespace identifiers, not network destinations.
	"www.w3.org",
	"json-schema.org",
	// Framework dev-warning links.
	"react.dev",
	"reactrouter.com",
	"github.com",
	// Not an internal host; carries nothing.
	"localhost",
]);

/** Every `http(s)://host` literal in a text blob. Host only - path is irrelevant here. */
const ORIGIN_LITERAL = /https?:\/\/([A-Za-z0-9._-]+)/g;

/** File extensions in `dist/client` that can carry an origin literal. */
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json", ".map"]);

/**
 * Whether a built file is worth scanning. Extension-matched files, PLUS files with
 * NO extension at all - which in `dist/client` are the Cloudflare control files
 * (`_headers`, `_redirects`, `.assetsignore`). That inclusion is not incidental:
 * `public/_headers` is one of the places an internal hostname was found, so an
 * extension-only rule would have skipped a known leak site.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
function isScannable(fileName) {
	const ext = extname(fileName);
	return ext === "" || SCANNED_EXTENSIONS.has(ext);
}

/**
 * `example.com`, `example.org` and `example.net` (and any subdomain) are RESERVED
 * for documentation by RFC 2606 and can never resolve to a real service, so a
 * placeholder in a comment or a doc string is not a disclosure. Allowing them by
 * RULE rather than by adding each one to the allowlist keeps the allowlist meaning
 * "a real production origin we ship traffic to" instead of drifting into a grab bag.
 *
 * @param {string} host lowercased hostname
 * @returns {boolean}
 */
function isReservedExampleHost(host) {
	return ["example.com", "example.org", "example.net"].some(
		(reserved) => host === reserved || host.endsWith(`.${reserved}`),
	);
}

/**
 * Extract the distinct lowercase hosts referenced by `http(s)://` literals in `text`.
 * Exported for unit testing.
 *
 * @param {string} text
 * @returns {string[]} distinct hosts, lowercased
 */
export function extractHosts(text) {
	const hosts = new Set();
	for (const match of text.matchAll(ORIGIN_LITERAL)) {
		hosts.add(match[1].toLowerCase());
	}
	return [...hosts];
}

/**
 * The hosts in `text` that are NOT on the production allowlist. Exported for testing.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function disallowedHosts(text) {
	return extractHosts(text).filter(
		(host) => !ALLOWED_BUNDLE_HOSTS.has(host) && !isReservedExampleHost(host),
	);
}

/**
 * Env entries whose NAME starts with `prefix` and whose value is a non-blank string.
 * A blank value is the deliberate "pinned off" state (`.env.production` pins the
 * dev-cell keys to empty on purpose), so blank must PASS or the guard would fail the
 * very configuration that makes the deploy safe. Exported for testing.
 *
 * @param {Record<string, unknown>} env
 * @param {string} prefix
 * @returns {string[]} the offending variable names
 */
export function devCellKeysSet(env, prefix) {
	return Object.entries(env ?? {})
		.filter(([name, value]) => name.startsWith(prefix))
		.filter(([, value]) => typeof value === "string" && value.trim().length > 0)
		.map(([name]) => name);
}

/**
 * Recursively collect scannable files under `dir`. Missing dir -> empty list.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function walkScannable(dir) {
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
			files.push(...walkScannable(full));
		} else if (isScannable(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Locate the generated deploy config at `dist/<worker>/wrangler.json`. The directory
 * name is derived by the Vite plugin from the Worker name, so it is discovered by
 * scanning `dist/` rather than hardcoded - a hardcoded path would silently stop
 * matching if the Worker were renamed, turning this check vacuous.
 *
 * @param {string} rootDir
 * @returns {{ path: string } | { error: string }}
 */
function findGeneratedConfig(rootDir) {
	const distDir = join(rootDir, "dist");
	let entries;
	try {
		entries = readdirSync(distDir, { withFileTypes: true });
	} catch {
		return { error: `dist/ is missing - run \`CLOUDFLARE_ENV=production vite build\` first.` };
	}
	const found = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(distDir, entry.name, "wrangler.json");
		try {
			if (statSync(candidate).isFile()) found.push(candidate);
		} catch {
			/* not a worker output dir */
		}
	}
	if (found.length === 0) {
		return {
			error:
				"no dist/*/wrangler.json generated deploy config found - the Worker build did not run.",
		};
	}
	if (found.length > 1) {
		return {
			error: `expected exactly one dist/*/wrangler.json, found ${found.length}: ${found
				.map((f) => relative(rootDir, f))
				.join(", ")}. Clear dist/ and rebuild.`,
		};
	}
	return { path: found[0] };
}

function main() {
	const argRoot = process.argv[2];
	const rootDir = argRoot ? resolve(process.cwd(), argRoot) : REPO_ROOT;
	const failures = [];

	console.log("  no-dev-cell-in-deploy assert");
	console.log(`  root: ${relative(REPO_ROOT, rootDir) || rootDir}`);

	// --- Check 1: the RESOLVED client env (all four .env files + process env) -------
	const clientEnv = loadEnv(DEPLOY_MODE, rootDir, DEV_CELL_CLIENT_PREFIX);
	const clientHits = devCellKeysSet(clientEnv, DEV_CELL_CLIENT_PREFIX);
	if (clientHits.length > 0) {
		failures.push(
			`client env: ${clientHits.join(", ")} resolve(s) to a non-empty value for mode ` +
				`"${DEPLOY_MODE}".\n` +
				`    Vite would inline this into the public bundle. Checked across .env, .env.local,\n` +
				`    .env.${DEPLOY_MODE}, .env.${DEPLOY_MODE}.local and the process environment.\n` +
				`    Fix: pin them empty in .env.${DEPLOY_MODE} (which outranks .env.local) and keep\n` +
				`    your real values in the gitignored .env.local.`,
		);
	} else {
		console.log(`  [1/3] client env: clean (no ${DEV_CELL_CLIENT_PREFIX}* resolves non-empty)`);
	}

	// --- Check 2: the GENERATED worker deploy config --------------------------------
	const generated = findGeneratedConfig(rootDir);
	if ("error" in generated) {
		failures.push(`worker deploy config: ${generated.error}`);
	} else {
		let config;
		try {
			config = parseJsonc(readFileSync(generated.path, "utf-8"));
		} catch (err) {
			config = null;
			failures.push(
				`worker deploy config: failed to parse ${relative(rootDir, generated.path)} - ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (config) {
			// Non-vacuous guard: if this is not a production build, checks 2 and 3 are
			// inspecting the wrong artifact entirely (a plain `vite build` resolves the
			// top-level, D1-bound config). Fail rather than bless the wrong thing.
			if (config.targetEnvironment !== DEPLOY_MODE) {
				failures.push(
					`worker deploy config: targetEnvironment is ` +
						`${JSON.stringify(config.targetEnvironment)}, not "${DEPLOY_MODE}".\n` +
						`    The build was not a production build, so this guard would be inspecting the\n` +
						`    wrong artifact. Build with CLOUDFLARE_ENV=${DEPLOY_MODE} (the deploy script does).`,
				);
			}
			const workerHits = devCellKeysSet(config.vars ?? {}, DEV_CELL_WORKER_PREFIX);
			if (workerHits.length > 0) {
				failures.push(
					`worker vars: ${workerHits.join(", ")} set in the generated deploy config.\n` +
						`    Remove them from env.${DEPLOY_MODE}.vars in wrangler.jsonc. Dev-cell vars belong\n` +
						`    in the gitignored .dev.vars, which is never deployed.`,
				);
			} else if (config.targetEnvironment === DEPLOY_MODE) {
				console.log(
					`  [2/3] worker vars: clean (no ${DEV_CELL_WORKER_PREFIX}* in the ${DEPLOY_MODE} deploy config)`,
				);
			}
		}
	}

	// --- Check 3: the BUILT client bundle -------------------------------------------
	const clientDir = join(rootDir, "dist", "client");
	const files = walkScannable(clientDir);
	if (files.length === 0) {
		// Non-vacuous guard: an unbuilt bundle must not pass silently.
		failures.push(
			"client bundle: dist/client is empty or missing - the client bundle was not built.\n" +
				"    Run `vite build` before this guard (the `deploy` script does).",
		);
	} else {
		const hits = [];
		for (const file of files) {
			let text;
			try {
				text = readFileSync(file, "utf-8");
			} catch {
				continue;
			}
			const bad = disallowedHosts(text);
			if (bad.length > 0) hits.push({ file, hosts: bad });
		}
		if (hits.length > 0) {
			const detail = hits
				.map((h) => `      ${relative(rootDir, h.file)}: ${h.hosts.join(", ")}`)
				.join("\n");
			failures.push(
				`client bundle: ${hits.length} file(s) reference host(s) that are not on the\n` +
					`    production allowlist:\n${detail}\n` +
					`    If a host is a legitimate PUBLIC production origin, add it to\n` +
					`    ALLOWED_BUNDLE_HOSTS in this script. If it is a non-production or internal\n` +
					`    host, it must not ship - take it out of the source and out of your env.`,
			);
		} else {
			console.log(`  [3/3] client bundle: clean (${files.length} file(s), all hosts allowlisted)`);
		}
	}

	if (failures.length === 0) {
		console.log("  result: clean (no dev-cell targeting in env, worker vars, or bundle)");
		process.exit(0);
	}

	console.error(`\n  result: FAIL - ${failures.length} dev-cell leak check(s) failed\n`);
	for (const failure of failures) {
		console.error(`  - ${failure}\n`);
	}
	console.error(
		"  The public demo must target PRODUCTION Checktiv origins only. Dev-cell targeting\n" +
			"  sends visitors' live publishable keys to a cell their keys are not issued for and\n" +
			"  publishes internal hostnames in the client bundle.\n",
	);
	process.exit(1);
}

// Only run CLI side-effects on direct invocation; importing (tests) does not.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
