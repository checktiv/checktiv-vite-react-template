/**
 * What this teaches / copy this pattern:
 * One `ReservationStore` interface, two adapters, so the SAME staff pages work
 * against a local D1-backed API (`ApiReservationStore`) or the deployed,
 * zero-server-persistence `localStorage` store (`LocalStorageReservationStore`)
 * - the deployed demo persists no customer data server-side.
 * `selectStore()` picks the adapter from the build-time
 * `VITE_PERSISTENCE` env var and FAILS LOUD on an absent/unrecognized value
 * rather than silently defaulting - a misconfigured deploy should break the
 * build/dev-server, not quietly serve the wrong persistence.
 *
 * Client-bundle boundary: this file, like every file under
 * `src/react-app/**`, must NEVER import `src/worker/db/schema.ts` or
 * `drizzle-orm` (not even type-only - see `src/shared/reservation-types.ts`).
 * `Reservation`/`NewReservation` are HAND-AUTHORED there; this file only
 * consumes them.
 *
 * Both adapters take an injected dependency (a `Storage` here, a fetch-like
 * function for the API adapter) so they are unit-testable without the real
 * browser globals - see `tests/lib/reservation-store.contract.test.ts`, which
 * runs the SAME contract body against both.
 */
import type { NewReservation, Reservation } from "../../shared/reservation-types";

/** Persistence-agnostic reservation CRUD surface consumed by the staff pages. */
export interface ReservationStore {
	list(): Promise<Reservation[]>;
	get(id: string): Promise<Reservation | null>;
	create(input: NewReservation): Promise<Reservation>;
	update(id: string, patch: Partial<Omit<Reservation, "id">>): Promise<Reservation>;
	/**
	 * Wipe every reservation. This is the reservation-wiping PART of the app's
	 * "Reset demo" self-serve control (a full reset also clears the entered keys and
	 * the check-in stashes). Only the `local` adapter actually clears state; the `d1`
	 * adapter no-ops because the demo exposes no server-side delete endpoint and
	 * the zero-persistence concern only applies to the deployed `localStorage` mode.
	 */
	clear(): Promise<void>;
}

const STORAGE_KEY = "checktiv-pms-demo-reservations";

/**
 * Deployed-mode adapter (`VITE_PERSISTENCE=local`): reservations live
 * UNENCRYPTED in the staff browser's `localStorage` (a deliberate demo
 * trade-off - the app's "Reset demo" action wipes this store). Takes an
 * injected `Storage` (defaults to the real `window.localStorage`) so it is
 * unit-testable with an in-memory shim.
 */
export class LocalStorageReservationStore implements ReservationStore {
	constructor(private readonly storage: Storage = window.localStorage) {}

	private readAll(): Reservation[] {
		const raw = this.storage.getItem(STORAGE_KEY);
		if (raw === null) {
			return [];
		}
		try {
			return JSON.parse(raw) as Reservation[];
		} catch {
			return [];
		}
	}

	private writeAll(all: Reservation[]): void {
		this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
	}

	async list(): Promise<Reservation[]> {
		return this.readAll();
	}

	async get(id: string): Promise<Reservation | null> {
		return this.readAll().find((r) => r.id === id) ?? null;
	}

	async create(input: NewReservation): Promise<Reservation> {
		const reservation: Reservation = {
			...input,
			id: crypto.randomUUID(),
			status: input.status ?? "draft",
		};
		const all = this.readAll();
		all.push(reservation);
		this.writeAll(all);
		return reservation;
	}

	async update(id: string, patch: Partial<Omit<Reservation, "id">>): Promise<Reservation> {
		const all = this.readAll();
		const index = all.findIndex((r) => r.id === id);
		if (index === -1) {
			throw new Error(`Reservation not found: ${id}`);
		}
		const updated: Reservation = { ...all[index], ...patch };
		all[index] = updated;
		this.writeAll(all);
		return updated;
	}

	/** Remove every stored reservation (the reservation-wiping part of "Reset demo"). */
	async clear(): Promise<void> {
		this.storage.removeItem(STORAGE_KEY);
	}
}

/** Narrow fetch signature the API adapter needs; DI lets tests target `app.request` directly. */
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Thrown when a `/api/reservations` call fails; carries the server's actionable hint. */
export class ReservationApiError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(message: string, code: string, status: number) {
		super(message);
		this.name = "ReservationApiError";
		this.code = code;
		this.status = status;
	}
}

/**
 * Local-dev adapter (`VITE_PERSISTENCE=d1`): reservations live in D1, reached
 * through `/api/reservations` (see `src/worker/reservations.ts`). Injects
 * `fetchImpl` (default same-origin `fetch`) so the contract suite can bind it
 * directly to the real Hono app instead of the network (`tests/lib/helpers.ts`).
 */
export class ApiReservationStore implements ReservationStore {
	constructor(private readonly fetchImpl: ApiFetch = (path, init) => fetch(path, init)) {}

	private async parse<T>(res: Response): Promise<T> {
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
			throw new ReservationApiError(
				body.error ?? `Reservation request failed (${res.status}).`,
				body.code ?? "request_failed",
				res.status,
			);
		}
		return res.json() as Promise<T>;
	}

	async list(): Promise<Reservation[]> {
		return this.parse(await this.fetchImpl("/api/reservations"));
	}

	async get(id: string): Promise<Reservation | null> {
		const res = await this.fetchImpl(`/api/reservations/${encodeURIComponent(id)}`);
		if (res.status === 404) {
			return null;
		}
		return this.parse(res);
	}

	async create(input: NewReservation): Promise<Reservation> {
		return this.parse(
			await this.fetchImpl("/api/reservations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}),
		);
	}

	async update(id: string, patch: Partial<Omit<Reservation, "id">>): Promise<Reservation> {
		return this.parse(
			await this.fetchImpl(`/api/reservations/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			}),
		);
	}

	/**
	 * No-op: the local-dev D1 store has no delete endpoint and its data never
	 * leaves the developer's machine, so there is nothing the "Reset demo"
	 * control needs to wipe here. The interface still requires the method so a
	 * single caller can wire the control against either adapter.
	 */
	async clear(): Promise<void> {
		// intentionally empty - see JSDoc
	}
}

/**
 * Pick the adapter from the build-time `VITE_PERSISTENCE` env var. FAILS LOUD
 * on an absent/unrecognized value instead of silently defaulting - this is
 * the path exercised in the Vitest `node` project, where Vite injects no
 * value for an unset var (see `tests/lib/reservation-store.contract.test.ts`).
 */
export function selectStore(): ReservationStore {
	const persistence: unknown = import.meta.env.VITE_PERSISTENCE;
	if (persistence === "d1") {
		return new ApiReservationStore();
	}
	if (persistence === "local") {
		return new LocalStorageReservationStore();
	}
	throw new Error(
		`selectStore: VITE_PERSISTENCE must be "d1" or "local" (got ${JSON.stringify(
			persistence,
		)}). Set VITE_PERSISTENCE in your .env file to match the Worker's PERSISTENCE var.`,
	);
}
