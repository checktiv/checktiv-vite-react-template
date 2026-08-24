/**
 * What this teaches / copy this pattern:
 * The unauthenticated guest check-in page, integrated with the SDK's React
 * provider component `<ChecktivJourney>` (`@checktiv/sdk-web/react`, `>= 1.9.0` - see
 * the floor note at the end) - the idiomatic, zero-lifecycle React integration. You
 * render ONE element with a
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
 * (verify-app parity); the SDK owns all of that layout + a11y logic, so the host adds
 * no stylesheet of its own. Color mode comes from `<html data-theme="light">`, so there
 * is no `theme` prop to pass.
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
 * This route is intentionally NOT wrapped in `<AppShell>`: it is the guest's page,
 * not a staff one, and the guest never sees the secret key or `DemoConfig`, so the
 * publishable key MUST arrive via the fragment. Every state (consent, cross-device
 * trigger, token-missing, mount/token-failure, submitted) offers an actionable next
 * step - tokens expire, so the failure state is mandatory.
 *
 * COMPLETION IS NOT A VERDICT. This is the rule most likely to be broken by a host
 * copying this page, so it is stated here and enforced in the copy below. Every
 * terminal signal the browser gets - `checktiv.idv.submitted`, `onComplete`, a
 * `processing` step with `reason: "no_renderable_step"` - means the applicant
 * FINISHED THEIR PART. None of them means they passed. The pass / fail /
 * needs-review decision is made server-side after capture and reaches YOUR backend
 * on the signed `kyc.session.*` webhook, which is the only outcome anchor; a client
 * event is not one, and neither is a polled session status (`completed` is a
 * lifecycle status that carries a separate `outcome` field). So the applicant-facing
 * terminal card below says the ID was SUBMITTED and is being reviewed, and it must
 * stay that way: a page that congratulates a guest on passing will do so for a guest
 * who was declined. This demo has no server to receive the webhook, so it never
 * learns the outcome at all - which is exactly why it must not imply one.
 *
 * Cross-device is SDK-NATIVE on this zero-lifecycle path: the desktop guest
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
 * The handoff REPLACES the capture surface (`overlayOpen` -> `data-checkin-handoff`,
 * see `./CheckInPage.css`): showing a camera capture and a "scan this with your phone"
 * panel at the same time asks the applicant to do two contradictory things. It is a
 * CSS swap, not an unmount, because the SDK appends its QR overlay INSIDE the journey's
 * own DOM and owns the completion poll - unmounting `<ChecktivJourney>` would destroy
 * both at the moment they are needed. The swap is only safe BECAUSE the SDK emits
 * `checktiv.idv.cross_device_closed` when the applicant backs out (see
 * `isCrossDeviceClosed`): without wiring that, hiding the capture on `overlayOpen`
 * would strand an applicant who closed the QR panel with no capture and no way back.
 *
 * That safety condition is exactly why the capture surface is NOT hidden on
 * `cross_device_unavailable`. The SDK still mounts a panel there, but its unavailable arm
 * renders one paragraph and no control at all, so no `cross_device_closed` can ever
 * follow. Hiding the capture behind it would be the strand case above with no way out.
 * The page restores the capture and retires the trigger instead (see `handoffSpent`) -
 * the rule to take from this is that "hide the host surface while the SDK owns the
 * screen" is only ever safe for SDK states that can hand the screen BACK.
 *
 * The `@checktiv/sdk-web/idv` + `/fraud` side-effect imports self-register the
 * journey modules the session's workflow template provisions.
 *
 * Get one of them wrong and the SDK does NOT throw. It EMITS a
 * `checktiv.idv.error` / `checktiv.fraud.error` carrying code `sdk_load_failed` and
 * message "This session requires the 'idv' module. Import '@checktiv/sdk-web/idv' in
 * your app.", then moves on. Nothing propagates to a `try/catch` or an error boundary,
 * so it is only as loud as YOUR `onEvent` makes it - and `sdk_load_failed` is
 * `recoverable: true` in the SDK's error table, so it is not terminal and this page's
 * `onEvent` chain below matches no arm on it: the applicant would sit on a blank journey.
 * That is the honest description of the demo's own handler, and it is the single most
 * likely error at integration time, so treat the module doc's silence about it as a gap
 * to close in YOUR app: log every `checktiv.*.error` you do not route, at minimum.
 * `onEvent` is also the COMPLETE error stream on this path - the SDK's React wrapper
 * does not forward an `onError` prop to the journey, so wiring only `onError` would
 * surface nothing.
 *
 * `@checktiv/sdk-web/idv/cross-device` registers the overlay opener so
 * `openCrossDevice()` renders the QR panel rather than warn-no-opping about a missing
 * subpath import (the CDN bundle registers it automatically, but an npm/bundler app must
 * import it once).
 *
 * SDK VERSION FLOOR: `>= 1.9.0`, matching the `package.json` range, and stated once here
 * rather than per feature so it cannot rot into a set of disagreeing numbers. The floor
 * is not decorative: below 1.6.0 there is no `cross_device_closed` event, so hiding the
 * capture surface behind the handoff (the `data-checkin-handoff` mechanism) becomes the
 * dead end it is designed to avoid, a capped poll cannot be re-armed, and
 * `collector.describe()` (the collect step's field-config probe) does not exist.
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
// One host-owned rule: hide the SDK's capture surface while its cross-device QR panel
// owns the screen, so the handoff REPLACES the camera rather than stacking beside it.
// Imported AFTER the SDK stylesheet it overrides. See the file for the full rationale.
import "./CheckInPage.css";
import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { ChecktivJourney, type ChecktivJourneyHandle } from "@checktiv/sdk-web/react";
import type {
	ChecktivError,
	ChecktivEvent,
	ChecktivIdvEvent,
	CrossDeviceCopy,
} from "@checktiv/sdk-web";
import { isValidPublishableKey } from "../../shared/checktiv-config";
import { Footer } from "../components/Footer";
import { Button } from "../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
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
 *
 * `unavailableMessage` is the whole unavailable panel: that arm renders this paragraph
 * and NOTHING else, no Back and no Try again (see `isCrossDeviceUnavailable`). So it must
 * not offer an action the applicant cannot take from it. It points back at the capture
 * surface this page restores underneath, which is the one thing they can still do.
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
		"We could not move your check-in to your phone. Please finish your ID check here on this device, using the camera below. If your camera is not working, reopen your check-in link on a device that has one.",
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
 * A journey-ending failure. `error.recoverable === false` is the rule, and the SDK's own
 * error table is the authority on it: in 1.9.0 the non-recoverable codes are
 * `origin_not_allowed`, `session_expired`, `wrong_token_type`, `protocol_mismatch`,
 * `camera_policy_blocked`, `biometric_unsupported` and `isolation_required`.
 *
 * The `code === "session_expired"` clause is REDUNDANT TODAY and is kept deliberately, so
 * do not read it as evidence that the SDK sends that code as recoverable - it does not
 * (`recoverable: false` in the table above; it is the code that surfaces when a
 * cross-device handoff dies on the phone or a durable token lapses). It is belt and
 * braces for one specific regression: an expired session cannot be resumed no matter how
 * the flag is set, so if a future table ever marked it recoverable this page would
 * otherwise strand the applicant on a dead session with no terminal screen.
 *
 * The `recoverable: true` codes are deliberately NOT terminal: the capture ones
 * (`cv_gate_failed`, `upload_failed`, `submit_failed`, `camera_denied`,
 * `camera_unsupported`, `token_expired`) have retry affordances inside the SDK's own
 * capture UI. `sdk_load_failed` is the one that does not - see the module doc's note on
 * the side-effect module imports. Fraud errors never end the journey (fraud is
 * supplemental).
 */
