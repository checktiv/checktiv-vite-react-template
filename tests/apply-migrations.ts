/**
 * What this teaches / copy this pattern:
 * Workers-pool setup hook. It runs INSIDE the Cloudflare runtime (not Node) before
 * each worker test file, applying the D1 migrations passed in as the
 * `TEST_MIGRATIONS` Miniflare binding (assembled in vitest.config.ts). This gives
 * every route/store suite a schema-ready in-memory D1 without hand-writing DDL in
 * each test. Idempotent: `applyD1Migrations` records applied migrations and skips
 * ones already run.
 *
 * `env.DB` is typed `D1Database | undefined` because the unified `Env`
 * reflects the DEPLOYED shape too (production binds no D1 - see
 * `wrangler.jsonc`'s `env.production`). The `vitest.workers.jsonc` test config
 * this project actually runs against always binds `DB`, so a missing binding
 * here would mean the test harness itself is misconfigured - fail loud rather
 * than silently skipping migrations and letting every route/store suite fail
 * downstream with a confusing "no such table" error instead.
 */
import { applyD1Migrations, env } from "cloudflare:test";

if (!env.DB) {
	throw new Error(
		"apply-migrations setup hook: env.DB is not bound. Check vitest.workers.jsonc's d1_databases binding.",
	);
}
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
