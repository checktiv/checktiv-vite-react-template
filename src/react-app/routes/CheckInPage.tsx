/**
 * What this teaches / copy this pattern:
 * The unauthenticated guest check-in page, integrated with the SDK's React
 * provider component `<ChecktivJourney>` (`@checktiv/sdk-web/react`, >= 1.3.0) -
 * the idiomatic, zero-lifecycle React integration. You render ONE element with a
 * `publishableKey` and an async `fetchToken`, and it owns the ENTIRE mount/destroy
 * lifecycle: SSR-safe, StrictMode-safe, config-read-once, latest-handler dispatch.
 * There is NO `mount()`-in-`useEffect`, no `queueMicrotask` StrictMode guard, no
 * manual `handle.destroy()`, and no mount-target `<div>` to hand-build. Unmounting
 * the element (here: when the journey reaches a terminal state) tears the SDK down.
 *
 * The SDK renders the ENTIRE journey INSIDE that element - id_verification (camera
 * capture, biometric liveness) plus the consent-gated fraud signal module, all
 * provisioned server-side by the session's workflow template. The host builds no
 * step/confirm UI - the host is a thin shell. It owns only what wraps the journey:
 * the fraud CONSENT disclosure
 * (`onConsent`), navigation on SDK events (`onEvent` / `onComplete`), and the
 * durable-token security model below.
 *
 * `layout="immersive"` opts the phone capture surface into a full-viewport takeover
 * (verify-app parity), which is the point of the 1.3.0 bump; the SDK owns all of
 * that layout + a11y logic, so the host adds no stylesheet of its own. Color mode
 * comes from `<html data-theme="light">`, so there is no `theme` prop to pass.
 *
 * How tokens flow (the zero-lifecycle `fetchToken` path): `fetchToken` returns the
 * durable `client_token`; the SDK exchanges it for short-lived working tokens and
 * refreshes them INTERNALLY, so there is no browser-token endpoint or app-level
 * expiry branch to hand-build. The session declares the consent-gated `fraud`
 * module, so `onConsent` is REQUIRED: the host presents a disclosure and resolves it
 * with the applicant's choice; a deny keeps fraud off but lets the identity journey
 * proceed (fraud signals are supplemental). See `src/react-app/lib/sdk.ts`.
 *
 * Token handling (why the fragment, why the stash-before-strip):
 *   The check-in link is `/checkin/:id#ct=<clientToken>&pk=<publishableKey>`.
 *   `client_token` is a DURABLE, multi-day, resume-capable bearer capability, so
 *   it rides the URL FRAGMENT (never the query string): a fragment is never sent
 *   to a server, never logged, never placed in `Referer`. On first visit this page
 *     1. reads `{ ct, pk }` from `location.hash`,
 *     2. STASHES `{ clientToken, publishableKey }` in `sessionStorage` keyed by
 *        `:id` FIRST, and only THEN strips the fragment via `history.replaceState`,
 *   so an in-tab reload (which loses the fragment) still resumes: on remount the
 *   lazy `useState` seed (`resolveScope`) falls back to the stash, and `fetchToken`
 *   resolves from that render-captured `scope` rather than from a call-time
 *   `sessionStorage` read (a call-time read as the primary source would race the
 *   SDK's mount; a defensive stash fallback remains but is never the resolving path -
 *   see the `fetchToken` note below).
 *
 * Why the publishable key (not region/mode): the guest opens this page from a
 * THIRD-PARTY customer origin. Only the SDK's publishable-key scope sends
 * `X-Publishable-Key`, which is what lets sdk-api match the origin against the
 * key's allowlist and answer the CORS preflight; the first-party `{region,mode}`
 * scope never sends it, so a cross-origin flow is CORS-blocked. The pk is PUBLIC
 * (safe in the link + bundle) and the SDK parses region/mode FROM it.
 *
 * This route is intentionally NOT wrapped in `<GuardedRoute>`/`<AppShell>`: the
 * guest never authenticates and never sees the secret key or `DemoConfig`, so the
 * publishable key MUST arrive via the fragment. Every state (consent, cross-device
 * trigger, token-missing, mount/token-failure, complete) offers an actionable next
 * step - tokens expire, so the failure state is mandatory.
 *
 * Cross-device is SDK-NATIVE on this zero-lifecycle path (1.3.0+): the desktop guest
 * has no host-rolled QR. A `<ChecktivJourney>` `ref` exposes `openCrossDevice()`, and
 * the host renders a "Continue on your phone" trigger that calls it; the SDK then
 * MINTS the one-time link, opens its own QR overlay, runs the completion poll, and
 * fires `onComplete` when the phone finishes. The trigger is gated to a desktop
 * (fine-pointer) device: immersive phone capture and desktop cross-device are
 * mutually exclusive, so a phone applicant (coarse pointer) never sees it - and the
 * SDK itself warn-no-ops `openCrossDevice()` on a coarse pointer as a backstop.
 * `crossDeviceCopy` supplies every string the overlay renders; without it the SDK
 * cannot render the overlay. We deliberately do NOT pass `onOpenCrossDevice`: on the
 * working-token plane the SDK self-mints the link, which is exactly what this demo
 * wants. Because the overlay can also dead-end mid-flow (the session dies on the
 * phone, or the completion poll caps out), `onEvent` recovers both so the desktop is
 * never a silent dead-end: a `session_expired` error routes to the terminal failure
 * surface, and `checktiv.idv.cross_device_capped` surfaces a RECOVERABLE "still waiting"
 * hint WITHOUT tearing the journey down (the overlay stays mounted so the phone can still
 * finish) - with a "Keep checking" control that re-arms a fresh completion poll via
 * `openCrossDevice()` (never a reload, which would 404 the null-cursor mount plane).
 *
 * The `@checktiv/sdk-web/idv` + `/fraud` side-effect imports self-register the
 * journey modules the session's workflow template provisions; without them the SDK
 * throws a loud `sdk_load_failed` at runtime. `@checktiv/sdk-web/idv/cross-device`
 * registers the overlay opener so `openCrossDevice()` renders the QR panel rather
 * than warn-no-opping about a missing subpath import (the CDN bundle registers it
 * automatically, but an npm/bundler app must import it once).
 */
