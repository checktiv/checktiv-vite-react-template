# Checktiv SDK integration demo

A small, self-contained sample app that shows how to add identity verification to a
web product with [Checktiv](https://checktiv.com) - the browser SDK
([`@checktiv/sdk-web`](https://www.npmjs.com/package/@checktiv/sdk-web)) for the guest
journey and the REST API for the backend. It shows one complete path through the
integration, not the whole SDK surface: [`docs/SCOPE.md`](docs/SCOPE.md) lists exactly what
it covers and what it leaves out.

It's built as a fictional property-management system: staff create a
booking, the guest gets a link, opens it, and completes ID verification and fraud
checks in-page; staff then review the outcome without leaving the app.

**▶ Live demo: [sdk-demo.checktiv.com](https://sdk-demo.checktiv.com)** - bring your own
Checktiv API keys (there's a Setup screen) and try the full flow.

> This is a sample app for learning, not a production template. Use **fake guest data
> only** - a live key runs real, billable verifications against your org.

## What it demonstrates

- **Create a verification session** from your backend (a thin Cloudflare Worker proxy that
  keeps the REST call off the browser's own origin and enforces host-pinning, capability
  least-privilege, and the test-mode `expected_outcome` drop).
- **Render the guest journey** with `<ChecktivJourney>` from `@checktiv/sdk-web/react`:
  document capture, liveness, and consent-gated fraud signals render from one React
  component on an unauthenticated check-in page, using the durable client token and your
  publishable key. No per-request token endpoint to build; the component owns the SDK
  lifecycle.
- **Fraud consent** - a host-owned consent prompt gates the passive fraud module.
- **Embed the reviewer** - staff see the live verification result inside the app via a
  short-lived workspace token.

The app has four pages, all worth reading as integration examples:

| Page | Route | What it shows |
| --- | --- | --- |
| [Setup](src/react-app/routes/SetupPage.tsx) | `/setup` | Bring-your-own-key bootstrap: paste your keys + workflow template |
| [Reservations](src/react-app/routes/ReservationsPage.tsx) | `/reservations` | Create a booking → mint a session → get the check-in link |
| [Reservation detail](src/react-app/routes/ReservationDetailPage.tsx) | `/reservations/:id` | Poll session status + embed the reviewer |
| [Guest check-in](src/react-app/routes/CheckInPage.tsx) | `/checkin/:id` | The applicant journey (`<ChecktivJourney>` from `@checktiv/sdk-web/react`) |

## Files to copy into your own app

If you are integrating Checktiv into your own product, these are the pieces worth
copying. `CheckInPage.tsx` bundles two integrations - the collect-user-info step and the
`<ChecktivJourney>` identity journey - so for a single clean reference on just the
journey mount, read
[The verification journey, in one component](#the-verification-journey-in-one-component)
below instead of the full page.

- **Session mint proxy:** [`src/worker/checktiv-proxy.ts`](src/worker/checktiv-proxy.ts) - a stateless Worker proxy in front of the Checktiv REST API. It host-pins the upstream from the key's region, grants the reviewer only read capabilities, and drops the test-mode `expected_outcome` field outside test mode. **Copy the proxy, not its key posture:** in this demo the *visitor* supplies the secret key from their browser (see [Where the secret key lives](#where-the-secret-key-lives)), which is a demo affordance. In your product the secret key lives only in your server's secret store.
- **Guest journey:** [`src/react-app/routes/CheckInPage.tsx`](src/react-app/routes/CheckInPage.tsx) - the `<ChecktivJourney>` mount and the URL-fragment token model.
- **Guest details form (optional):** [`src/react-app/components/CheckInCollectForm.tsx`](src/react-app/components/CheckInCollectForm.tsx) - the `@checktiv/sdk-web/collect-user-info` integration that runs before the journey mounts. Skip this one if your workflow template has no `collect_user_info` step.
- **Staff reviewer:** [`src/react-app/routes/ReservationDetailPage.tsx`](src/react-app/routes/ReservationDetailPage.tsx) + [`src/react-app/lib/sdk.ts`](src/react-app/lib/sdk.ts) - the embedded reviewer and its workspace-token wiring.
- **Shared modules:** [`src/shared/checktiv-config.ts`](src/shared/checktiv-config.ts) (key parsing and region/mode resolution) and [`src/shared/session-status.ts`](src/shared/session-status.ts) (reducing a live Checktiv session status to your own domain status).

[`src/shared/dev-cell.ts`](src/shared/dev-cell.ts) is a dev-only test hook for pointing
this demo at a non-production Checktiv cell. It is not part of the integration - do not
copy it. It holds no hostnames of its own: the origins come from the gitignored
`.env.local` / `.dev.vars`, are validated to be bare `https` origins, and are pinned
empty for the deployed build. The one part worth borrowing is the rule it documents -
an override origin may come from build or deploy-time environment, never from a request.

## The verification journey, in one component

The check-in page renders the whole applicant journey (document capture, liveness, and
consent-gated fraud signals) from a single React component in `@checktiv/sdk-web/react`:

```tsx
import { ChecktivJourney } from "@checktiv/sdk-web/react";
import "@checktiv/sdk-web/idv";                    // register the identity-verification module
import "@checktiv/sdk-web/fraud";                  // register the consent-gated fraud module
import "@checktiv/sdk-web/capture-ui/style.css";   // required: styles the capture surface

<ChecktivJourney
  publishableKey={publishableKey}
  fetchToken={fetchToken}                          // returns the durable clientToken your backend minted
  onConsent={handleConsent}                        // show a disclosure, resolve the applicant's choice
  onEvent={handleEvent}
  onComplete={({ sessionId }) => markComplete(sessionId)}
  layout="immersive"                               // full-screen capture on phones
/>
```

That is the whole mount. The component owns the SDK lifecycle, so there is no glue code to
write around it:

- **No token-refresh code.** `fetchToken` fires once to hand the SDK the durable
  `clientToken` your backend minted; the SDK exchanges and refreshes the short-lived
  working tokens it needs internally.
- **No manual mount or teardown.** The component mounts the capture surface on render and
  destroys it on unmount, including a clean remount under React StrictMode. You never
  touch a ref or an effect.
- **Full-screen mobile capture** with `layout="immersive"`: the capture surface takes
  over the viewport on phones, where most guests scan and finish.
- **Consent gating** through `onConsent`: show your own disclosure, resolve the
  applicant's choice, and the passive fraud module collects only after they agree. A
  decline is a silent no-op inside the SDK: fraud collection simply never starts, no event
  is emitted, and the identity journey proceeds.
- **Your secret key never reaches the guest's browser.** The backend mints the durable
  `clientToken`; the check-in page runs on the public publishable key and that token alone.

The capture surface takes its color mode from `data-theme` on `<html>` (this demo pins
light and passes no `theme` prop). `<ChecktivJourney>` does accept an optional `theme`
prop if you want to override the brand color, but this demo does not use it.

Two things the snippet above leaves out, both of which the check-in page does wire:

- **Cross-device handoff.** A `ref` on `<ChecktivJourney>` exposes `openCrossDevice()`.
  The demo renders a desktop-only "Continue on your phone" trigger that calls it; the SDK
  mints a single-use handoff link, renders its own QR overlay, and runs the completion
  poll. It needs the `@checktiv/sdk-web/idv/cross-device` import and a `crossDeviceCopy`
  object, or it is a warn-no-op. See [`CheckInPage.tsx`](src/react-app/routes/CheckInPage.tsx).
- **Completion is not a verdict.** `checktiv.idv.submitted` means the applicant finished
  capture, not that they passed. The outcome arrives on your server as a signed webhook.
  This demo has no webhook receiver; see [Scope and limits](#scope-and-limits).

## Scope and limits

[`docs/SCOPE.md`](docs/SCOPE.md) is the canonical statement of what this demo covers and
what it does not: the missing webhook outcome anchor, the SDK entry points it never
exercises, the mount options and events it leaves unwired, and the required-import table by
check type. Read it before treating this repo as the complete SDK contract, and read the
SDK's own machine-readable steering manifest
(`node_modules/@checktiv/sdk-web/dist/agents/manifest.json`, import specifier
`@checktiv/sdk-web/agents`) before scaffolding from it.

### Where the secret key lives

This demo is **bring-your-own-key**. The visitor pastes their own `ah_sk_*` key into Setup,
it is kept in that tab's `sessionStorage`, and the browser sends it as an `X-Checktiv-Key`
header to this app's own Worker, which forwards it upstream and stores nothing. The Worker
holds no key of its own.

That works here because the visitor **is** the key's owner. **It is not a pattern to copy.**
In a real product the end users are not the key owner, so a secret key in web storage is an
org-wide credential any XSS or browser extension can read. Keep the secret key in your
server's secret store, never send it from a browser, and never accept it from a
caller-supplied request header.

## Prerequisites

- A [Checktiv](https://checktiv.com) account with API keys: a **secret** key
  (`ah_sk_…`), the matching **publishable** key (`ah_pk_…`), and a **workflow template**
  id (`wt_…`). Test keys run a synthetic flow; live keys run real verifications.
- **Node.js 20+** and **[pnpm](https://pnpm.io)**.

Once you have keys, expect about 10 minutes to go from a fresh clone to a completed
guest check-in in the UI. This walkthrough assumes a **live-mode** key (a real,
billable verification); seeing the guest capture step render locally also needs the
frontend origin registered (a tunnel, see
[Running the full guest journey locally](#running-the-full-guest-journey-locally)) - or
skip that setup and try the [hosted demo](https://sdk-demo.checktiv.com), whose origin
is already registered.

## Quick start

```bash
pnpm install
pnpm db:migrate:local            # applies the local D1 schema - the reservations table
pnpm dev                         # http://localhost:3000
```

Open the app, complete **Setup** with your keys, and create a booking. There is no
sign-in: this sample has no authentication, so every page and every `/api` route is
open to whoever can reach it. It is bring-your-own-key, so a caller without your
secret key cannot run a verification, and the Worker stores no key of its own.

There is nothing to put in `.dev.vars` to start the dev server. Copy
`.dev.vars.example` to `.dev.vars` only if you want an optional setting from it (for
example `PUBLIC_ORIGIN`); it is gitignored, so never commit it.

Heads up: the full guest check-in and reviewer flows are origin-pinned and cannot
complete on bare `localhost`. To run them end to end, see
[Running the full guest journey locally](#running-the-full-guest-journey-locally) and
serve the app through a stable public host.

### Running the full guest journey locally

Checktiv keys are **origin-pinned**: real verification and the reviewer embed require
the calling origin to be registered on your key, and `localhost` can't be registered.
To exercise the complete flow locally, expose your dev server on a **stable public
hostname** (for example a named [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or ngrok) and use that URL instead of `localhost`:

1. Point a stable hostname at `http://localhost:3000`.
2. Add that hostname to `server.allowedHosts` in `vite.config.ts` (Vite blocks unknown
   hosts by default).
3. Register the origin (e.g. `https://your-host.example.com`, no trailing slash) on your
   publishable key's **allowed origins** in the Checktiv console. See the
   [Checktiv developer docs](https://docs.checktiv.com/developers/sdks/quickstart).

> **That tunnel is public and this app has no sign-in.** In local dev, bookings are
> stored in D1 and `GET /api/reservations` returns every stored guest name and email to
> any caller, so while your tunnel is up, anyone who knows the hostname can read them.
> Use fake guest data only, take the tunnel down when you are done, and put access
> control on the tunnel itself if you need more. The deployed demo is not affected: it
> binds no database and stores nothing server-side.

Or just try the [hosted demo](https://sdk-demo.checktiv.com) - its origin is already
registered.

### Scripts

```bash
pnpm dev       # start the dev server
pnpm test      # run the test suite (Vitest)
pnpm build     # type-check and build
pnpm lint      # lint
```

## How it works

The browser never talks to Checktiv directly for anything that needs the secret key. A
small [Hono](https://hono.dev) Worker serves the single-page app and a thin `/api/*`
layer:

- Your **secret key** is entered in Setup, kept in the browser session only, and sent
  per-request to the Worker, which forwards it to Checktiv and stores nothing. That is a
  demo affordance, not a production shape: see
  [Where the secret key lives](#where-the-secret-key-lives).
- Your **publishable key** is public. It travels in the guest check-in link and lets the
  SDK mount from the guest's own origin.
- The guest journey uses the SDK's durable **client token** flow - the backend mints one
  low-privilege token per applicant and the SDK exchanges and refreshes working tokens
  internally.
- The **outcome** does not come back through the browser. In production a signed webhook
  delivers the verdict to your server. This demo polls session status from the browser
  instead, because it has no server-side store to deliver a webhook into. See
  [`docs/SCOPE.md`](docs/SCOPE.md).

## Deploy

The app deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/).

```bash
pnpm run deploy
```

Then, to run the full flow on your deployed origin, register that origin on your
publishable key's allowed origins in the Checktiv console. There are no secrets to
provision: the deployed Worker holds no key of its own and has no session store.

The deployed app is **stateless** - bookings live in the browser's `localStorage`, and
the Worker persists nothing server-side.

## Tech stack

Vite 7 · React 19 · [Hono](https://hono.dev) on Cloudflare Workers ·
[`@checktiv/sdk-web`](https://www.npmjs.com/package/@checktiv/sdk-web) · Tailwind CSS v4
· shadcn/ui · React Router · Vitest.

## Security & disclaimer

This is a **demo**, deliberately minimal so the whole integration is easy to read. It is
**not** a production backend:

- **There is no authentication.** Every page and every `/api` route answers any
  caller. The demo is bring-your-own-key, so a caller without your secret key cannot
  run a verification, and a per-IP rate limit on `/api/checktiv/*` is the cost ceiling
  on the relay.
- There is no per-user session-ownership check on the proxy.
- The secret key is held in the visitor's browser and sent to the Worker as a request
  header. See [Where the secret key lives](#where-the-secret-key-lives) for why that is
  safe here and wrong in a product.
- There is **no webhook receiver**, so nothing here verifies a signed outcome. The staff
  view polls session status from the browser instead. See [`docs/SCOPE.md`](docs/SCOPE.md).
- In local dev (D1), `GET /api/reservations` returns stored guest names and emails to
  anyone who can reach your dev server, which the guest flow requires you to expose on
  a public tunnel hostname.
- Bookings are stored unencrypted in the browser and are not for real PII.

A production integration must authenticate the end user before creating a session, verify
that user owns a session before minting tokens for it, rate-limit per user, hold the secret
key server-side only, and take the verification outcome from the signed webhook rather than
from a client event.
Never enter real guest data, and treat a check-in link as sensitive - it carries a
resume-capable token.

Security response headers ship in [`public/_headers`](public/_headers) (Cloudflare
serves it with the static assets). It sets a safe baseline: `frame-ancestors 'none'`,
`X-Content-Type-Options`, HSTS, a strict `Referrer-Policy`, and a restrictive
`Permissions-Policy` that grants `camera` to the Checktiv capture origin
(`embed.<region>.checktiv.com`). That grant is what a page needs once it declares a
`camera` allowlist at all: a page with no `Permissions-Policy` works unchanged, but an
allowlist that omits the capture origin stops the applicant before the camera opens.
See [Security headers](https://docs.checktiv.com/developers/sdks/security-headers) and
the comments in that file.

It deliberately does NOT set a resource-restricting Content-Security-Policy, because a
wrong `connect-src`/`frame-src` would break the SDK's cross-origin capture iframe and
sdk-api calls. See the comments in that file for how to add a full CSP once you have
allow-listed your Checktiv SDK origins and tested the capture flow.

`_headers` applies to the deployed Worker and to the preview server, **not** to
`pnpm dev` - the Vite dev server answers every request without these headers. To check
a header change locally, run `pnpm build`, then `pnpm exec vite preview --port 3000`
(the preview server defaults to port 4173; pass the dev port if a tunnel is registered
for it), and read the response headers with
`curl -sI http://localhost:3000/ | grep -i permissions-policy`.

## Learn more

- [What this demo covers, and what it does not](docs/SCOPE.md)
- [Architecture notes](docs/ARCHITECTURE.md)
- [Checktiv developer docs](https://docs.checktiv.com)
- [Verdict and webhooks](https://docs.checktiv.com/developers/sdks/verdict-and-webhooks) - the signed webhook is the only outcome anchor
- [`@checktiv/sdk-web` on npm](https://www.npmjs.com/package/@checktiv/sdk-web)

## License

MIT