function isTerminalError(event: ChecktivEvent): boolean {
	if (!isIdvError(event)) return false;
	return event.error.recoverable === false || event.error.code === "session_expired";
}

/**
 * Narrow an event to ANY arm carrying a `ChecktivError` (`checktiv.idv.error` and
 * `checktiv.fraud.error` today). Used only by the unrouted-error log at the end of
 * `onEvent`, so an SDK failure this page does not route to a screen still leaves a trace.
 */
function isSdkErrorEvent(
	event: ChecktivEvent,
): event is Extract<ChecktivEvent, { error: ChecktivError }> {
	return "error" in event;
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
 * The overlay is now the applicant's whole task, so the host both hides its quiet
 * "Continue on your phone" trigger and hides the camera capture surface underneath -
 * a capture frame and a "scan this with your phone" panel on screen together ask for
 * two contradictory things. Paired with `isCrossDeviceClosed` below, which is what
 * lets the capture surface come back.
 */
function isCrossDeviceOpened(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_opened";
}

/**
 * The applicant dismissed the cross-device overlay (its "Back" control on desktop, or
 * "Try again" on the mint-failure / chunk-load-failure arms). The SDK tears the panel
 * down and the capture surface is still mounted underneath, so the host restores it
 * along with the trigger.
 *
 * This event is the LOAD-BEARING half of hiding the capture surface: without it
 * `overlayOpen` would latch true for the rest of the journey and an applicant who
 * backed out would be left with no capture and no way back. The SDK emits it whenever
 * the host of the overlay supplies an `onClose`, and on this `<ChecktivJourney>` path
 * the SDK supplies its own internally, so it always fires here.
 */
function isCrossDeviceClosed(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_closed";
}

/**
 * The SDK could not start the cross-device handoff: either the one-time-link mint failed
 * at open time, or a "Get a new code" re-mint failed while the QR panel was already up.
 *
 * The SDK mounts (or switches to) an "unavailable" panel carrying ONE thing: the
 * `unavailableMessage` string this page supplies. It has no Back and no Try again - the
 * panel's unavailable arm ignores the close handlers its QR arms use - so the SDK will
 * never emit `cross_device_closed` from here and the panel stays on screen until the
 * journey unmounts. That makes this the one overlay state the host must NOT hide the
 * capture behind: with no control on the panel and no way to close it, hiding the capture
 * would leave the applicant with nothing to do. The host restores the capture surface
 * (the remaining path to finish) and retires the trigger, which the SDK has by now made a
 * permanent no-op (see `handoffSpent`).
 */
function isCrossDeviceUnavailable(event: ChecktivEvent): boolean {
	return event.type === "checktiv.idv.cross_device_unavailable";
}

/**
 * The applicant finished CAPTURE. `checktiv.idv.submitted` is terminal-for-capture and
 * NOTHING MORE: it says the images are in, never that they passed. The pass / fail /
 * needs-review decision is made server-side afterwards and is delivered to YOUR backend
 * on the signed `kyc.session.*` webhook, which is the only outcome anchor. Never infer a
 * verdict from a client event, and never write applicant copy that implies one - see the
 * "completion is not a verdict" section of the module doc above.
 */
function isCaptureSubmitted(event: ChecktivEvent): boolean {
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
 * Build the collect prefill from a guest-safe reservation read (empty when absent).
 *
 * The reservation stores ONE joined `guestName`. That string is handed over as
 * `referenceName`, which the form shows as read-only context and NEVER submits or seeds
 * a name box with: a whitespace split is wrong for "Garcia Lopez", "van der Berg", every
 * family-name-first name, and every mononym, and a confidently wrong prefill is worse
 * than an empty one because the guest is likely to accept it. The name boxes start empty
 * and the GUEST, who is the only authority on their own name, fills them in.
 *
 * `guestEmail` IS a real prefill: an email address has no internal boundary to guess at,
 * so it seeds the email box verbatim.
 */
function toPrefill(data: { guestName: string; guestEmail: string } | null): CheckInCollectPrefill {
	if (!data) return { referenceName: "", email: "" };
	return { referenceName: data.guestName, email: data.guestEmail };
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

/**
 * Fetch the edge's guess at the guest's country (`GET /api/geo` -> `{ country }`),
 * used to pre-select the address country in the collect form.
 *
 * Deliberately a SEPARATE read from the prefill above, and separate for a reason
 * worth copying: the prefill route needs D1 and answers a structured 501 on the
 * deployed demo, which binds none. Folding the country into that response would
 * have made this feature work locally and never in production. This route reads no
 * storage, so it answers everywhere.
 *
 * Every failure resolves to `null`, which the form reads as "no pre-selection" and
 * handles as an ordinary state. That includes the normal local case: there is no
 * Cloudflare edge in front of `vite dev` or `vite preview`, so `CF-IPCountry` does
 * not exist and this correctly returns `null` on every local run.
 */
async function fetchGeoCountry(): Promise<string | null> {
	try {
		const res = await fetch("/api/geo", { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		if (typeof body !== "object" || body === null) return null;
		const country = (body as Record<string, unknown>).country;
		return typeof country === "string" && country ? country : null;
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
	// Terminal-for-the-APPLICANT states the SDK drives via its callbacks. None of them is
	// a verdict (see the module doc): `complete` on `checktiv.idv.submitted` / `onComplete`
	// means the ID capture is in, `submitted` on a `checktiv.idv.processing` with
	// `reason: "no_renderable_step"` means the details are in and the next check runs
	// server-side with no applicant screen, and `error` is a non-recoverable IDV error
	// (e.g. a cross-device handoff that died on the phone). Each ends the applicant's work
	// on this page; the pass/fail decision happens afterwards and lands on the server.
	const [terminal, setTerminal] = useState<"complete" | "error" | "submitted" | null>(null);
	// The collect gate that precedes the SDK identity journey. The applicant confirms
	// their details (email prefilled from the reservation) and the SDK submits them; only then
	// does `<ChecktivJourney>` mount. `prefill` is the guest-safe reservation read;
	// `prefillReady` flips once that fetch settles (resolved OR failed) so the form seeds
	// its fields exactly once. A failed/absent prefill still readies the form (empty).
	const [collectDone, setCollectDone] = useState(false);
	const [prefill, setPrefill] = useState<CheckInCollectPrefill>(() => toPrefill(null));
	// The edge's country guess for the address dropdown. `null` until the read
	// settles, and `null` forever when there is no usable signal - the form treats
	// both the same way (no pre-selection), so there is no third state to model.
	const [geoCountry, setGeoCountry] = useState<string | null>(null);
	const [prefillReady, setPrefillReady] = useState(false);
	// The cross-device completion poll capped out while a QR code is still on screen.
	// Complementary to `terminal` (never terminal): the overlay stays mounted so the
	// applicant can still finish on their phone; this only surfaces a "still waiting" hint.
	// Everything about it is keyed to a code being visible, because the hint tells the
	// applicant to keep using "the code on screen": it is cleared whenever the overlay goes
	// away (`closeOverlayState`), and it is never raised at all once the handoff is spent
	// (the SDK starts its poll BEFORE it mints, so the poll keeps running behind a failed
	// handoff and will cap even though no code was ever rendered).
	const [stillWaiting, setStillWaiting] = useState(false);
	// The fraud consent gate. `consentPending` shows the disclosure card; the SDK's
	// `onConsent` call parks on a promise whose resolver we stash here, so the
	// applicant's Allow/Not-now click resolves it.
	const [consentPending, setConsentPending] = useState(false);
	const consentResolveRef = useRef<((granted: boolean) => void) | null>(null);
	// Tracks whether the SDK's own cross-device QR overlay is showing a QR the applicant is
	// meant to scan. `cross_device_opened` sets it; `cross_device_closed` (the applicant
	// used the panel's own Back) and `cross_device_unavailable` (no QR was ever rendered)
	// both clear it. While it is true the host hides BOTH its quiet trigger and the camera
	// capture surface, so the handoff replaces the capture rather than sitting beside it.
	// Every path out flips this back to false, which is what makes hiding the capture safe
	// rather than a dead end.
	const [overlayOpen, setOverlayOpen] = useState(false);
	// Latches true on `cross_device_unavailable`: the phone handoff can no longer be
	// started on this journey, so the host must stop offering it.
	//
	// WHY IT LATCHES, verified against @checktiv/sdk-web 1.9.0 rather than assumed. The
	// SDK's idv module keeps ONE overlay object per journey and short-circuits on it:
	// `openCrossDevice()` returns immediately whenever that object is non-null, and it is
	// cleared ONLY when the overlay is dismissed (`onClose`) or the journey is destroyed.
	// A failed mint still creates the object - the SDK mounts its "unavailable" panel and
	// emits `cross_device_unavailable` - and that panel renders ONLY the
	// `unavailableMessage` paragraph, with no Back and no Try again (its `UnavailableArm`
	// takes `copy` and drops the `onBack` / `onRetry` the QR arms use). So nothing ever
	// dismisses it, the overlay object is never cleared, and every later
	// `openCrossDevice()` call is a silent no-op. Leaving the "Continue on your phone"
	// trigger on screen after that would leave the applicant clicking a dead control,
	// which is the dead-end this page's whole cross-device recovery exists to avoid.
	//
	// The same fact is why `cross_device_unavailable` restores the capture surface instead
	// of hiding it behind the panel: with no control to get back from, hiding the capture
	// would strand the applicant with nothing to do.
	const [handoffSpent, setHandoffSpent] = useState(false);
	// A handle onto the SDK journey so the desktop "Continue on your phone" trigger can
	// call `openCrossDevice()`. The SDK owns the mint + QR overlay + completion poll.
	const journeyRef = useRef<ChecktivJourneyHandle>(null);
	// Focus target for the consent modal: the dialog's `onOpenAutoFocus` override lands
	// focus here so the applicant starts on the primary action.
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
		// Both reads in parallel, and BOTH failure-tolerant, so `prefillReady` still
		// flips exactly once and the form still mounts exactly once with everything it
		// is going to get. `Promise.all` is safe here only because neither call can
		// reject (each resolves `null` on any failure).
		void Promise.all([fetchCheckInPrefill(id), fetchGeoCountry()]).then(
			([data, country]) => {
				if (cancelled) return;
				setPrefill(toPrefill(data));
				setGeoCountry(country);
				setPrefillReady(true);
			},
		);
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

	/**
	 * Return to the capture surface: the single state transition every exit from the
	 * cross-device QR shares (the applicant backed out, or the handoff never produced a
	 * code). Clearing `stillWaiting` alongside `overlayOpen` keeps the two honest - the
	 * "still waiting for your phone" hint points at a code on screen, and after this there
	 * is none.
	 */
	function closeOverlayState(): void {
		setOverlayOpen(false);
		setStillWaiting(false);
	}

	// Navigation on SDK events. A non-recoverable IDV error (or a `session_expired`,
	// e.g. a cross-device handoff that died on the phone) is terminal; a cross-device
	// completion-poll cap surfaces a non-terminal "still waiting" hint (the SDK overlay
	// stays open). `checktiv.idv.submitted` ends the applicant's work here (so a consumer
	// wiring only `onEvent` still finishes); `onComplete` below is the canonical signal
	// and sets the same terminal state (idempotent). Neither is a verdict.
	//
	// An if/else chain rather than a `switch` + `assertNever`: `ChecktivEvent` is NOT a
	// closed union. Its third member is an open catch-all
	// (`{ type: `checktiv.${string}`; [k: string]: unknown }`), so no compile-time
	// exhaustiveness witness is available - a `default: assertNever(event)` would not type
	// check against it. The final arm below is the runtime substitute for the case that
	// actually matters.
	const onEvent = (event: ChecktivEvent): void => {
		if (isCaptureSubmitted(event)) setTerminal("complete");
		// A server-side-only next step (no applicant UI) is TERMINAL for the applicant: the
		// details are in and verification runs on its own. NOT an error, and NOT the transient
		// reload-safe `signal_pending` processing variant (which stays live).
		else if (isNoRenderableStep(event)) setTerminal("submitted");
		else if (isTerminalError(event)) setTerminal("error");
		// Only meaningful while a real QR code is on screen: the hint tells the applicant
		// to keep using it. After an unavailable handoff there never was one, so the poll
		// that is still running behind the dead panel must not raise the hint.
		else if (isCrossDeviceCapped(event)) setStillWaiting(!handoffSpent);
		// The SDK opened its QR overlay: it becomes the applicant's whole task, so hide
		// both the host trigger and the camera capture surface underneath.
		else if (isCrossDeviceOpened(event)) setOverlayOpen(true);
		// The applicant backed out of the overlay. Restore the capture surface and the
		// trigger, and drop any "still waiting" hint - it points at a QR code that is no
		// longer on screen, so leaving it up would send the applicant nowhere.
		else if (isCrossDeviceClosed(event)) closeOverlayState();
		// The handoff could not start (or could not be re-minted). Restore the capture
		// surface - it is the applicant's ONLY remaining path, and the SDK's unavailable
		// panel renders no control of its own to get back from - and retire the handoff
		// for the rest of this journey (see `handoffSpent`).
		else if (isCrossDeviceUnavailable(event)) {
			closeOverlayState();
			setHandoffSpent(true);
		}
		// Everything else falls through, and MOST of it should: `ready`, `phase`,
		// `coaching`, `capture_superseded` and the `recoverable: true` capture errors all
		// have their own affordances inside the SDK's capture UI, so a host screen for them
		// would just get in the way.
		//
		// One class must not fall through SILENTLY, though: an error this page does not
		// route to any screen. The likeliest is `sdk_load_failed` from a missing
		// `@checktiv/sdk-web/idv` or `/fraud` import, which is `recoverable: true` (so not
		// terminal here) and has NO SDK UI behind it - the applicant would sit on a blank
		// journey while the host stayed quiet. A console warning is the minimum; a real
		// integration should send this to its error reporter. Note `onEvent` is the whole
		// error stream on this path, so there is no `onError` prop that would catch it.
		else if (isSdkErrorEvent(event)) {
			console.warn(
				`[check-in] unrouted Checktiv error: ${event.type} / ${event.error.code} (recoverable: ${String(event.error.recoverable)}, suggested recovery: ${event.error.recovery}). ${event.error.message}`,
			);
		}
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
						<h2 className="text-base font-medium">Your ID has been submitted</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Thanks. Your ID has been sent for review and nothing more is needed from
							you right now. The property will be in touch if they need anything else.
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
				 * The collect gate that precedes the journey: the "confirm your
				 * details" form (see `CheckInCollectForm`). The applicant sees which
				 * reservation this is, fills in their name parts and the rest, and confirms; the
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
							suggestedCountry={geoCountry}
							onComplete={() => setCollectDone(true)}
						/>
					) : (
						<div className="rounded-md border border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
							Loading your details...
						</div>
					)
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
				 *
				 * `data-checkin-handoff="open"` is the ONE host-owned hook that makes the
				 * cross-device handoff REPLACE the capture surface: `./CheckInPage.css`
				 * hides the SDK's `.idv-capture-root` under it, so while the QR panel is up
				 * the applicant sees the handoff alone instead of a camera frame and a
				 * "scan this with your phone" panel competing for the same attention.
				 *
				 * It is a wrapper + CSS rather than a conditional unmount ON PURPOSE. The
				 * SDK appends its QR overlay INSIDE this journey's own DOM and the journey
				 * owns the completion poll that advances this page when the phone finishes,
				 * so unmounting `<ChecktivJourney>` here would tear down the handoff and the
				 * poll together. Hiding never reparents the capture iframe, so a back-press
				 * restores a LIVE capture surface with no remount.
				 *
				 * KNOWN LIMITATION: that same never-reloaded iframe keeps the CAMERA
				 * ACQUIRED while the QR panel is up, so the applicant's desktop camera
				 * indicator stays lit after they have said they are moving to their phone.
				 * The host cannot fix this: capture runs in a cross-origin iframe, and the
				 * SDK handle exposes no suspend/release (only `destroy()`, which takes the
				 * QR panel and the poll with it). See `./CheckInPage.css` for the full
				 * write-up; the fix belongs in the SDK.
				 */}
				{phase === "active" && scope ? (
					<div data-checkin-handoff={overlayOpen ? "open" : undefined}>
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
					</div>
				) : null}

				{/*
				 * Desktop-only "Continue on your phone" fallback, DEMOTED to a quiet link below
				 * the journey so it never competes with the primary capture flow. It calls the
				 * SDK-native `openCrossDevice()` through the journey `ref`: the SDK mints the
				 * one-time link, opens its own QR overlay, and fires `onComplete` when the phone
				 * finishes, which this page turns into its terminal submitted state (never a
				 * page reload - see `rearmCrossDevice`). Gated to a fine-pointer device so a
				 * phone applicant (who gets immersive capture) never sees it, and hidden while
				 * the SDK's QR overlay is already open (`overlayOpen`) or the consent modal is
				 * up (`showConsent`) so it never competes for attention. `overlayOpen` clears on
				 * `cross_device_closed`, so backing out of the handoff brings this trigger back
				 * rather than stranding the applicant.
				 *
				 * `handoffSpent` is the one state it does NOT come back from: once the SDK has
				 * reported the handoff unavailable, `openCrossDevice()` is a permanent no-op for
				 * this journey (see the `handoffSpent` declaration), so showing the trigger
				 * would show a control that cannot do anything.
				 */}
				{phase === "active" && isDesktop && !overlayOpen && !handoffSpent && !showConsent ? (
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
			 * Fraud CONSENT gate, rendered on the repo's shared Radix-backed `Dialog`
			 * primitive rather than a hand-rolled overlay. That is the whole point: the
			 * applicant MUST make an explicit Allow / Not now choice, and a dialog that
			 * cannot be dismissed is exactly the one that has to get keyboard and viewport
			 * handling right. The primitive supplies the focus TRAP (a hand-rolled
			 * `role="dialog" aria-modal="true"` pair does not constrain `Tab`, so the
			 * journey's controls and the footer links stay reachable behind it), focus
			 * RESTORE on close, body scroll lock, portaling, and a content box that scrolls
			 * when it outgrows the viewport (see `ui/dialog.tsx`).
			 *
			 * The forced choice is preserved on top of it, not traded away for it. TWO things
			 * enforce it, and only one of them is visible in this JSX. First, `open` is fully
			 * CONTROLLED with no `onOpenChange`: the dialog has no way to close itself, so
			 * `showConsent` (and therefore `resolveConsent`) is the only thing that can take
			 * it down. Second, the `preventDefault()` handlers below stop the primitive's
			 * Escape and outside-interaction dismissals at the source, and
			 * `showCloseButton={false}` removes the corner X. The handlers are belt and
			 * braces TODAY - with no `onOpenChange` the dismissals already go nowhere - and
			 * they are kept because wiring one later is the natural next edit, and it would
			 * silently reintroduce an escape hatch out of a gate that must not have one
			 * (a dismissed disclosure leaves `onConsent` parked forever and the journey
			 * stuck). There is therefore no path out except Allow or Not now, which is why
			 * this dialog's reachability matters more than any other in the app.
			 *
			 * `onOpenAutoFocus` is overridden to land focus on "Allow" specifically, so a
			 * keyboard or screen-reader user starts on the primary action rather than
			 * wherever the default focus scan lands.
			 */}
			<Dialog open={showConsent}>
				<DialogContent
					showCloseButton={false}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						allowButtonRef.current?.focus();
					}}
					onEscapeKeyDown={(event) => event.preventDefault()}
					onPointerDownOutside={(event) => event.preventDefault()}
					onInteractOutside={(event) => event.preventDefault()}
					className="sm:max-w-md"
				>
					<DialogHeader>
						<DialogTitle className="text-sm font-medium text-foreground">
							Before you continue
						</DialogTitle>
						<DialogDescription>
							To help prevent fraud, we check device and connection signals while you
							verify your identity. Your ID photos are captured and stored to complete
							verification. If you have questions about your data, contact the property
							that sent you this link. You can decline the fraud check and still finish
							your check-in.
						</DialogDescription>
					</DialogHeader>
					<div className="flex gap-2">
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
				</DialogContent>
			</Dialog>
		</div>
	);
}
