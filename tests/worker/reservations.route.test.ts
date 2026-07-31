/**
 * What this teaches / copy this pattern:
 * Exercises `reservationsRoute()` directly in the REAL Workers runtime
 * (`@cloudflare/vitest-pool-workers`), against the REAL in-memory D1 that the
 * setup hook migrates (`tests/apply-migrations.ts` applies
 * `migrations/0001_reservations.sql` via `applyD1Migrations` before this
 * file's tests run). Also proves the fail-loud `env.DB`-absent path: since
 * this route is ALWAYS mounted (never a conditional mount), the deployed
 * no-D1 shape is a real, tested response - not a hypothetical.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { reservationsRoute } from "../../src/worker/reservations";

describe("reservationsRoute - env.DB absent (deployed, stateless shape)", () => {
	it("returns a structured 501 instead of throwing on a missing D1 binding", async () => {
		const app = reservationsRoute();
		const res = await app.request("/api/reservations", {}, {});
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string; code: string; status: number };
		expect(body).toMatchObject({ code: "no_persistence", status: 501 });
		expect(body.error).toMatch(/not available in this deployment/i);
	});
});

describe("reservationsRoute - D1-backed CRUD", () => {
	it("create → list → get → update round-trips through the real Hono app + D1", async () => {
		const app = reservationsRoute();

		const createRes = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					guestName: "Ada",
					guestEmail: "ada@x.co",
					property: "Unit 1",
					checkIn: "2026-08-01",
					checkOut: "2026-08-03",
				}),
			},
			{ DB: env.DB },
		);
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { id: string; status: string };
		expect(created.status).toBe("draft");
		expect(created.id).toBeTruthy();

		const listRes = await app.request("/api/reservations", {}, { DB: env.DB });
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as Array<{ id: string }>;
		expect(list.some((r) => r.id === created.id)).toBe(true);

		const getRes = await app.request(`/api/reservations/${created.id}`, {}, { DB: env.DB });
		expect(getRes.status).toBe(200);
		expect(await getRes.json()).toMatchObject({ guestName: "Ada" });

		const patchRes = await app.request(
			`/api/reservations/${created.id}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: "vs_1", status: "invited" }),
			},
			{ DB: env.DB },
		);
		expect(patchRes.status).toBe(200);
		expect(await patchRes.json()).toMatchObject({ sessionId: "vs_1", status: "invited" });
	});

	it("GET /:id on an unknown id returns a structured 404", async () => {
		const app = reservationsRoute();
		const res = await app.request("/api/reservations/does-not-exist", {}, { DB: env.DB });
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});

	it("POST enforces the JSON body shape: a missing required field is a structured 400", async () => {
		const app = reservationsRoute();
		const res = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				// missing guestEmail/property/checkIn/checkOut
				body: JSON.stringify({ guestName: "Ada" }),
			},
			{ DB: env.DB },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_request" });
	});

	it("PATCH enforces the JSON body shape: an unrecognized status value is a structured 400", async () => {
		const app = reservationsRoute();
		const createRes = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					guestName: "B",
					guestEmail: "b@x.co",
					property: "U2",
					checkIn: "2026-08-01",
					checkOut: "2026-08-02",
				}),
			},
			{ DB: env.DB },
		);
		const created = (await createRes.json()) as { id: string };

		const patchRes = await app.request(
			`/api/reservations/${created.id}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "not-a-real-status" }),
			},
			{ DB: env.DB },
		);
		expect(patchRes.status).toBe(400);
		expect(await patchRes.json()).toMatchObject({ code: "invalid_request" });
	});

	it("PATCH with an empty body is a structured 400, never an unstructured 500", async () => {
		const app = reservationsRoute();
		const createRes = await app.request(
			"/api/reservations",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					guestName: "C",
					guestEmail: "c@x.co",
					property: "U3",
					checkIn: "2026-08-01",
					checkOut: "2026-08-02",
				}),
			},
			{ DB: env.DB },
		);
		const created = (await createRes.json()) as { id: string };

		// An empty `{}` body parses to zero updatable fields; drizzle throws on
		// `.set({})`, so the handler must reject it as a structured 400 BEFORE the
		// db.update rather than surfacing an unstructured 500.
		const patchRes = await app.request(
			`/api/reservations/${created.id}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			},
			{ DB: env.DB },
		);
		expect(patchRes.status).toBe(400);
		expect(await patchRes.json()).toMatchObject({ code: "invalid_request" });
	});
});
