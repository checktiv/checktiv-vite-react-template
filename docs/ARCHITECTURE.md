# Architecture notes

Design notes for the Checktiv PMS demo: the load-bearing facts an integrator needs
to understand how the guest journey, the reviewer embed, and the stateless Worker
proxy fit together.

## Guest check-in: the `<ChecktivJourney>` React provider

The check-in page renders the applicant journey with `<ChecktivJourney>` from
`@checktiv/sdk-web/react`, the React wrapper around the SDK's zero-lifecycle mount. Its
props mirror the SDK's mount options (`publishableKey`, `fetchToken`, `onEvent`,
`onComplete`, `onConsent`, `layout`, `theme`). The component owns the full SDK lifecycle,
which removes the imperative-mount plumbing a hand-rolled integration would carry:

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
- **The consent disclosure.** `onConsent` calls back into a host-rendered disclosure; the
  passive fraud module collects only after the applicant agrees, and a declined or
  missing gate surfaces a loud error rather than silently skipping collection.
- **The cross-device QR handoff.** The page shows a QR code so a guest can move the
  journey from a desktop to their phone. The fragment-carried `clientToken` is the only
  cross-device shared state, so the same token resumes the session on the second device.
- **Terminal states.** `onComplete` and the `onEvent` stream drive the page's own done,
  error, and expired screens, each with an in-product next step.

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
  `localStorage`). The `client_token` in the guest check-in link is the only
  cross-device shared state.

## Client-bundle boundary (Drizzle must never reach the client bundle)

- `src/shared/reservation-types.ts` is hand-authored and Drizzle-free. Nothing under
  `src/react-app/**` imports `drizzle-orm` or `src/worker/db/**` (not even type-only).
  The Worker route layer maps Drizzle rows to these plain types at the DB boundary.
