#!/usr/bin/env node
/**
 * What this teaches / copy this pattern:
 * A pre-deploy STRUCTURAL guard on `wrangler.jsonc`: FAIL if the `env.production`
 * environment carries ANY `d1_databases` binding. D1 is the local-dev-ONLY
 * persistence layer; the deployed Worker MUST bind no database and store nothing
 * server-side (the zero-persistence invariant - reservations live in the staff
 * browser's localStorage on deploy). This is defense-in-depth: it makes a future
 * edit that re-introduces D1 into the deployed env a hard, loud deploy failure
 * rather than a silent server-persistence regression.
 *
 * It also fails if `env.production` is missing entirely - otherwise a renamed /
 * deleted deploy env would let the guard pass vacuously (and the `deploy` script's
 * `--env production` would then error anyway, but this fails first with a clear
 * message).
 *
 * Wired into `package.json`'s `deploy` script as a pre-deploy GATE, alongside the
 * bundle-leak guard. Parses `wrangler.jsonc` with a dependency-free, string-aware
 * JSONC reader (comments + trailing commas), so `https://` inside a string value
 * is never mistaken for a `//` comment.
 *
 * Usage:
 *   node scripts/assert-no-d1-in-deploy-env.mjs          # checks ./wrangler.jsonc
 *   node scripts/assert-no-d1-in-deploy-env.mjs <path>   # checks <path> (tests)
 *
 * Exit codes: 0 = deploy env is D1-free; 1 = a `d1_databases` binding was found
 * (or `env.production` is missing / the config failed to parse).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_WRANGLER_PATH = resolve(__dirname, "..", "wrangler.jsonc");

/**
 * Strip `//` and block comments from JSONC, ignoring comment-like sequences that
 * occur INSIDE a string (so `"https://x"` survives intact). Tracks string state
 * with escape handling. Exported for unit testing.
 *
 * @param {string} text
 * @returns {string} comment-free text
 */
export function stripComments(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) out += text[i]; // keep the newline
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++; // skip the closing '/'
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Remove trailing commas (`,` immediately before `}` or `]`, ignoring
 * whitespace) from comment-free JSON text, string-aware. Exported for testing.
 *
 * @param {string} text - comment-free text
 * @returns {string}
 */
export function stripTrailingCommas(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue; // drop the trailing comma
		}
		out += ch;
	}
	return out;
}

/**
 * Parse a JSONC string into an object.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
	return JSON.parse(stripTrailingCommas(stripComments(text)));
}

function main() {
	const wranglerPath = process.argv[2]
		? resolve(process.cwd(), process.argv[2])
		: DEFAULT_WRANGLER_PATH;
	let config;
	try {
		config = parseJsonc(readFileSync(wranglerPath, "utf-8"));
	} catch (err) {
		console.error(`  no-d1-in-deploy-env assert: FAILED to parse wrangler.jsonc`);
		console.error(`  ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	const production = config?.env?.production;
	if (!production) {
		console.error(
			"  no-d1-in-deploy-env assert: `env.production` is missing from wrangler.jsonc.",
		);
		console.error("  The `deploy` script deploys `--env production`; that env must exist.");
		process.exit(1);
	}

	const d1 = production.d1_databases;
	if (Array.isArray(d1) && d1.length > 0) {
		console.error(
			`  no-d1-in-deploy-env assert: FAIL - env.production carries ${d1.length} d1_databases binding(s).`,
		);
		console.error(
			"  The deployed Worker MUST bind no D1 (zero server persistence). Remove the\n" +
				"  `d1_databases` block from `env.production` - D1 belongs to the top-level\n" +
				"  (local-dev) config only.",
		);
		process.exit(1);
	}

	console.log("  no-d1-in-deploy-env assert: clean (env.production binds no D1).");
	process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
