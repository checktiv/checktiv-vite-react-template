/**
 * What this teaches / copy this pattern:
 * One Vitest config, two projects, so pure logic and Worker-runtime code are each
 * tested in the right environment:
 *   - `node`    - pure-unit suites (key parsing, stores, reducers) that need no
 *                 Worker bindings. Fast, plain Node.
 *   - `workers` - Worker/route suites that need `env.DB`, `app.request`, and the
 *                 Cloudflare runtime. Enabled by the `cloudflareTest()` Vite plugin
 *                 from `@cloudflare/vitest-pool-workers` (Miniflare under the hood).
 *
 * The workers project's setup hook applies the D1 migrations into the in-memory
 * database before route/store suites run. Migrations are read at config time with
 * `readD1Migrations()` and passed to the Worker runtime as a Miniflare binding
 * (`TEST_MIGRATIONS`); `tests/apply-migrations.ts` then applies them. The
 * `migrations/` directory is created by the reservation-persistence task, so this
 * config tolerates its absence (empty array) until then.
 *
 * NOTE (API drift): `@cloudflare/vitest-pool-workers` v0.18 removed the
 * `defineWorkersConfig` helper from `/config` in favor of the `cloudflareTest()`
 * Vite plugin exported from the package root. This config follows the installed
 * API, not older docs.
 */
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = existsSync(migrationsDir)
	? await readD1Migrations(migrationsDir)
	: [];

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: [
						"tests/shared/**/*.test.ts",
						"tests/lib/**/*.test.ts",
						"tests/components/**/*.test.tsx",
						"tests/routes/**/*.test.tsx",
					],
				},
			},
			{
				plugins: [
					cloudflareTest({
						miniflare: {
							bindings: { TEST_MIGRATIONS: migrations },
						},
						wrangler: { configPath: "./vitest.workers.jsonc" },
					}),
				],
				test: {
					name: "workers",
					include: ["tests/worker/**/*.test.ts"],
					setupFiles: ["./tests/apply-migrations.ts"],
				},
			},
		],
	},
});
