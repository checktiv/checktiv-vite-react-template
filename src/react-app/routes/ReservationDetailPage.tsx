/**
 * What this teaches / copy this pattern:
 * The staff reservation detail page ties three Checktiv surfaces together, each
 * with its own failure discipline (no dead-end UI states - every error offers an
 * in-product next step):
 *
 *   1. STATUS POLL - polls `checktivClient.getSession` every ~4s and reduces the
 *      live 11-member session status to the demo's 4-member `Reservation["status"]`
 *      (via `src/shared/session-status.ts`) BEFORE handing it to `<StatusChip>`.
 *      The poll is DISCIPLINED: it stops on the terminal set
 *      (completed/expired/cancelled), stops with an actionable banner on a
 *      permanent 404/401/400, stops after a bounded run of transient failures,
 *      never runs for a draft (no `sessionId`), and always clears on unmount.
 *
 *   2. REVIEWER EMBED - mounts the staff reviewer iframe through the SDK
 *      `mountReviewer` LOADER, which owns the `wk:*` postMessage
 *      handshake; we never hand-roll it. We thread BOTH `region` and the
 *      custom-domain `workspaceBaseUrl` (so a custom-domain org's reviewer loads
 *      from its override host, not the region default), and a `getToken` that
 *      mints reviewer bearers via `checktivClient.mintWorkspaceToken`.
 *
 *   3. ERROR -> HINT MAPPING - `mintWorkspaceToken` failures surface as DISTINCT
 *      actionable banners (origin/scope/session-gone), mapped off the proxy's
 *      client-facing `ChecktivClientError` code+status.
 *
 * Guarding + shell are applied INSIDE this default export (see the routing note
 * in `main.tsx`), never at the router level.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { AppShell } from "../components/AppShell";
import { GuardedRoute } from "../components/GuardedRoute";
import { StatusChip } from "../components/StatusChip";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
	checktivClient,
	ChecktivClientError,
} from "../lib/checktiv-client";
import { getConfig } from "../lib/config-store";
import { mountReviewer } from "../lib/sdk";
import { selectStore } from "../lib/reservation-store";
import type { Reservation } from "../../shared/reservation-types";
import {
	isTerminalSessionStatus,
	reduceSessionStatus,
	terminalNoticeFor,
} from "../../shared/session-status";

/** Poll cadence for the live session status. */
const POLL_INTERVAL_MS = 4_000;
/** Consecutive transient poll failures tolerated before giving up (bounded retry). */
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 5;
/** Hard cap on total poll attempts (~10 min at 4s) so a stuck session cannot poll forever. */
const MAX_POLL_ATTEMPTS = 150;

// -- actionable banner copy (no dead-ends; every message names an in-product step) --
const HINT_SESSION_GONE =
	"This verification session has expired or was removed. Create a new check-in link to re-verify the guest.";
const HINT_KEY_UNAUTHORIZED =
	"Your Checktiv key is no longer authorized. Re-enter your secret key in Setup, then reload.";
const HINT_REVIEWER_SCOPE =
	"Your Checktiv key is missing the workspace-token scope. Enable it for the key in your Checktiv org, then reload.";
const HINT_REVIEWER_ORIGIN =
	"This app's origin is not on your Checktiv org's workspace-origin allowlist. Add this origin in your Checktiv org settings, then reload.";
const HINT_REVIEWER_SETUP =
	"Complete Setup with your Checktiv secret key to load the staff reviewer.";
const HINT_POLL_EXHAUSTED =
	"We could not refresh this verification's status. Check your connection and reload the page to resume.";
const HINT_REVIEWER_GENERIC =
	"The staff reviewer could not load. Reload the page, and if it persists check your key in Setup.";

/** True when a poll error is permanent (auth/existence) and retrying cannot help. */
function isPermanentPollError(err: unknown): boolean {
	if (err instanceof ChecktivClientError) {
		return (
			err.status === 400 || // not_configured (no key)
			err.status === 401 ||
			err.status === 403 ||
			err.status === 404
		);
	}
	return false;
}

/** Actionable hint for a permanent poll failure. */
function pollErrorHint(err: unknown): string {
	if (err instanceof ChecktivClientError) {
		if (err.status === 404) return HINT_SESSION_GONE;
		// 400 not_configured, 401/403 unauthorized -> re-enter the key in Setup.
		return HINT_KEY_UNAUTHORIZED;
	}
	return HINT_POLL_EXHAUSTED;
}

/**
 * Actionable hint for a reviewer `mintWorkspaceToken` failure. The proxy has
 * already collapsed the upstream wire (`code === 'validation_error'` +
 * `details.reason === 'origin_not_permitted'`) into a client-facing
 * `origin_not_permitted` code, so we branch on THAT code alone for the
 * origin-allowlist hint. A generic 422 (the proxy's plain `validation_error`)
 * is NOT an origin problem, so it falls through to the generic reviewer hint
 * rather than wrongly telling staff to edit their origin allowlist.
 */
