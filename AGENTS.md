# AGENTS.md

Guidance for AI assistants (and humans) working in this repo.

## What this repo is

A **read-only reference** that shows how to integrate `@checktiv/sdk-web` and the
Checktiv REST API end to end, framed as a small property-management demo (staff create a
booking, a guest completes identity verification, staff review the outcome). It is a
learning sample, not a production backend: copy the integration patterns, not the mock
auth or the browser-only storage.

Full API and SDK docs: https://docs.checktiv.com

## Copy these files

- **Guest identity-verification journey** -> `src/react-app/routes/CheckInPage.tsx`
  (the `<ChecktivJourney>` component + the URL-fragment token model).
- **Server-side session mint** -> `src/worker/checktiv-proxy.ts`
  (holds the secret key server-side, forwards to the Checktiv REST API).
- **Staff reviewer embed** -> `src/react-app/routes/ReservationDetailPage.tsx` +
  `src/react-app/lib/sdk.ts`.

## Security invariants (MUST preserve)

- The **secret key is server-only**. It is never a `VITE_` var and never enters the
  browser bundle. This is enforced by
  `scripts/assert-no-secret-or-drizzle-in-bundle.mjs` at build time - do not weaken it.
- The **publishable key** (`ah_pk_...`) and the durable `client_token` travel in the URL
  **fragment** (`#ct=...&pk=...`), never the query string, so they are never sent to a
  server or written to logs.
- `onConsent` is **required** whenever the workflow declares the fraud module: the
  passive fraud signals collect only after the applicant agrees.

## Commands

```bash
pnpm install
pnpm dev          # dev server on http://localhost:3000
pnpm test         # Vitest
pnpm build        # type-check + build
pnpm lint         # ESLint
pnpm run deploy   # deploy to Cloudflare Workers
```

## Local-dev gotchas

- Set `AUTH_COOKIE_SECRET` in `.dev.vars` before `pnpm dev`
  (`cp .dev.vars.example .dev.vars`, then `openssl rand -hex 32`). Staff login **fails
  closed** (a 500) without it - the Worker refuses to sign a session cookie with no
  secret.
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

- The `demo` / `demo` staff login is deliberately **fake** mock auth with no per-user
  identity. Never copy it to production; integrate a real IdP and per-user
  session-ownership checks instead.
- Reservations are stored **unencrypted** in the browser's `localStorage` on the
  deployed demo. Do not treat this as a real data store, and never enter real guest PII.
