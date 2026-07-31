/**
 * What this teaches / copy this pattern:
 * The Workers-pool test runtime exposes bindings via `env` from `cloudflare:test`,
 * typed as `Cloudflare.Env`. Real bindings (like `DB`) come from `wrangler types`.
 * Test-only bindings injected through Miniflare (here `TEST_MIGRATIONS`, used by
 * the migration setup hook) are declared by augmenting the generated `Cloudflare.Env`
 * so `env.TEST_MIGRATIONS` is typed without polluting the deploy config.
 */
import type { D1Migration } from "cloudflare:test";

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

export {};