function reviewerErrorHint(err: unknown): string {
	if (err instanceof ChecktivClientError) {
		if (err.code === "origin_not_permitted") return HINT_REVIEWER_ORIGIN;
		if (err.status === 403) return HINT_REVIEWER_SCOPE;
		if (err.status === 404) return HINT_SESSION_GONE;
		if (err.status === 401 || err.code === "not_configured") return HINT_KEY_UNAUTHORIZED;
	}
	return HINT_REVIEWER_GENERIC;
}

/** A small inline banner. `tone` only affects color, never the actionable text. */
function Banner({ tone, children }: { tone: "info" | "warn" | "success"; children: ReactNode }) {
	const toneClass =
		tone === "warn"
			? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
			: tone === "success"
				? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
				: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200";
	return (
		<div className={`rounded-md border px-4 py-2 text-sm ${toneClass}`} role="status">
			{children}
		</div>
	);
}

/**
 * The guarded, shelled page content. All hooks live here so they only mount once
 * `<GuardedRoute>` has admitted an authenticated staff user.
 */
function ReservationDetail() {
	const { id } = useParams();
	const config = useMemo(() => getConfig(), []);
	// One store instance shared by the load AND the poll write-back below, so the
	// reduced live status is persisted to the SAME store the reservations list
	// reads from (otherwise the list chip shows the booking's stale status).
	const store = useMemo(() => selectStore(), []);

	const [reservation, setReservation] = useState<Reservation | null>(null);
	// Set only from the async load when the store returns null. A missing/blank
	// :id is DERIVED below (never written in an effect - that trips
	// react-hooks/set-state-in-effect and cascades renders).
	const [reservationMissing, setReservationMissing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [sessionStatus, setSessionStatus] = useState<string | undefined>(undefined);
	const [pollBanner, setPollBanner] = useState<string | null>(null);
	const [reviewerBanner, setReviewerBanner] = useState<string | null>(null);

	const reviewerRef = useRef<HTMLDivElement | null>(null);
	// The last reduced status persisted to the store, and the reservation id, held
	// in refs so the poll can dedup write-backs (write only on an ACTUAL change)
	// and address the store WITHOUT taking `reservation` as an effect dep - which
	// would re-run the poll every time we write and spin a poll loop.
	const persistedStatusRef = useRef<Reservation["status"] | null>(null);
	const reservationIdRef = useRef<string | null>(null);
	const sessionId = reservation?.sessionId;
	// Derived, not effect-written: no `:id` in the route means there is nothing
	// to load, and the async load flips `reservationMissing` when `get` returns null.
	const notFound = !id || reservationMissing;

	// -- load the reservation by :id -----------------------------------------
	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		(async () => {
			try {
				const found = await store.get(id);
				if (cancelled) return;
				if (found === null) {
					setReservationMissing(true);
					return;
				}
				setReservation(found);
				// Seed the write-back dedup baseline from the persisted status so the
				// first poll only writes when the live status actually differs.
				reservationIdRef.current = found.id;
				persistedStatusRef.current = found.status;
			} catch {
				// The reservation store failed (e.g. API adapter). Surface an
				// actionable state rather than a dead white screen.
				if (!cancelled) {
					setLoadError("Could not load this reservation. Reload the page to try again.");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id, store]);

	// -- poll the live session status ----------------------------------------
	useEffect(() => {
		// Draft reservations (no session yet) never poll.
		if (!sessionId) return;

		let stopped = false;
		let consecutiveTransient = 0;
		let attempts = 0;

		const stop = () => {
			stopped = true;
			clearInterval(interval);
		};

		const runPoll = async () => {
			if (stopped) return;
			attempts += 1;
			try {
				const result = await checktivClient.getSession(sessionId);
				if (stopped) return;
				consecutiveTransient = 0;
				setPollBanner(null);
				setSessionStatus(result.status);
				// Persist the reduced live status back to the store so the reservations
				// LIST chip (which renders `reservation.status` from the store) agrees
				// with this page's live chip. Write only on an ACTUAL change (deduped
				// via the ref) so a steady 4s poll does not re-write the same value,
				// and never crash the page if the store write fails.
				const reduced = reduceSessionStatus(result.status);
				const resId = reservationIdRef.current;
				if (resId && reduced !== persistedStatusRef.current) {
					persistedStatusRef.current = reduced;
					void store
						.update(resId, { status: reduced })
						.then(() => {
							if (stopped) return;
							setReservation((prev) => (prev ? { ...prev, status: reduced } : prev));
						})
						.catch(() => {
							// Swallow: the live chip still reflects the poll via local state,
							// and the list re-syncs on the next status change. A failed
							// write must never take down the detail page.
						});
				}
				if (isTerminalSessionStatus(result.status)) {
					stop();
				}
			} catch (err) {
				if (stopped) return;
				if (isPermanentPollError(err)) {
					setPollBanner(pollErrorHint(err));
					stop();
					return;
				}
				consecutiveTransient += 1;
				if (
					consecutiveTransient >= MAX_CONSECUTIVE_TRANSIENT_FAILURES ||
					attempts >= MAX_POLL_ATTEMPTS
				) {
					setPollBanner(HINT_POLL_EXHAUSTED);
					stop();
				}
			}
		};

		const interval = setInterval(runPoll, POLL_INTERVAL_MS);
		void runPoll(); // immediate first poll, then every POLL_INTERVAL_MS
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [sessionId, store]);

	// -- mount the staff reviewer iframe -------------------------------------
	useEffect(() => {
		// Without a session or a Checktiv config the reviewer cannot mount; the
		// "complete Setup" hint is rendered as DERIVED UI below rather than written
		// to state here (a sync setState in an effect trips
		// react-hooks/set-state-in-effect).
		if (!sessionId || !config) return;
		const target = reviewerRef.current;
		if (!target) return;

		const handle = mountReviewer(target, {
			sessionId,
			region: config.ctx.region,
			// Thread the custom-domain override so a custom-domain org's reviewer
			// loads from its own host, not the region default.
			workspaceBaseUrl: config.ctx.workspaceBaseUrl,
			getToken: async ({ sessionId: sid }) => {
				try {
					const { framingToken, dataToken, expiresAt } =
						await checktivClient.mintWorkspaceToken(sid);
					setReviewerBanner(null);
					return { framingToken, dataToken, expiresAt };
				} catch (err) {
					// Surface a distinct actionable banner, then re-throw so the
					// loader aborts the mount instead of hanging on a dead token.
					setReviewerBanner(reviewerErrorHint(err));
					throw err;
				}
			},
		});
		return () => handle.destroy();
	}, [sessionId, config]);

	if (notFound) {
		return (
			<div className="space-y-4">
				<h1 className="text-lg font-semibold">Reservation not found</h1>
				<p className="text-sm text-muted-foreground">
					We could not find that reservation.{" "}
					<Link to="/reservations" className="underline">
						Back to reservations
					</Link>
					.
				</p>
			</div>
		);
	}

	if (loadError) {
		return (
			<div className="space-y-4">
				<Banner tone="warn">{loadError}</Banner>
				<Link to="/reservations" className="text-sm underline">
					Back to reservations
				</Link>
			</div>
		);
	}

	if (!reservation) {
		return <div className="p-2 text-sm text-muted-foreground">Loading reservation...</div>;
	}

	// Reduce the live session status to the reservation's coarse lifecycle status
	// BEFORE it reaches <StatusChip>; fall back to the stored reservation status
	// until the first poll returns.
	const displayStatus = sessionStatus ? reduceSessionStatus(sessionStatus) : reservation.status;
	const notice = sessionStatus ? terminalNoticeFor(sessionStatus) : null;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">{reservation.guestName}</h1>
				<StatusChip status={displayStatus} />
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Reservation</CardTitle>
				</CardHeader>
				<CardContent className="grid grid-cols-2 gap-3 text-sm">
					<div className="text-muted-foreground">Guest</div>
					<div>{reservation.guestName}</div>
					<div className="text-muted-foreground">Email</div>
					<div>{reservation.guestEmail}</div>
					<div className="text-muted-foreground">Property</div>
					<div>{reservation.property}</div>
					<div className="text-muted-foreground">Check-in</div>
					<div>{reservation.checkIn}</div>
					<div className="text-muted-foreground">Check-out</div>
					<div>{reservation.checkOut}</div>
				</CardContent>
			</Card>

			{notice ? (
				<Banner tone={sessionStatus === "completed" ? "success" : "warn"}>{notice}</Banner>
			) : null}
			{pollBanner ? <Banner tone="warn">{pollBanner}</Banner> : null}
			{reviewerBanner ? <Banner tone="warn">{reviewerBanner}</Banner> : null}

			{!sessionId ? (
				<Card>
					<CardContent className="py-6 text-sm text-muted-foreground">
						No verification session yet. Send this guest their check-in link from the
						reservations list to start identity verification.
					</CardContent>
				</Card>
			) : !config ? (
				// Derived (not effect-written): the reviewer cannot mount without a
				// Checktiv config, so surface the actionable Setup step here.
				<Card>
					<CardContent className="py-6">
						<Banner tone="warn">{HINT_REVIEWER_SETUP}</Banner>
					</CardContent>
				</Card>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Verification review</CardTitle>
					</CardHeader>
					<CardContent>
						{/*
						 * The reviewer iframe has NO intrinsic size - the container MUST
						 * carry an explicit height or the iframe collapses to 0px and
						 * renders blank. See the reviewer embed guide at
						 * https://docs.checktiv.com.
						 */}
						<div
							ref={reviewerRef}
							data-testid="reviewer-container"
							className="h-[70vh] w-full overflow-hidden rounded-md border"
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

/** Route entry: guard + shell wrap the detail content per the main.tsx contract. */
export default function ReservationDetailPage() {
	return (
		<GuardedRoute>
			<AppShell>
				<ReservationDetail />
			</AppShell>
		</GuardedRoute>
	);
}