import "@checktiv/sdk-web/idv";
import "@checktiv/sdk-web/fraud";
import "@checktiv/sdk-web/idv/cross-device";
// The Tier-2 capture frame is styled entirely by a stylesheet the SDK's build
// (tsup) EXTRACTS to `dist/capture-ui.css` and STRIPS the source
// `import './capture-ui.css'` from the built JS. So importing `.../idv` does NOT
// pull the styles: consumers of the managed IDV module MUST import the stylesheet
// explicitly or the capture frame renders unstyled (a tiny/collapsed box). This is
// the single place the SDK capture frame mounts, so the import is co-located here.
import "@checktiv/sdk-web/capture-ui/style.css";
import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { ChecktivJourney, type ChecktivJourneyHandle } from "@checktiv/sdk-web/react";
import type { ChecktivEvent, ChecktivIdvEvent, CrossDeviceCopy } from "@checktiv/sdk-web";
import { isValidPublishableKey } from "../../shared/checktiv-config";
import { Footer } from "../components/Footer";
import { Button } from "../components/ui/button";
import {
	CheckInCollectForm,
	type CheckInCollectPrefill,
} from "../components/CheckInCollectForm";
import { devCellSdkApiBase } from "../lib/dev-cell";

/** The durable capability threaded to the SDK: the token plus the cell's pk. */
interface CheckInScope {
	readonly clientToken: string;
	readonly publishableKey: string;
}

/**
 * Every user-facing string the SDK's cross-device overlay renders. `unavailableMessage`
 * is the only REQUIRED key (so the unavailable state is never blank); the others are
 * optional and, when omitted, HIDE their affordance rather than showing a placeholder,
 * so this demo supplies the desktop-facing set. Authored as US-English strings with no
 * m-dashes and no third-party vendor names (the overlay is applicant-facing copy).
 */
