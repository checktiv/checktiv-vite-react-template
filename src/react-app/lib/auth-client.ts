/**
 * What this teaches / copy this pattern:
 * The browser side of the mock staff-auth gate (`src/worker/auth.ts`). The
 * staff-session cookie is `HttpOnly` by design, so this module can never read it
 * directly - `login()`/`logout()` just POST to the Worker and let it manage the
 * cookie, and `useSession()` probes `GET /api/auth/session` (itself gated by
 * `requireStaff`) to learn whether the current browser is authenticated.
 *
 * IMPORTANT: this is a MOCK gate, not real auth - see `src/worker/auth.ts` for the
 * full note. Nothing here should be copied into a production login flow as-is.
 */
import { useEffect, useState } from "react";

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface SessionState {
	status: SessionStatus;
}

interface ErrorBody {
	error?: unknown;
}

/** Best-effort extraction of the Worker's `{ error }` body for a thrown Error
 * message; falls back to a generic message if the body is not JSON. */
async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as ErrorBody;
		return typeof body.error === "string" ? body.error : fallback;
	} catch {
		return fallback;
	}
}

/** Log in as the demo staff account. Throws with the Worker's error message
 * (invalid credentials, or a fail-closed "auth not configured" 500) on failure. */
export async function login(username: string, password: string): Promise<void> {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ username, password }),
	});
	if (!res.ok) {
		throw new Error(await extractErrorMessage(res, "Login failed. Try again."));
	}
}

/** Clear the staff session. Safe to call even if already logged out. */
export async function logout(): Promise<void> {
	const res = await fetch("/api/auth/logout", {
		method: "POST",
		credentials: "same-origin",
	});
	if (!res.ok) {
		throw new Error(await extractErrorMessage(res, "Logout failed."));
	}
}

/**
 * React hook reporting the current staff-session status. Starts `"loading"` and
 * resolves to `"authenticated"`/`"unauthenticated"` after probing the Worker -
 * there is no synchronous, client-readable signal because the cookie is
 * `HttpOnly`. `<GuardedRoute>` is the primary consumer.
 */
export function useSession(): SessionState {
	const [status, setStatus] = useState<SessionStatus>("loading");

	useEffect(() => {
		let cancelled = false;
		fetch("/api/auth/session", { credentials: "same-origin" })
			.then((res) => {
				if (!cancelled) {
					setStatus(res.ok ? "authenticated" : "unauthenticated");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setStatus("unauthenticated");
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { status };
}
