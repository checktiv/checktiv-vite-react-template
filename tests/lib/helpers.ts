/**
 * What this teaches / copy this pattern:
 * `makeApiStoreForTest()` binds the REAL `ApiReservationStore` to the REAL
 * `reservationsRoute()` Hono sub-app, backed by a genuinely in-memory D1
 * database - so the shared contract suite
 * (`tests/lib/reservation-store.contract.test.ts`) exercises the actual
 * producer<->consumer wire, not a hand-typed fixture.
 *
 * This file lives under `tests/lib/**`, the plain-Node Vitest project (see
 * `vitest.config.ts`'s `node` project, which only globs `tests/lib/**` and
 * `tests/shared/**`) - so `cloudflare:test`'s `env` is NOT reachable here:
 * that virtual module only resolves inside the `workers` project's Miniflare
 * runtime (`tests/worker/**`, driven by `@cloudflare/vitest-pool-workers`).
 * Instead this uses wrangler's `getPlatformProxy()` - the officially
 * documented way to obtain REAL local `workerd` binding proxies (D1 included)
 * from a plain Node.js process, explicitly sanctioned "for testing purposes"
 * (https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy).
 * `persist: false` gives a fresh, non-persisted (in-memory) D1 database - no
 * files are read from or written to disk.
 *
 * The proxy is created ONCE (module-level singleton, disposed via `afterAll`)
 * and reused across every `makeApiStoreForTest()` call so a run of the suite
 * does not spin up a new `workerd` process per test. Each call re-applies the
 * REAL migration file (idempotent `CREATE TABLE` DDL - never a hand-copied
 * duplicate schema, so the fixture cannot drift from `migrations/*.sql`) and
 * wipes the table, so every returned store starts from the SAME empty state
 * the localStorage adapter gets from a fresh `Map`. The store's methods await
 * that reset internally, so this is correct even though
 * `makeApiStoreForTest()` itself is called synchronously (matching the
 * contract suite's un-awaited `beforeEach(() => { store = make() })`).
 */
import { afterAll } from "vitest";
import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiReservationStore } from "../../src/react-app/lib/reservation-store";
import { reservationsRoute } from "../../src/worker/reservations";

const CONFIG_PATH = fileURLToPath(new URL("../../vitest.workers.jsonc", import.meta.url));
const MIGRATION_PATH = fileURLToPath(
	new URL("../../migrations/0001_reservations.sql", import.meta.url),
);

let proxyPromise: ReturnType<typeof getPlatformProxy<{ DB: D1Database }>> | undefined;

/** Lazily create (once) the shared local D1 proxy backing every test store. */
function getProxy() {
	if (!proxyPromise) {
		proxyPromise = getPlatformProxy<{ DB: D1Database }>({
			configPath: CONFIG_PATH,
			persist: false,
		});
		afterAll(async () => {
			await (await proxyPromise!).dispose();
		});
	}
	return proxyPromise;
}

/** Split the real migration file into individually-runnable statements. */
function readMigrationStatements(): string[] {
	const sql = readFileSync(MIGRATION_PATH, "utf-8");
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((stmt) => stmt.trim())
		.filter((stmt) => stmt.length > 0);
}

/** Apply the real migration (idempotent) then wipe the table so the store starts empty. */
async function resetDb(db: D1Database): Promise<void> {
	for (const statement of readMigrationStatements()) {
		await db.prepare(statement).run();
	}
	await db.prepare("DELETE FROM reservations").run();
}

/**
 * Build a fresh `ApiReservationStore` bound to the real `reservationsRoute`
 * Hono app and a genuinely in-memory D1 database, for the shared adapter
 * contract suite.
 */
export function makeApiStoreForTest(): ApiReservationStore {
	const ready = getProxy().then(async (proxy) => {
		const db = proxy.env.DB;
		await resetDb(db);
		return db;
	});
	const app = reservationsRoute();
	return new ApiReservationStore(async (path, init) => {
		const db = await ready;
		return app.request(path, init, { DB: db });
	});
}