const CROSS_DEVICE_COPY: CrossDeviceCopy = {
	desktopPrompt: "Continue on your phone",
	desktopSubtext:
		"Scan this code with your phone's camera to finish your ID check there. This page updates on its own once you are done.",
	qrAlt: "QR code to continue your check-in on your phone",
	waitingLabel: "Waiting for your phone to finish...",
	copyLinkLabel: "Copy link",
	linkCopiedLabel: "Link copied",
	refreshLinkLabel: "Get a new code",
	backLabel: "Back",
	unavailableMessage:
		"We could not start the phone handoff. Try again, or finish your check-in on a device with a working camera.",
};

/** `sessionStorage` key: the stash is per reservation `:id` so tabs do not collide. */
function stashKey(id: string): string {
	return `checkin:${id}`;
}

/** Parse `#ct=..&pk=..` into a validated scope, or null if either is missing/malformed. */
function parseHashScope(hash: string): CheckInScope | null {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const clientToken = params.get("ct");
	const publishableKey = params.get("pk");
	if (!clientToken || !publishableKey) return null;
	if (!isValidPublishableKey(publishableKey)) return null;
	return { clientToken, publishableKey };
}

/** Read the per-`:id` stash, validating its shape so a stale/foreign value is ignored. */
function readStash(id: string): CheckInScope | null {
	try {
		const raw = sessionStorage.getItem(stashKey(id));
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		const { clientToken, publishableKey } = record;
		if (typeof clientToken !== "string" || !clientToken) return null;
		if (typeof publishableKey !== "string" || !isValidPublishableKey(publishableKey)) return null;
		return { clientToken, publishableKey };
	} catch {
		return null;
	}
}

function writeStash(id: string, scope: CheckInScope): void {
	sessionStorage.setItem(stashKey(id), JSON.stringify(scope));
}

/** Drop the fragment from the address bar WITHOUT a navigation or re-render. */
function stripFragment(): void {
	window.history.replaceState(
		null,
		"",
		window.location.pathname + window.location.search,
	);
}

/** Narrow an event to the IDV error arm (the only arm carrying a `ChecktivError`). */
function isIdvError(
	event: ChecktivEvent,
): event is Extract<ChecktivIdvEvent, { type: "checktiv.idv.error" }> {
	return event.type === "checktiv.idv.error";
}

/**
 * A journey-ending failure. A NON-recoverable id_verification error is terminal, as is
 * a `session_expired` error (its session cannot be resumed - it surfaces when a
 * cross-device handoff dies on the phone, or a durable token lapses). Recoverable IDV
 * errors that are NOT `session_expired` (camera retry) are handled inside the SDK's own
 * UI, and fraud errors never end the journey (fraud is supplemental).
 */
function isTerminalError(event: ChecktivEvent): boolean {
	if (!isIdvError(event)) return false;
	return event.error.recoverable === false || event.error.code === "session_expired";
}

/** Narrow an event to the IDV "processing" arm (the only arm carrying an optional `reason`). */
function isIdvProcessing(
	event: ChecktivEvent,
): event is Extract<ChecktivIdvEvent, { type: "checktiv.idv.processing" }> {
	return event.type === "checktiv.idv.processing";
}

/**
 * The applicant has nothing left to do on screen. The SDK emits a NON-error
 * `checktiv.idv.processing` with `reason: "no_renderable_step"` when the current step is a
 * server-side-only check (e.g. a background check) that has no applicant UI: the details are
 * already submitted and verification now runs on its own. This is TERMINAL for the applicant.
 * The other `reason` (`"signal_pending"`, or a reasonless legacy processing event) is a
 * transient reload-safe race and is DELIBERATELY excluded, so it never routes here.
 */
function isNoRenderableStep(event: ChecktivEvent): boolean {
	return isIdvProcessing(event) && event.reason === "no_renderable_step";
}

