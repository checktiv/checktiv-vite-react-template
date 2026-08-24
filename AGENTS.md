# AGENTS.md

Guidance for AI assistants (and humans) working in this repo.

## What this repo is

A **read-only reference** that shows ONE complete path through a `@checktiv/sdk-web` +
Checktiv REST API integration, framed as a small property-management demo (staff create a
booking, a guest completes identity verification, staff review the outcome). It is a
learning sample, not a production backend, and it is not the whole SDK surface: copy the
integration patterns, not the access-control posture, the key handling, or the
browser-only storage.

Full API and SDK docs: https://docs.checktiv.com

## Read these before you scaffold anything

1. **The SDK's own agent-steering contract**, already on disk in this repo's
   `node_modules`:
   - `node_modules/@checktiv/sdk-web/dist/agents/manifest.json` (import specifier
     `@checktiv/sdk-web/agents`) - 3 module descriptors, 10 rules, 5 runnable recipes.
   - `node_modules/@checktiv/sdk-web/dist/agents/AGENTS.md` - the prose companion.

   That manifest is authoritative. **This repo is one wiring of it, not a replacement.**
   If the two disagree, the manifest wins.

2. **[`docs/SCOPE.md`](docs/SCOPE.md)** - what this demo covers and, more importantly,
   what it does not: the missing webhook outcome anchor, the customer-reachable SDK
   subpaths it never touches, the mount options and events it leaves unwired, and the
   required-import table by check type.

## Three things you must not get wrong

- **Completion is not a verdict.** `checktiv.idv.submitted` means the applicant finished
  capture, NOT that they passed. The outcome arrives on your server as a signed
  `kyc.session.*` webhook, and verifying that signature is the only trust anchor. **This
  demo has no webhook receiver** - the staff view polls session status from the browser
  because the demo has no server-side store. Do not copy that shape. See
  https://docs.checktiv.com/developers/sdks/verdict-and-webhooks.
- **The secret key is in the browser here.** See the security section below. Do not
  scaffold a product that way.
- **Run `pnpm db:migrate:local` before `pnpm dev`**, or the first booking 500s on a
  missing D1 table.

## Copy these files

- **Guest identity-verification journey** -> `src/react-app/routes/CheckInPage.tsx`
  (the `<ChecktivJourney>` component + the URL-fragment token model).
- **Session mint proxy** -> `src/worker/checktiv-proxy.ts`
  (a stateless Worker in front of the Checktiv REST API: host-pins the upstream from the
  key's region, grants the reviewer read-only capabilities, drops the test-mode
  `expected_outcome` field outside test mode). Copy the proxy shape, NOT its key posture.
- **Staff reviewer embed** -> `src/react-app/routes/ReservationDetailPage.tsx` +
  `src/react-app/lib/sdk.ts`.

## Security invariants (MUST preserve)

- The secret key is never a `VITE_` var and never enters the **built client bundle**.
  `scripts/assert-no-secret-or-drizzle-in-bundle.mjs` enforces that at build time - do not
  weaken it. Note the altitude: that guard proves the key is not build-time inlined. It
  proves nothing about the key being present in the browser at runtime, **which it is** -
  this demo is bring-your-own-key, so the visitor's `ah_sk_*` lives in that tab's
  `sessionStorage` and rides an `X-Checktiv-Key` request header to the Worker. That is a
  demo affordance. See "Out of scope / do not copy" below.
- The **publishable key** (`ah_pk_...`) and the durable `client_token` travel in the URL
  **fragment** (`#ct=...&pk=...`), never the query string, so they are never sent to a
  server or written to logs.
- `onConsent` is **required** whenever the workflow declares the fraud module. Its two
  failure modes differ: if `onConsent` is absent the SDK emits a `checktiv.fraud.error`
  event carrying `sdk_load_failed` and skips the module; if the applicant *declines*, the
  SDK returns silently with no event at all and the identity journey proceeds. Neither
  case throws, so a host that ignores `onEvent` sees nothing.

## Commands

```bash
pnpm install
pnpm db:migrate:local   # REQUIRED before the first run: applies the local D1 schema
pnpm dev                # dev server on http://localhost:3000
pnpm test               # Vitest
pnpm build              # type-check + build
pnpm lint               # ESLint
pnpm run deploy         # deploy to Cloudflare Workers
```

This is the same quick start as `README.md`. Skipping `db:migrate:local` leaves the
`reservations` table missing, so the first `POST /api/reservations` fails with D1's
"no such table" error.

## Local-dev gotchas

- Nothing needs to be set in `.dev.vars` to start `pnpm dev`. The demo has no
  authentication and holds no key of its own, so there is no secret to provision;
  `.dev.vars.example` carries optional settings only.
- Local dev binds D1 and the app has no sign-in, so `GET /api/reservations` serves
  guest name + email to any caller. Since the guest/reviewer flows need a PUBLIC
  tunnel hostname (below), that PII is exposed to anyone who knows the hostname while
  the tunnel is up. Fake guest data only.
- The guest and reviewer flows are **origin-pinned**, so bare `localhost` will not
  complete them. Serve the app through a stable public host (a named tunnel) and add
  that host to `server.allowedHosts` in `vite.config.ts` (replace the
  `your-tunnel.example.com` placeholder), then register the origin on your Checktiv key.

## Token glossary (easy to confuse)

- **Durable `client_token`** - a multi-day, resume-capable applicant token. Minted by
  the server, carried in the check-in link fragment, handed to the SDK via `fetchToken`.
- **SDK working token** - a short-lived token the SDK mints and refreshes *internally*
  from the `client_token`. You never handle it directly.
- **Workspace token** - the short-lived token the staff reviewer iframe uses; minted
  per reviewer mount via the proxy's `workspace-token` route.

## Out of scope / do not copy

- The **bring-your-own-key flow**: `/setup` -> `sessionStorage` -> `X-Checktiv-Key` header
  -> stateless proxy. It is safe here only because the visitor IS the key's owner and
  there is no multi-user product around it. In a real product that puts an org-wide secret
  key in every end user's browser, where any XSS or browser extension can read it, and it
  makes the proxy trust a caller-supplied credential header. Your product's secret key
  belongs in a server secret store only, and the proxy should read it from there.
- The **browser-polled outcome**. There is no webhook receiver and no signature
  verification anywhere in this repo, so nothing here establishes a verdict. See
  [`docs/SCOPE.md`](docs/SCOPE.md).
- There is **no authentication at all**. Every page and every `/api` route answers any
  caller - see the "NO AUTHENTICATION" note in `src/worker/index.ts` for the
  surface-by-surface consequence. What keeps the relay from being abusable is that the
  demo is bring-your-own-key (no key, no spend) plus a per-IP rate limit on
  `/api/checktiv/*`; that rate limit is the only cost ceiling, so never remove or
  weaken it. Before shipping anything like this, integrate a real IdP and scope every
  read to the authenticated caller.
- Reservations are stored **unencrypted** in the browser's `localStorage` on the
  deployed demo. Do not treat this as a real data store, and never enter real guest PII.
