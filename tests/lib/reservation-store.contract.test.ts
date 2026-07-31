/**
 * What this teaches / copy this pattern:
 * The SAME test body, parametrized (`describe.each`) over BOTH
 * `ReservationStore` adapters, proving they honor identical semantics - the
 * producer<->consumer "wiring, not halves" requirement: a store contract
 * tested only against its own fixture would let the two adapters drift
 * silently (e.g. one adapter serializing `undefined` differently than the
 * other). `makeApiStoreForTest()` (see `./helpers.ts`) binds the REAL
 * `ApiReservationStore` to the REAL `reservationsRoute` Hono app over a
 * genuinely in-memory D1 - not a hand-typed mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LocalStorageReservationStore, selectStore } from "../../src/react-app/lib/reservation-store";
import { makeApiStoreForTest } from "./helpers";

// A Storage-shaped shim that actually stringifies/parses over a string map, so the
// localStorage adapter exercises the SAME JSON round-trip the browser forces. A bare
// `new Map()` stores objects by reference (create→get returns the identical object),
// making the round-trip vacuous — it would hide dropped fields / Date-serialization bugs.
function memoryStorage(): Storage {
	const m = new Map<string, string>();
	return {
		getItem: (k) => (m.has(k) ? m.get(k)! : null),
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear(),
		key: (i) => [...m.keys()][i] ?? null,
		get length() {
			return m.size;
		},
	} as Storage;
}

const adapters = [
	["localStorage", () => new LocalStorageReservationStore(memoryStorage())],
	["api+d1", () => makeApiStoreForTest()],
] as const;

describe.each(adapters)("ReservationStore contract: %s", (_name, make) => {
	let store: ReturnType<typeof make>;
	beforeEach(() => {
		store = make();
	});
	it("create → list → get round-trips the same shape", async () => {
		const r = await store.create({
			guestName: "Ada",
			guestEmail: "ada@x.co",
			property: "Unit 1",
			checkIn: "2026-08-01",
			checkOut: "2026-08-03",
		});
		expect(r.id).toBeTruthy();
		expect(r.status).toBe("draft");
		expect(await store.list()).toHaveLength(1);
		expect(await store.get(r.id)).toMatchObject({ guestName: "Ada" });
	});
	it("update patches sessionId + status", async () => {
		const r = await store.create({
			guestName: "B",
			guestEmail: "b@x.co",
			property: "U2",
			checkIn: "2026-08-01",
			checkOut: "2026-08-02",
		});
		const u = await store.update(r.id, { sessionId: "vs_1", status: "invited" });
		expect(u).toMatchObject({ sessionId: "vs_1", status: "invited" });
	});
});

// ---------------------------------------------------------------------------
// selectStore(): the fail-loud adapter switch, tested outside describe.each
// since it exercises `import.meta.env` rather than a store instance.
// ---------------------------------------------------------------------------

describe("selectStore (VITE_PERSISTENCE fail-loud switch)", () => {
	// A root `.env` (VITE_PERSISTENCE=d1) is auto-loaded by Vite, so
	// the ambient value is no longer absent by default. `vi.stubEnv` lets each case
	// control the value deterministically regardless of what's ambient; restore it
	// after every test so this file never leaks env state to its neighbors.
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("throws a clear error when VITE_PERSISTENCE is absent", () => {
		vi.stubEnv("VITE_PERSISTENCE", undefined);
		expect(() => selectStore()).toThrow(/VITE_PERSISTENCE/);
	});

	it("throws a clear error when VITE_PERSISTENCE is an unrecognized value", () => {
		vi.stubEnv("VITE_PERSISTENCE", "garbage");
		expect(() => selectStore()).toThrow(/VITE_PERSISTENCE/);
	});

	it("selects the Api adapter for 'd1'", () => {
		vi.stubEnv("VITE_PERSISTENCE", "d1");
		expect(() => selectStore()).not.toThrow();
	});

	it("selects the LocalStorage adapter for 'local'", () => {
		// LocalStorageReservationStore's default param reads `window.localStorage`;
		// this Vitest `node` project has no real DOM, so stub a minimal `window`
		// for this one test rather than letting an unrelated missing global mask
		// the assertion this test actually makes (the switch itself doesn't throw).
		vi.stubGlobal("window", { localStorage: memoryStorage() });
		vi.stubEnv("VITE_PERSISTENCE", "local");
		expect(() => selectStore()).not.toThrow();
	});
});