/**
 * The cross-device completion poll reached its time cap without the phone finishing.
 * Per the SDK contract this is NOT an error and NOT a verdict: the SDK keeps its QR
 * overlay mounted so the applicant can still finish on their phone. The host surfaces a
 * "still waiting" hint rather than treating it as failure, so it is complementary to
 * `terminal` (never terminal itself). At the cap the SDK STOPS polling, so the hint is
 * RECOVERABLE: a "Keep checking" control re-arms a fresh poll via `openCrossDevice()`
 * (see `rearmCrossDevice`), never a page reload.
 */
function isCrossDeviceCapped(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_capped";
}

/**
 * The SDK opened its own cross-device QR overlay in response to `openCrossDevice()`.
 * The host hides its quiet "Continue on your phone" trigger while this overlay owns the
 * screen so the two never compete for attention.
 */
function isCrossDeviceOpened(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_opened";
}

/**
 * The SDK could not start the cross-device handoff (the one-time-link mint failed), so
 * NO overlay was shown. The host re-enables its trigger so the applicant can try again.
 */
function isCrossDeviceUnavailable(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_unavailable";
}

/** The SDK signals a finished identity capture with `checktiv.idv.submitted`. */
function isJourneyComplete(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.submitted";
}

/**
 * True on a desktop / fine-pointer device: the "Continue on your phone" trigger is
 * shown only here. Gated on the ABSENCE of a coarse (touch) pointer, so a device with
 * no pointer-media support (or SSR, where `window` is undefined) hides the trigger
 * rather than offering a circular phone-to-phone handoff. Immersive phone capture and
 * desktop cross-device are mutually exclusive; this gate keeps a phone applicant from
 * ever seeing the trigger (the SDK also warn-no-ops `openCrossDevice()` on a coarse
 * pointer as a backstop).
 */
