# Architecture notes

Design notes for the Checktiv PMS demo: the load-bearing facts an integrator needs
to understand how the guest journey, the reviewer embed, and the stateless Worker
proxy fit together.

## Guest check-in: the `<ChecktivJourney>` React component

The check-in page renders the applicant journey with `<ChecktivJourney>` from
`@checktiv/sdk-web/react`, the React wrapper around the SDK's zero-lifecycle mount. Its prop
type is the SDK's `MountOptions`, so it accepts more than this demo passes. The integration
props the check-in page sets are `publishableKey`, `fetchToken`, `onConsent`, `onEvent`,
`onComplete`, `crossDeviceCopy` and `layout`, plus a `ref` for the journey handle. Any other
prop on that element belongs to the demo's dev-cell test hook, not to the integration.
`crossDeviceCopy` is load-bearing for the cross-device handoff described below, and this
demo passes no `theme` (color mode comes from `data-theme` on `<html>`). For the options it
does not exercise, and one that does not work in 1.9.0, see [SCOPE.md](SCOPE.md).

The component owns the full SDK lifecycle, which removes the imperative-mount plumbing a
hand-rolled integration would carry:

- It mounts the capture surface on render and calls `destroy()` on unmount, so there is
  no imperative `mount()` call, no container ref, and no teardown effect. It also
  survives React StrictMode's double-invoke (mount, destroy, remount) cleanly.
- `fetchToken` fires once to hand the SDK the durable `clientToken`; the SDK exchanges
  and refreshes the short-lived working tokens internally, so the page holds no
  token-refresh logic.
- The publishable-key scope (`publishableKey` prop) is what sends `X-Publishable-Key`
  and lets the journey mount from the third-party check-in origin (see the origin-policy
  note below); `layout="immersive"` gives full-screen capture on phones.

The component renders the capture surface only. The host page still owns the chrome
around it:

- **Token stash and the link fragment.** The check-in link carries the durable
  `clientToken` and the public `pk` in the URL fragment (`#ct=...&pk=ah_pk_...`), so they
  stay client-side and never hit the server as a query string. The page parses the
  fragment, stashes the values in browser storage so a same-device resume survives a
  reload, and passes them into `fetchToken` and `publishableKey`.
- **The consent disclosure.** `onConsent` calls back into a host-rendered disclosure and
  the passive fraud module collects only after the applicant agrees. The two failure modes
  are not symmetric, and neither one throws:
  - A **declined** gate is a silent no-op inside the SDK. The fraud module simply never
    starts and **no event is emitted**, so the host owns whatever it wants to record about
    the choice. The identity journey proceeds; fraud signals are supplemental.
  - An **absent** `onConsent` on a session whose template declares the fraud module emits a
    `checktiv.fraud.error` event carrying the `sdk_load_failed` code, and skips the module.
- **The cross-device handoff trigger, and only the trigger.** The host does **not** render
  a QR code and must not build one. The host renders a desktop-only affordance that calls
  `openCrossDevice()` on the journey `ref`; from there the SDK owns everything: it mints a
  **fresh single-use handoff link** from its own endpoint on the working-token plane, opens
  its **own** QR and copy-link overlay inside the journey's DOM, runs the completion poll,
  and emits the four cross-device event arms the host reacts to
  (`checktiv.idv.cross_device_opened` / `_unavailable` / `_capped` / `_closed`).

  What the host must supply is the `@checktiv/sdk-web/idv/cross-device` import (without it
  `openCrossDevice()` warn-no-ops) and a `crossDeviceCopy` object for the overlay's strings.

  **Do not encode the `clientToken` into a QR code.** It is a durable, multi-day,
  resume-capable bearer capability, which is exactly why this demo keeps it in the URL
  fragment and off the wire. The SDK's single-use handoff link exists so the durable token
  never has to travel to a second device, and a host-rolled QR of the check-in link throws
  that property away.
- **Terminal states.** `onComplete` and the `onEvent` stream drive the page's own done,
  error, and expired screens, each with an in-product next step. Note that a terminal
  *capture* state is not a verdict: the outcome arrives on your server through a signed
  webhook, which this demo does not receive. See [SCOPE.md](SCOPE.md).

## Guest-path vs reviewer-path origin policy

The guest journey mounts with the publishable-key scope
(`<ChecktivJourney publishableKey={pk} fetchToken={...} />`), and the PUBLIC `pk` is
passed down from the check-in link fragment (`#ct=...&pk=ah_pk_...`). Region and mode are
parsed by the SDK from the `pk`. The reason is origin policy: the guest opens the
check-in page on a THIRD-PARTY customer origin, and only the publishable-key scope sends
`X-Publishable-Key`, which is what lets Checktiv match that origin against the key's
allowlist and answer the CORS preflight. A first-party `{ region, mode }` scope never
sends the `pk`, so the cross-origin mount would be CORS-blocked ("Failed to fetch").

Origin-pinning consequences for local dev:

- The **reviewer embed** mints a `workspace_token` whose `origin` body field must be in
  the org's configured workspace-origin allowlist, else it fails upstream with
  `422 validation_error` / `origin_not_permitted`. Live-key SDK paths are
  org-origin-scoped as well.
- So the demo's deployed origin (and, for exercising the flow locally, a **named**
  tunnel with a stable hostname mapped to `localhost:3000`) must be registered in your
  Checktiv org settings (workspace origin + SDK allowed origins). `vite.config.ts` pins
  `server.port = 3000` so the local origin matches the registered tunnel origin
  byte-for-byte.

Net: exercising the full guest journey and the reviewer both need a registered, stable
origin. Bare `localhost` cannot be registered, so use a tunnel.

## Vite's own host guard also blocks the tunnel

Getting a named tunnel's origin registered with Checktiv is necessary but not
sufficient: Vite 7's dev server has its own, unrelated DNS-rebinding guard
(`server.allowedHosts`, default `[]` -> only `localhost` and IPs are allowed) that 403s
any other `Host` header before the request ever reaches the app. Driving a tunnel
hostname through the running tunnel returns
`403 Blocked request. This host ("...") is not allowed.` until that hostname is added to
`vite.config.ts`'s `server.allowedHosts`.

Consequence: a developer registering a stable tunnel hostname must add it to
`vite.config.ts` locally too (replace the `your-tunnel.example.com` placeholder), or they
will see a Vite-level 403 before they ever get to a Checktiv-level `origin_not_permitted`
error. The two guards are independent and both must pass.

## Persistence posture

- Local dev binds a D1 database (`DB`) and sets `PERSISTENCE=d1`. The deployed Worker
  binds no D1 and stores nothing server-side (`PERSISTENCE=local` -> browser
  `localStorage`).
- Because there is no server-side store, this demo has nowhere for a webhook delivery to
  land, which is why the staff view polls session status from the browser instead. That is
  the demo's largest deliberate omission; see [SCOPE.md](SCOPE.md).
- The demo shares no state across devices of its own. The desktop-to-phone handoff is the
  SDK's: it mints a fresh single-use link server-side and the phone consumes that link into
  the same session. The durable `client_token` stays on the device that received the
  check-in link.

## Client-bundle boundary (Drizzle must never reach the client bundle)

- `src/shared/reservation-types.ts` is hand-authored and Drizzle-free. Nothing under
  `src/react-app/**` imports `drizzle-orm` or `src/worker/db/**` (not even type-only).
  The Worker route layer maps Drizzle rows to these plain types at the DB boundary.
