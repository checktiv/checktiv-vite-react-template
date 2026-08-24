/**
 * What this teaches / copy this pattern:
 * This is the demo's core Checktiv flow: a staff member creates a booking, and
 * that action mints a verification SESSION and produces a guest check-in link.
 * The ordering is load-bearing and worth copying verbatim:
 *
 *   1. `store.create(...)`  - persist the reservation FIRST (joined `guestName`)
 *   2. `client.createSession(applicant)` - mint the session
 *   3. `store.update(id, { sessionId, status: 'invited' })` - link them together
 *
 * The applicant name each path sends is decided by what that path AUTHORITATIVELY
 * knows, and the two paths differ:
 *
 *   - New booking: the form collected first/last as separate inputs, so the staff
 *     member declared the boundary. Send `family_name` + `given_names`.
 *   - Re-invite: all that survives is the joined `guestName` column, so the boundary
 *     is unknown. Send it VERBATIM as `reference_name`, a non-authoritative display
 *     label. The applicant supplies the screenable parts in the collect step.
 *
 * Never close that gap by splitting the joined name on whitespace to synthesize the
 * name components. See the `ApplicantInput` docs in `lib/checktiv-client`.
 *
 * The guest check-in link carries the durable `client_token` and the org's PUBLIC
 * publishable key (`ah_pk_...`) in the URL FRAGMENT, never the query string:
 * `/checkin/:id#ct=<clientToken>&pk=<publishableKey>`. The pk is the SDK's mount
 * scope on the guest page: only the pk scope sends `X-Publishable-Key`, which is
 * what lets sdk-api match the third-party guest origin against the key's allowlist
 * (the first-party region/mode scope is CORS-blocked cross-origin). A fragment is
 * never sent to a server, logged, or placed in a `Referer`, which keeps the bearer
 * `client_token` out of request logs; the pk is public, so the fragment is only to
 * co-locate it with the token.
 *
 * Recoverability (the no-dead-end rule): if the reservation is saved but the mint
 * fails (WTK flag off, invalid template, 422, network), the booking is left as a
 * `draft` with no `sessionId`, an actionable banner explains it, and the row
 * exposes a "Re-invite" action that re-runs ONLY the mint. Nothing is lost.
 *
 * Test vs live: the synthetic `expected_outcome` control is a TEST-mode feature,
 * so it renders only when `config.ctx.mode === 'test'`; live mode shows a cost
 * warning instead (real verifications run against the visitor's own org).
 *
 * Testability: the injectable `ReservationsView` takes its `store`, `client`, and
 * `config` as props (the default export wires the real singletons), so the flow is
 * unit-tested with typed mocks and no network.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

import { AppShell } from "../components/AppShell";
import { BookingForm, type BookingFormValues } from "../components/BookingForm";
import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { Label } from "../components/ui/label";

import {
	checktivClient,
	type ApplicantInput,
	type ChecktivClient,
} from "../lib/checktiv-client";
import { getConfig, clearConfig } from "../lib/config-store";
import { selectStore, type ReservationStore } from "../lib/reservation-store";
import type { DemoConfig } from "../../shared/checktiv-config";
import type { Reservation } from "../../shared/reservation-types";

/**
 * Synthetic test-mode verdict hints. Kept in sync BY HAND with Checktiv's wire
 * `testHintEnum` - no compile-time binding is possible across this package
 * boundary (the demo cannot import the private schema). The proxy forwards
 * `expectedOutcome` as an opaque, unvalidated string, so nothing enforces parity.
 */
type ExpectedOutcome = "pass" | "review" | "fail" | "doc_quality";

const EXPECTED_OUTCOME_OPTIONS: ReadonlyArray<{ value: ExpectedOutcome; label: string }> = [
	{ value: "pass", label: "Pass" },
	{ value: "review", label: "Needs review" },
	{ value: "fail", label: "Fail" },
	{ value: "doc_quality", label: "Document quality issue" },
];

/** Loading/ready/error machine for the reservation list. */
type ListState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; reservations: Reservation[] };

interface ReservationsViewProps {
	store: ReservationStore;
	/** Only `createSession` is used here; typed against the SDK contract. */
	client: Pick<ChecktivClient, "createSession">;
	config: DemoConfig;
}