function isDesktopPointer(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return !window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Resolve the check-in scope from the URL: prefer the fragment (first visit),
 * fall back to the per-`:id` stash (in-tab reload). Pure read (no writes/strip) so
 * it can run during render - the side effects (stash + strip) happen in the effect.
 */
function resolveScope(id: string | undefined, hash: string): CheckInScope | null {
	if (!id) return null;
	return parseHashScope(hash) ?? readStash(id);
}

/**
 * Split a full guest name into a best-effort first / last for the prefilled name row.
 * The guest reviews and edits it, so an imperfect split is fine: the first whitespace
 * token is the first name, the remainder (if any) is the last name.
 */
function splitGuestName(fullName: string): { first: string; last: string } {
	const parts = fullName.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { first: "", last: "" };
	if (parts.length === 1) return { first: parts[0], last: "" };
	return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Build the collect prefill from a guest-safe reservation read (empty when absent). */
function toPrefill(data: { guestName: string; guestEmail: string } | null): CheckInCollectPrefill {
	if (!data) return { legalName: "", first: "", last: "", email: "" };
	const { first, last } = splitGuestName(data.guestName);
	return { legalName: data.guestName, first, last, email: data.guestEmail };
}

/**
 * Fetch the guest-safe prefill for this reservation from the same-origin worker
 * (`GET /api/checkin/:id` -> `{ guestName, guestEmail }`). This is a convenience only:
 * any failure (deployed no-D1 shape returns 501, an unknown id returns 404, a network
 * error, or a malformed body) resolves to `null` so the collect form renders with empty
 * fields the guest fills in - it NEVER blocks the journey.
 */
async function fetchCheckInPrefill(
	id: string,
): Promise<{ guestName: string; guestEmail: string } | null> {
	try {
		const res = await fetch(`/api/checkin/${encodeURIComponent(id)}`, {
			headers: { accept: "application/json" },
		});
		if (!res.ok) return null;
		const body: unknown = await res.json();
		if (typeof body !== "object" || body === null) return null;
		const record = body as Record<string, unknown>;
		const guestName = typeof record.guestName === "string" ? record.guestName : "";
		const guestEmail = typeof record.guestEmail === "string" ? record.guestEmail : "";
		return { guestName, guestEmail };
	} catch {
		return null;
	}
}

export default function CheckInPage() {
	const { id } = useParams();
	const location = useLocation();

	// Resolve the durable capability ONCE, in a lazy initializer (the React-blessed
	// spot to read an external store). Deriving token-presence here - rather than
	// writing it via `setState` inside the effect - keeps the no-token screen a pure
	// function of the URL and avoids react-hooks/set-state-in-effect cascades.
	const [scope] = useState<CheckInScope | null>(() => resolveScope(id, location.hash));
	// Terminal outcomes the SDK drives via its callbacks: `complete` on
	// `checktiv.idv.submitted` / `onComplete`, `error` on a non-recoverable IDV error
	// (or a `session_expired`, e.g. a cross-device handoff that died on the phone), and
	// `submitted` on a `checktiv.idv.processing` with `reason: "no_renderable_step"` (the
	// details are in and the next check runs server-side with no applicant screen).
	const [terminal, setTerminal] = useState<"complete" | "error" | "submitted" | null>(null);
	// The collect gate that precedes the SDK identity journey. The applicant confirms
	// their details (prefilled from the reservation) and the SDK submits them; only then
	// does `<ChecktivJourney>` mount. `prefill` is the guest-safe reservation read;
	// `prefillReady` flips once that fetch settles (resolved OR failed) so the form seeds
	// its fields exactly once. A failed/absent prefill still readies the form (empty).
	const [collectDone, setCollectDone] = useState(false);
	const [prefill, setPrefill] = useState<CheckInCollectPrefill>(() => toPrefill(null));
	const [prefillReady, setPrefillReady] = useState(false);
	// The cross-device completion poll capped out while the SDK overlay is still open.
	// Complementary to `terminal` (never terminal): the overlay stays mounted so the
	// applicant can still finish on their phone; this only surfaces a "still waiting" hint.
	const [stillWaiting, setStillWaiting] = useState(false);
	// The fraud consent gate. `consentPending` shows the disclosure card; the SDK's
	// `onConsent` call parks on a promise whose resolver we stash here, so the
	// applicant's Allow/Not-now click resolves it.
	const [consentPending, setConsentPending] = useState(false);
	const consentResolveRef = useRef<((granted: boolean) => void) | null>(null);
	// Tracks whether the SDK's own cross-device QR overlay is on screen. The SDK fires
	// `cross_device_opened` when it mounts the overlay and `cross_device_unavailable` when
	// the mint fails (so no overlay shows). We use this to hide the host's quiet trigger
	// while the overlay owns the screen. NOTE: the SDK emits NO close/back event, so once
	// the overlay opens we deliberately leave the trigger hidden for the rest of the
	// journey - which is exactly what the no-camera desktop case wants.
	const [overlayOpen, setOverlayOpen] = useState(false);
	// A handle onto the SDK journey so the desktop "Continue on your phone" trigger can
	// call `openCrossDevice()`. The SDK owns the mint + QR overlay + completion poll.
	const journeyRef = useRef<ChecktivJourneyHandle>(null);
	// Focus target for the consent modal: focus moves to "Allow" when the dialog opens.
	const allowButtonRef = useRef<HTMLButtonElement>(null);
	// Desktop-only gate for the cross-device trigger (see `isDesktopPointer`).
	const isDesktop = isDesktopPointer();

	function resolveConsent(granted: boolean): void {
		setConsentPending(false);
		const resolve = consentResolveRef.current;
		consentResolveRef.current = null;
		resolve?.(granted);
	}

	// The ONLY side effect the host still owns: stash the durable scope BEFORE
	// stripping the fragment, so a fragment-less in-tab reload still resumes.
	// `<ChecktivJourney>` owns the SDK mount/destroy lifecycle - there is nothing else
	// to do here.
	useEffect(() => {
		if (!id || !scope) return;
		writeStash(id, scope);
		if (parseHashScope(location.hash)) stripFragment();
		// `location.hash` is read once (to strip the fragment) but DELIBERATELY excluded
		// from the deps: `stripFragment()` mutates the hash, and re-running on that change
		// would re-write the stash needlessly. The durable scope is already captured in
		// `scope` (a lazy `useState`), so the effect is keyed on `id`+`scope`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id, scope]);

	// Fetch the guest-safe prefill for the collect gate. Runs once a scope is resolved
	// (the guest holds a valid link). Any failure resolves to an empty prefill and still
	// readies the form, so the collect step never blocks on this convenience read.
	useEffect(() => {
		if (!id || !scope) return;
		let cancelled = false;
		void fetchCheckInPrefill(id).then((data) => {
			if (cancelled) return;
			setPrefill(toPrefill(data));
			setPrefillReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, [id, scope]);

	// `fetchToken` returns the BARE token STRING (the SDK's pinned `() => Promise<string>`
	// contract). It resolves from `scope` - the durable capability captured SYNCHRONOUSLY
	// at first render by the lazy `useState` above (fragment on a fresh open, stash on an
	// in-tab reload). It must not depend on a call-time `sessionStorage` read as its
	// primary source here: the SDK calls `fetchToken`
	// synchronously from inside `<ChecktivJourney>`'s OWN mount effect, and React fires
	// that CHILD effect BEFORE this page's PARENT stash-write effect - so a stash read
	// would race the write and throw "Missing check-in token" on a fresh open (the
	// intermittent "could not start your check-in"). `scope` is already resolved before
	// any effect runs, and the journey (hence `fetchToken`) is live only while `scope` is
	// non-null, so it is always present here; the stash fallback is defensive only.
	const fetchToken = async (): Promise<string> => {
		const current = scope ?? (id ? readStash(id) : null);
		if (!current) throw new Error("Missing check-in token");
		return current.clientToken;
	};

	// The SDK calls `onConsent` when the session declares the fraud module. We park on
	// a promise, show the disclosure card, and let the applicant's click resolve it
	// (grant -> start fraud signals; deny -> proceed without them).
	const onConsent = (): Promise<boolean> =>
		new Promise<boolean>((resolve) => {
			consentResolveRef.current = resolve;
			setConsentPending(true);
		});

	// Navigation on SDK events. A non-recoverable IDV error (or a `session_expired`,
	// e.g. a cross-device handoff that died on the phone) is terminal; a cross-device
	// completion-poll cap surfaces a non-terminal "still waiting" hint (the SDK overlay
	// stays open). `checktiv.idv.submitted` also completes the journey (so a consumer
	// wiring only `onEvent` still finishes); `onComplete` below is the canonical
	// completion signal and sets the same terminal state (idempotent).
	const onEvent = (event: ChecktivEvent): void => {
		if (isJourneyComplete(event)) setTerminal("complete");
		// A server-side-only next step (no applicant UI) is TERMINAL for the applicant: the
		// details are in and verification runs on its own. NOT an error, and NOT the transient
		// reload-safe `signal_pending` processing variant (which stays live).
		else if (isNoRenderableStep(event)) setTerminal("submitted");
		else if (isTerminalError(event)) setTerminal("error");
		else if (isCrossDeviceCapped(event)) setStillWaiting(true);
		// The SDK opened its QR overlay: hide the host trigger so they never compete. The
		// SDK fires no close/back event, so once opened the trigger stays hidden for the
		// rest of the journey (correct for the no-camera desktop case).
		else if (isCrossDeviceOpened(event)) setOverlayOpen(true);
		// The mint failed and no overlay was shown, so re-enable the trigger to retry.
		else if (isCrossDeviceUnavailable(event)) setOverlayOpen(false);
	};

	// Recover a capped cross-device wait (self-serve, no dead-end). When the completion
	// poll hits its time cap the SDK STOPS polling (its QR overlay stays mounted, but the
	// page would no longer auto-update). Re-arm by re-opening cross-device: the SDK mints a
	// fresh link, remounts the overlay, and starts a NEW completion poll, so the desktop
	// syncs again once the phone finishes. This is deliberately NOT a page reload: the
	// zero-lifecycle mount plane on a null cursor (a phone IDV that moved to review) would
	// 404 -> `session_expired`, a false dead-end. `openCrossDevice()` re-polls the
	// status endpoint instead.
	const rearmCrossDevice = (): void => {
		setStillWaiting(false);
		journeyRef.current?.openCrossDevice();
	};

	// Phase is DERIVED from render state: a terminal outcome wins; otherwise a resolvable
	// scope gates on the collect step first (`collect`) and then the SDK identity journey
	// (`active`), and no scope means the link is incomplete. The collect gate precedes the
	// journey mount; it does not replace any of the consent / cross-device / terminal
	// logic below, which all key off the `active` journey.
	const phase: "complete" | "error" | "submitted" | "no-token" | "collect" | "active" =
		terminal ?? (scope ? (collectDone ? "active" : "collect") : "no-token");
	// The consent card is an overlay gate shown DURING the active journey; a terminal
	// outcome hides it.
	const showConsent = consentPending && terminal === null;
	// The "still waiting" hint is complementary to the SDK's own cross-device overlay; a
	// terminal outcome still wins (hides it).
	const showStillWaiting = stillWaiting && terminal === null;

	// Move focus to "Allow" when the consent dialog opens, so a keyboard/AT user lands on
	// the primary action. Focusing is idempotent (StrictMode double-invoke safe) and the
	// optional-chained call no-ops if the button has not mounted yet.
	useEffect(() => {
		if (showConsent) allowButtonRef.current?.focus();
	}, [showConsent]);

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<div className="flex flex-1 flex-col items-center px-4 py-8">
			<div className="w-full max-w-md space-y-6">
				<header className="space-y-1 text-center">
					<h1 className="text-xl font-semibold text-foreground">Guest check-in</h1>
					<p className="text-sm text-muted-foreground">
						Confirm your details and verify your identity to complete check-in.
					</p>
				</header>

				{showStillWaiting ? (
					<div className="rounded-md border border-border bg-muted/40 p-4 text-center">
						<h2 className="text-sm font-medium text-foreground">Still waiting for your phone</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Finish the ID check on your phone using the code on screen. If you have not
							finished yet, choose "Keep checking" to reopen the code and keep this page in
							sync.
						</p>
						<button
							type="button"
							className="mt-3 inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
							onClick={rearmCrossDevice}
						>
							Keep checking
						</button>
					</div>
				) : null}

				{phase === "no-token" ? (
					<div className="rounded-lg border border-border bg-card p-6 text-center text-card-foreground">
						<h2 className="text-base font-medium">Your check-in link is incomplete</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							This page needs the secure check-in link sent to you. Reopen the check-in
							link from your reservation confirmation to continue.
						</p>
					</div>
				) : null}

				{phase === "error" ? (
					<div className="rounded-lg border border-border bg-card p-6 text-center text-card-foreground">
						<h2 className="text-base font-medium">We could not start your check-in</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Your check-in link may have expired. Contact the property to get a fresh
							link, then open it again to finish your check-in.
						</p>
					</div>
				) : null}

				{phase === "complete" ? (
					<div className="rounded-lg border border-border bg-card p-6 text-center text-card-foreground">
						<h2 className="text-base font-medium">Check-in complete</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Thanks. Your identity check is complete and the property has been notified.
							You can close this window.
						</p>
					</div>
				) : null}

				{phase === "submitted" ? (
					<div className="rounded-lg border border-border bg-card p-6 text-center text-card-foreground">
						<h2 className="text-base font-medium">Details submitted</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Your details were submitted. Verification is now in progress, and nothing
							more is needed from you right now. The property will reach out if anything
							else is required. You can close this window.
						</p>
					</div>
				) : null}

				{/*
				 * The SDK-rendered journey. `<ChecktivJourney>` owns the whole mount/destroy
				 * lifecycle: rendering it starts the journey, unmounting it (when `phase`
				 * leaves `"active"` on a terminal outcome) tears the SDK down. It renders only
				 * while a scope is resolved and the journey is not terminal; the "still waiting"
				 * hint above and the consent modal below overlay it without unmounting it. The
				 * `ref` exposes `openCrossDevice()` for the desktop trigger; `crossDeviceCopy`
				 * supplies the overlay's strings (`onOpenCrossDevice` is deliberately omitted
				 * so the SDK self-mints the handoff link on the working-token plane).
				 */}
				{/*
				 * The collect gate that precedes the journey: a prefilled "confirm your
				 * details" form (see `CheckInCollectForm`). The applicant reviews the
				 * details prefilled from their reservation, adds the rest, and confirms; the
				 * SDK submits them programmatically. On success (or when the session has no
				 * collect step, `not_collect_step`) `onComplete` flips `collectDone`, which
				 * advances the phase to `active` and mounts the journey below. Rendered only
				 * once the prefill read has settled so the form seeds its fields exactly
				 * once (a brief, actionable loading line otherwise, never a dead-end).
				 */}
				{phase === "collect" && scope ? (
					prefillReady ? (
						<CheckInCollectForm
							publishableKey={scope.publishableKey}
							fetchToken={fetchToken}
							sdkApiBase={devCellSdkApiBase()}
							prefill={prefill}
							onComplete={() => setCollectDone(true)}
						/>
					) : (
						<div className="rounded-md border border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
							Loading your details...
						</div>
					)
				) : null}

				{phase === "active" && scope ? (
					<ChecktivJourney
						ref={journeyRef}
						publishableKey={scope.publishableKey}
						fetchToken={fetchToken}
						apiBase={devCellSdkApiBase()}
						onConsent={onConsent}
						onEvent={onEvent}
						onComplete={() => setTerminal("complete")}
						crossDeviceCopy={CROSS_DEVICE_COPY}
						layout="immersive"
					/>
				) : null}

				{/*
				 * Desktop-only "Continue on your phone" fallback, DEMOTED to a quiet link below
				 * the journey so it never competes with the primary capture flow. It calls the
				 * SDK-native `openCrossDevice()` through the journey `ref`: the SDK mints the
				 * one-time link, opens its own QR overlay, and reloads this page (via
				 * `onComplete`) when the phone finishes. Gated to a fine-pointer device so a
				 * phone applicant (who gets immersive capture) never sees it, and hidden while
				 * the SDK's QR overlay is already open (`overlayOpen`) or the consent modal is
				 * up (`showConsent`) so it never competes for attention.
				 */}
				{phase === "active" && isDesktop && !overlayOpen && !showConsent ? (
					<div className="text-center">
						<button
							type="button"
							className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
							onClick={() => journeyRef.current?.openCrossDevice()}
						>
							Camera trouble? Continue on your phone
						</button>
					</div>
				) : null}
			</div>
			</div>
			<Footer />

			{/*
			 * Fraud CONSENT gate, rendered as a centered modal dialog that overlays the whole
			 * page (rather than an inline column card) so the applicant makes an explicit
			 * Allow / Not now choice before the fraud module starts. Gated on the same
			 * `showConsent` condition. There is deliberately NO backdrop-dismiss and NO Escape
			 * handler: the applicant MUST choose. Focus moves to "Allow" on open (see effect).
			 */}
			{showConsent ? (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
					role="dialog"
					aria-modal="true"
					aria-labelledby="consent-title"
				>
					<div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg">
						<h2 id="consent-title" className="text-sm font-medium text-foreground">
							Before you continue
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							To help prevent fraud, we check device and connection signals while you
							verify your identity. Your ID photos are captured and stored to complete
							verification. If you have questions about your data, contact the property
							that sent you this link. You can decline the fraud check and still finish
							your check-in.
						</p>
						<div className="mt-4 flex gap-2">
							<Button
								ref={allowButtonRef}
								type="button"
								variant="outline"
								size="sm"
								onClick={() => resolveConsent(true)}
							>
								Allow
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => resolveConsent(false)}
							>
								Not now
							</Button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
