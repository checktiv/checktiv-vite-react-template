# Checktiv SDK integration demo

A small, self-contained sample app that shows how to add identity verification to a
web product with [Checktiv](https://checktiv.com) - the browser SDK
([`@checktiv/sdk-web`](https://www.npmjs.com/package/@checktiv/sdk-web)) for the guest
journey and the REST API for the backend, wired together end to end.

It's built as a fictional property-management system: staff create a
booking, the guest gets a link, opens it, and completes ID verification and fraud
checks in-page; staff then review the outcome without leaving the app.

**▶ Live demo: [sdk-demo.checktiv.com](https://sdk-demo.checktiv.com)** - bring your own
Checktiv API keys (there's a Setup screen) and try the full flow.

> This is a sample app for learning, not a production template. Use **fake guest data
> only** - a live key runs real, billable verifications against your org.

## What it demonstrates

- **Create a verification session** from your backend (a thin Cloudflare Worker proxy
  that holds your secret key server-side and forwards to Checktiv).
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

If you are integrating Checktiv into your own product, these three files are the pieces
worth copying:

- **Server-side session mint:** [`src/worker/checktiv-proxy.ts`](src/worker/checktiv-proxy.ts) - holds your secret key server-side and forwards to the Checktiv REST API.
- **Guest journey:** [`src/react-app/routes/CheckInPage.tsx`](src/react-app/routes/CheckInPage.tsx) - the `<ChecktivJourney>` mount and the URL-fragment token model.
- **Staff reviewer:** [`src/react-app/routes/ReservationDetailPage.tsx`](src/react-app/routes/ReservationDetailPage.tsx) + [`src/react-app/lib/sdk.ts`](src/react-app/lib/sdk.ts) - the embedded reviewer and its workspace-token wiring.

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

That is the whole integration. The component owns the SDK lifecycle, so there is no glue
code to write around it:

- **No token-refresh code.** `fetchToken` fires once to hand the SDK the durable
  `clientToken` your backend minted; the SDK exchanges and refreshes the short-lived
  working tokens it needs internally.
- **No manual mount or teardown.** The component mounts the capture surface on render and
  destroys it on unmount, including a clean remount under React StrictMode. You never
  touch a ref or an effect.
- **Full-screen mobile capture** with `layout="immersive"`: the capture surface takes
  over the viewport on phones, where most guests scan and finish.
- **Consent gating** through `onConsent`: show your own disclosure, resolve the
  applicant's choice, and the passive fraud module collects only after they agree.
- **Your secret key never reaches the browser.** The backend mints the durable
  `clientToken`; the component runs on the public publishable key alone.

The capture surface takes its color mode from `data-theme` on `<html>` (this demo pins
light and passes no `theme` prop). `<ChecktivJourney>` does accept an optional `theme`
prop if you want to override the brand color, but this demo does not use it.

## Prerequisites

- A [Checktiv](https://checktiv.com) account with API keys: a **secret** key
  (`ah_sk_…`), the matching **publishable** key (`ah_pk_…`), and a **workflow template**
  id (`wt_…`). Test keys run a synthetic flow; live keys run real verifications.
- **Node.js 20+** and **[pnpm](https://pnpm.io)**.

## Quick start

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then set AUTH_COOKIE_SECRET (e.g. openssl rand -hex 32)
pnpm dev                         # http://localhost:3000
```

Set `AUTH_COOKIE_SECRET` in `.dev.vars` before you start the dev server: staff sign-in
fails closed (a 500) without it, because the Worker refuses to sign a session cookie
with no secret. `.dev.vars` is the local-dev secrets file the dev server reads; it is
gitignored, so never commit it.

Open the app, complete **Setup** with your keys, and create a booking. Staff sign-in is
a mock `demo` / `demo` credential.

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
  per-request to the Worker, which forwards it to Checktiv and stores nothing.
- Your **publishable key** is public. It travels in the guest check-in link and lets the
  SDK mount from the guest's own origin.
- The guest journey uses the SDK's durable **client token** flow - the backend mints one
  low-privilege token per applicant and the SDK exchanges and refreshes working tokens
  internally.

## Deploy

The app deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/).

```bash
pnpm run deploy
```

Then, to run the full flow on your deployed origin:

- Set a cookie-signing secret for the staff session:
  `wrangler secret put AUTH_COOKIE_SECRET`
- Register your deployed origin on your publishable key's allowed origins in the Checktiv
  console.

The deployed app is **stateless** - bookings live in the browser's `localStorage`, and
the Worker persists nothing server-side.

## Tech stack

Vite 7 · React 19 · [Hono](https://hono.dev) on Cloudflare Workers ·
[`@checktiv/sdk-web`](https://www.npmjs.com/package/@checktiv/sdk-web) · Tailwind CSS v4
· shadcn/ui · React Router · Vitest.

## Security & disclaimer

This is a **demo**, deliberately minimal so the whole integration is easy to read. It is
**not** a production backend:

- The `demo` / `demo` login is a shared mock credential, not real authentication.
- There is no per-user session-ownership check on the proxy.
- Bookings are stored unencrypted in the browser and are not for real PII.

A production integration must authenticate the end user before creating a session,
verify that user owns a session before minting tokens for it, and rate-limit per user.
Never enter real guest data, and treat a check-in link as sensitive - it carries a
resume-capable token.

Security response headers ship in [`public/_headers`](public/_headers) (Cloudflare
serves it with the static assets). It sets a safe baseline: `frame-ancestors 'none'`,
`X-Content-Type-Options`, HSTS, a strict `Referrer-Policy`, and a `Permissions-Policy`.
It deliberately does NOT set a resource-restricting Content-Security-Policy, because a
wrong `connect-src`/`frame-src` would break the SDK's cross-origin capture iframe and
sdk-api calls. See the comments in that file for how to add a full CSP once you have
allow-listed your Checktiv SDK origins and tested the capture flow.

## Learn more

- [Checktiv developer docs](https://docs.checktiv.com)
- [`@checktiv/sdk-web` on npm](https://www.npmjs.com/package/@checktiv/sdk-web)

## License

MIT