/**
 * Remove every per-reservation guest check-in stash (`sessionStorage` keyed
 * `checkin:<id>`, written by `CheckInPage`). Part of the "Reset demo" full wipe so
 * no durable check-in token lingers after a reset. Collect keys first, then delete -
 * removing while iterating `sessionStorage` by index skips entries.
 */
function clearCheckInStashes(): void {
	const keys: string[] = [];
	for (let i = 0; i < sessionStorage.length; i++) {
		const key = sessionStorage.key(i);
		if (key && key.startsWith("checkin:")) keys.push(key);
	}
	for (const key of keys) sessionStorage.removeItem(key);
}

/**
 * Injectable inner component holding the list + booking flow. Rendered directly
 * by tests with mock deps; wrapped in `<AppShell>` by the default export below.
 */
export function ReservationsView({ store, client, config }: ReservationsViewProps) {
	const isTestMode = config.ctx.mode === "test";
	const [listState, setListState] = useState<ListState>({ status: "loading" });
	const [dialogOpen, setDialogOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [expectedOutcome, setExpectedOutcome] = useState<ExpectedOutcome>("pass");
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [retryingId, setRetryingId] = useState<string | null>(null);
	const [lastInvite, setLastInvite] = useState<{ reservationId: string; link: string } | null>(
		null,
	);
	const [copied, setCopied] = useState(false);
	// Confirm-gate for the destructive "Reset demo" action.
	const [resetOpen, setResetOpen] = useState(false);
	const navigate = useNavigate();

	const canClear = import.meta.env.VITE_PERSISTENCE === "local";

	// Async loader for the mount effect + post-action refreshes. It sets state ONLY
	// after the `await` (never synchronously in the effect body): the initial
	// `useState({status:'loading'})` covers the first render, and re-loads refresh the
	// list in place. Setting `loading` synchronously here would fire a cascading render
	// from inside the effect (react-hooks/set-state-in-effect); the explicit error
	// retry shows a fresh loading state via `retryLoad` (an event handler) instead.
	const loadList = useCallback(async () => {
		try {
			const reservations = await store.list();
			setListState({ status: "ready", reservations });
		} catch (error) {
			setListState({
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "We could not load your bookings. Try again.",
			});
		}
	}, [store]);

	// Explicit retry from the error state: an event-handler setState (not an effect
	// one) so it may show the loading state immediately before reloading.
	const retryLoad = useCallback(() => {
		setListState({ status: "loading" });
		void loadList();
	}, [loadList]);

	useEffect(() => {
		// Mount-time data fetch. `loadList` sets state ONLY after `await store.list()`
		// (asynchronously), never synchronously in this effect body, so it does not
		// cause the cascading render the rule guards against. The rule flags any effect
		// that calls a setState-containing function regardless of the await boundary
		// (a known over-flag on the standard load-on-mount pattern), so it is scoped-off
		// here rather than pulling in a data-fetching framework for a demo.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void loadList();
	}, [loadList]);

	/**
	 * Mint a session for an existing reservation and link it. Builds the fragment
	 * check-in link on success; throws on failure so the caller can surface a
	 * recoverable banner (the reservation is left untouched / still a draft).
	 */
	const mintFor = useCallback(
		async (reservationId: string, applicant: ApplicantInput) => {
			const result = await client.createSession(
				applicant,
				isTestMode ? { expectedOutcome } : undefined,
			);
			await store.update(reservationId, {
				sessionId: result.id,
				status: "invited",
			});
			const link = `/checkin/${reservationId}#ct=${encodeURIComponent(
				result.clientToken,
			)}&pk=${encodeURIComponent(config.publishableKey)}`;
			setLastInvite({ reservationId, link });
			setCopied(false);
		},
		[client, store, isTestMode, expectedOutcome, config.publishableKey],
	);

	/** Create the booking, then mint. A mint failure leaves the draft recoverable. */
	const handleBooking = useCallback(
		async (values: BookingFormValues) => {
			setSubmitting(true);
			setInviteError(null);
			setLastInvite(null);
			let created: Reservation | null = null;
			try {
				created = await store.create({
					guestName: `${values.firstName} ${values.lastName}`.trim(),
					guestEmail: values.email,
					property: values.property,
					checkIn: values.checkIn,
					checkOut: values.checkOut,
				});
				// The booking form captured the name as two SEPARATE inputs, so the
				// family/given boundary is the one the staff member typed, not one this
				// code inferred. That is the only reason it is safe to send the
				// structured pair here. Each field is omitted when blank rather than
				// sent as "", which the wire schema rejects.
				const familyName = values.lastName.trim();
				const givenName = values.firstName.trim();
				await mintFor(created.id, {
					...(familyName ? { family_name: familyName } : {}),
					given_names: givenName ? [givenName] : [],
					email: values.email,
				});
			} catch (error) {
				if (created) {
					// Booking saved but the invite could not be sent: keep it recoverable.
					setInviteError(
						`We saved the booking but could not send the check-in invite: ${
							error instanceof Error ? error.message : "the verification request failed"
						}. It is saved as a draft, use Re-invite to try again.`,
					);
				} else {
					setInviteError(
						`We could not save the booking: ${
							error instanceof Error ? error.message : "please try again"
						}.`,
					);
				}
			} finally {
				setDialogOpen(false);
				setSubmitting(false);
				await loadList();
			}
		},
		[store, mintFor, loadList],
	);

	/** Re-run ONLY the mint for a saved-but-unlinked draft reservation. */
	const handleReinvite = useCallback(
		async (reservation: Reservation) => {
			setRetryingId(reservation.id);
			setInviteError(null);
			try {
				// A saved reservation carries ONE joined `guestName` column, so this path
				// does NOT know where the family name begins. It goes verbatim to
				// `reference_name`, a non-authoritative display label, because that is
				// honestly all an unsplittable string is: the applicant supplies the
				// screenable family/given parts themselves in the collect step. Splitting
				// it here to refill the components is exactly the bug the ICAO shape
				// removes: it would mangle "Garcia Lopez", "van der Berg", and every
				// family-name-first booking.
				const referenceName = reservation.guestName.trim();
				await mintFor(reservation.id, {
					...(referenceName ? { reference_name: referenceName } : {}),
					email: reservation.guestEmail,
				});
				await loadList();
			} catch (error) {
				setInviteError(
					`Re-invite failed: ${
						error instanceof Error ? error.message : "the verification request failed"
					}. The booking is still saved as a draft, you can try again.`,
				);
			} finally {
				setRetryingId(null);
			}
		},
		[mintFor, loadList],
	);

	// "Reset demo" is a FULL reset (confirmed via the dialog below), not just a data
	// wipe: it clears the entered Checktiv keys/config, every booking, and every guest
	// check-in stash on this browser, then returns to Setup so the next visitor starts
	// clean. (An earlier version only wiped bookings, which felt like "nothing happened"
	// when the list was already empty.)
	const handleResetDemo = useCallback(async () => {
		await store.clear();
		clearConfig();
		clearCheckInStashes();
		setResetOpen(false);
		navigate("/setup", { replace: true });
	}, [store, navigate]);

	async function handleCopyLink(link: string) {
		try {
			await navigator.clipboard?.writeText(`${window.location.origin}${link}`);
			setCopied(true);
		} catch {
			// Clipboard blocked (permissions / insecure context): the link stays
			// visible on screen for manual copy, so this is not a dead-end.
			setCopied(false);
		}
	}

	return (
		<AppShell onResetDemo={canClear ? () => setResetOpen(true) : undefined}>
			{/*
			 * Confirm gate for "Reset demo". A full reset wipes the entered keys +
			 * bookings + check-in links and returns to Setup, so it is destructive and
			 * must not fire on an accidental click - hence the explicit confirm.
			 */}
			<Dialog open={resetOpen} onOpenChange={setResetOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Reset demo?</DialogTitle>
						<DialogDescription>
							This clears your Checktiv keys, all bookings, and every guest check-in link
							stored in this browser, then returns you to Setup. It cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={() => setResetOpen(false)}>
							Cancel
						</Button>
						<Button onClick={handleResetDemo}>Reset demo</Button>
					</div>
				</DialogContent>
			</Dialog>
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
					This is a sample property-management app that demonstrates the Checktiv
					identity-verification integration end to end. Create a booking to see how a
					verification session is minted and a guest check-in link is produced.
				</div>
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-semibold">Reservations</h1>
						<p className="text-sm text-muted-foreground">
							Create a booking to send the guest a verification check-in link.
						</p>
					</div>
					<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
						<DialogTrigger asChild>
							<Button>New booking</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>New booking</DialogTitle>
								<DialogDescription>
									Creating a booking mints a verification session and produces a guest
									check-in link.
								</DialogDescription>
							</DialogHeader>

							{isTestMode ? (
								<div className="grid gap-1.5">
									<Label htmlFor="expected-outcome">Expected verification outcome</Label>
									<select
										id="expected-outcome"
										value={expectedOutcome}
										onChange={(event) =>
											setExpectedOutcome(event.target.value as ExpectedOutcome)
										}
										className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
									>
										{EXPECTED_OUTCOME_OPTIONS.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
									<p className="text-xs text-muted-foreground">
										Test mode only: the verification returns this synthetic result instead
										of running a real check.
									</p>
								</div>
							) : (
								<div
									role="note"
									className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
								>
									<strong className="font-medium">Live mode.</strong> Real verifications run
									against your org, and this may incur cost. Use fake guest data only.
								</div>
							)}

							<BookingForm onSubmit={handleBooking} submitting={submitting} />
						</DialogContent>
					</Dialog>
				</div>

				{inviteError ? (
					<div
						role="alert"
						className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
					>
						{inviteError}
					</div>
				) : null}

				{lastInvite ? (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Guest check-in link ready</CardTitle>
							<CardDescription>
								Copy the link and send it to the guest to start their check-in. It carries a
								private access token, so treat it like a password and do not post it publicly.
							</CardDescription>
						</CardHeader>
						<CardContent className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => handleCopyLink(lastInvite.link)}
							>
								{copied ? "Copied!" : "Copy check-in link"}
							</Button>
							<Button variant="ghost" size="sm" asChild>
								<Link to={`/reservations/${lastInvite.reservationId}`}>View reservation</Link>
							</Button>
						</CardContent>
					</Card>
				) : null}

				<ReservationList
					listState={listState}
					retryingId={retryingId}
					onRetryLoad={retryLoad}
					onReinvite={handleReinvite}
				/>
			</div>
		</AppShell>
	);
}

/** The list body: loading / actionable error / empty / populated table. */
function ReservationList({
	listState,
	retryingId,
	onRetryLoad,
	onReinvite,
}: {
	listState: ListState;
	retryingId: string | null;
	onRetryLoad: () => void;
	onReinvite: (reservation: Reservation) => void;
}) {
	if (listState.status === "loading") {
		return <p className="text-sm text-muted-foreground">Loading reservations...</p>;
	}

	if (listState.status === "error") {
		return (
			<div
				role="alert"
				className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
			>
				<p className="font-medium">We could not load your bookings.</p>
				<p className="mt-1">{listState.message}</p>
				<Button variant="outline" size="sm" className="mt-3" onClick={onRetryLoad}>
					Retry
				</Button>
			</div>
		);
	}

	if (listState.reservations.length === 0) {
		return (
			<Card>
				<CardContent className="py-10 text-center text-sm text-muted-foreground">
					No bookings yet. Use "New booking" to create your first reservation and send a
					check-in invite.
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="p-0">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Guest</TableHead>
							<TableHead>Property</TableHead>
							<TableHead>Dates</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="text-right">Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{listState.reservations.map((reservation) => (
							<TableRow key={reservation.id}>
								<TableCell>
									<div className="font-medium">{reservation.guestName}</div>
									<div className="text-xs text-muted-foreground">{reservation.guestEmail}</div>
								</TableCell>
								<TableCell>{reservation.property}</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{reservation.checkIn} to {reservation.checkOut}
								</TableCell>
								<TableCell>
									<StatusChip status={reservation.status} />
								</TableCell>
								<TableCell className="text-right">
									{reservation.sessionId ? (
										<Button variant="ghost" size="sm" asChild>
											<Link to={`/reservations/${reservation.id}`}>View</Link>
										</Button>
									) : (
										<Button
											variant="outline"
											size="sm"
											disabled={retryingId === reservation.id}
											onClick={() => onReinvite(reservation)}
										>
											{retryingId === reservation.id ? "Sending..." : "Re-invite"}
										</Button>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

/**
 * Route entry: resolves the real store + config + client singletons. If no key has
 * been configured yet, it bootstraps the visitor to Setup rather than failing
 * mid-flow. There is no auth guard - this demo has no sign-in (see `main.tsx`).
 */
export default function ReservationsPage() {
	const store = useMemo(() => selectStore(), []);
	const config = getConfig();
	if (!config) {
		return <Navigate to="/setup" replace />;
	}
	return <ReservationsView store={store} client={checktivClient} config={config} />;
}
