# What this demo covers, and what it does not

This is the canonical scope statement for the repo. [`README.md`](../README.md) and
[`AGENTS.md`](../AGENTS.md) both link
here. If a claim anywhere else in this repo disagrees with this file, this file is the one
that was checked against the installed SDK build.

Everything below was verified against `node_modules/@checktiv/sdk-web` at **version 1.9.0**
(the floor `package.json` pins). A later SDK may close some of these gaps.

## Read the SDK's own agent-steering files first

`@checktiv/sdk-web` ships a machine-readable integration contract inside the package this
demo already depends on:

| File | Import specifier | What it is |
| --- | --- | --- |
| `node_modules/@checktiv/sdk-web/dist/agents/manifest.json` | `@checktiv/sdk-web/agents` | JSON: 3 module descriptors, 10 rules, 5 runnable recipes |
| `node_modules/@checktiv/sdk-web/dist/agents/AGENTS.md` | (read from disk) | The prose companion to the manifest |

That manifest is the authoritative SDK contract. **This repo is one concrete wiring of it,
not a replacement for it.** If the two disagree, the manifest wins. An AI agent scaffolding
an integration should load the manifest before writing code.

## The outcome anchor is a signed webhook, and this demo does not have one

This is the single most important thing to take away, and the thing this demo does **not**
show you.

The SDK's own manifest carries it as rule `completion-is-not-a-verdict`:

> The client event `checktiv.idv.submitted` is terminal-for-capture only; it means the
> applicant finished the capture step, NOT that they passed. The decision arrives on your
> server through the signed `kyc.session.*` webhook. Trust the signed webhook as the only
> outcome anchor; never infer a pass/fail from a client event.

What that means for the two halves of this demo:

- **The guest page** treats `checktiv.idv.submitted` as "capture finished" and shows a
  terminal screen. That is a *submission* signal, not a verdict.
- **The staff page** learns the session status by **polling** `GET` session status from the
  browser on a timer. That is a demo shortcut, and the reason for it is that this demo has
  no server-side store at all: the deployed Worker persists nothing, so there is nowhere for
  a webhook delivery to land. A browser poll also stops the moment the staff member closes
  the tab.

**Do not copy the polling shape into a product.** In production your server registers an
HTTPS webhook endpoint, verifies the HMAC signature on every delivery, dedupes on the
delivery id, and writes the outcome to your own store. Your UI then reads your store.

- [Verdict and webhooks](https://docs.checktiv.com/developers/sdks/verdict-and-webhooks) - why the SDK event is not the verdict
- [Create a webhook endpoint](https://docs.checktiv.com/developers/webhooks) - registering the endpoint and picking events
- [Verify webhook signatures](https://docs.checktiv.com/developers/webhooks-verify-signatures) - the HMAC check

The manifest's `webhook-verify-hmac` recipe carries a runnable TypeScript verifier if you
want a starting point on disk.

## Do not copy the key posture

This demo is **bring-your-own-key**: the visitor pastes their own `ah_sk_*` secret key into
the Setup screen, it is held in that tab's `sessionStorage`, and the browser sends it as an
`X-Checktiv-Key` request header on every call to this app's own Worker proxy. The proxy is
stateless: it forwards the key upstream and holds none of its own.

That is defensible **for this demo**, because the visitor is the key's owner and there is no
multi-user product around it. It is not a pattern to copy. In your product the secret key
belongs only in your server's secret store, is never sent from a browser, and is never
accepted from a caller-supplied request header.

[`AGENTS.md`](../AGENTS.md) has the full "out of scope / do not copy" list, which also covers the missing
authentication and the browser-only reservation storage.

## Required SDK imports, by check type

The SDK loads journey modules from a side-effect import. If the session's workflow template
declares a module you have not imported, the SDK **emits a module error event**
(`checktiv.<module>.error` carrying the `sdk_load_failed` code) rather than throwing, so a
host that ignores `onEvent` sees an empty frame and no exception. The message reads
"This session requires the '`<name>`' module. Import '`@checktiv/sdk-web/<name>`' in your app."

One wrinkle in 1.9.0: that message interpolates the internal **module** name, so for a
custom-form session it names `@checktiv/sdk-web/custom_form` with an underscore. The
resolvable subpath is `@checktiv/sdk-web/custom-form` with a hyphen, per the table below.

| Session declares | Import (side effect) | Stylesheet also required | Demonstrated here? |
| --- | --- | --- | --- |
| `id_verification` step | `@checktiv/sdk-web/idv` | `@checktiv/sdk-web/capture-ui/style.css` | Yes |
| `fraud` module | `@checktiv/sdk-web/fraud` | none (headless) | Yes |
| `custom_form` step | `@checktiv/sdk-web/custom-form` | `@checktiv/sdk-web/custom-form/style.css` | **No** - the Setup screen rejects templates with this step |
| `collect_user_info` step | `@checktiv/sdk-web/collect-user-info` | none (host renders the form) | Yes |
| Cross-device QR overlay | `@checktiv/sdk-web/idv/cross-device` | none | Yes |

The cross-device import is the one that fails quietly: without it `openCrossDevice()` logs a
warning and returns instead of opening the overlay.

## SDK entry points this demo never exercises

The package exposes 13 code and stylesheet subpaths plus the `./agents` manifest. These are
the customer-reachable ones this demo does not touch, and what you would use them for:

| Subpath | What it is | Why you might need it |
| --- | --- | --- |
| `./custom-form` + `./custom-form/style.css` | The custom-form step module | Any workflow template with a `custom_form` step. The Setup screen here deliberately rejects those templates rather than half-supporting them. |
| `./capture` | Headless capture controller: `createCaptureController`, the `reducer`, `CaptureEvent`, `CapturePhase`, `isBiometricPhase` | Bring your own capture UI end to end. |
| `./capture-ui` | The JS entry for the SDK's own capture UI. This demo imports only its **stylesheet**, never the JS. | Mount the SDK capture surface outside the managed `idv` module. |
| `./cross-device` | `mountCrossDevice(target, props)` - the bare QR panel, no overlay | Render the handoff panel on a screen you fully control. The managed path used here (`./idv/cross-device`) is the normal customer route. |
| `./agents` | The steering manifest described above | Machine-readable integration contract. |

Capture customization does **not** stop at `layout="immersive"`. If you have a hard brand
requirement, `./capture` plus `./capture-ui` is the supported lower tier. Building against
the SDK's internal DOM class names instead is not supported and will break.

## Mount options and events this demo does not use

`<ChecktivJourney>` accepts more than the demo passes. Notable unexercised options:

- **`copy`** (`MountCopy`) - the whole capture localization seam. All eight keys are
  optional: `cvReject`, `error`, `cameraPolicyBlocked`, `status`, `coaching`, `terminal`,
  `tryAgain`, `frameTitle`. The demo localizes the cross-device overlay (`crossDeviceCopy`)
  but leaves capture copy at its defaults, which reads as though capture strings were not
  host-supplied. They are.
- **`locale`** - not reachable at all on this path. It lives on `ChecktivInitOptions`
  (`init()` / `<ChecktivProvider>`), not on `MountOptions`, so the zero-lifecycle
  `mount(target, opts)` and `<ChecktivJourney>` cannot set it. On the zero-lifecycle path,
  `copy` is the localization seam.
- **`theme.primaryColor`** - accepted; the demo passes no `theme` and takes its color mode
  from `data-theme` on `<html>` instead.
- **`maxWidth`**, **`resumeKey`**, **`shortCode`**, **`fetchImpl`** - unexercised.
  `shortCode` is the prerequisite for the handle's `requestResend(confirmEmail)`
  self-service recovery, which this demo also does not wire.
- **`onError`** - **accepted by the prop type but not forwarded in 1.9.0.** The React
  wrapper's mount config does not include it, so an `onError` handler type-checks and then
  never fires. Handle errors through `onEvent` and the module error events. Re-check this
  on a later SDK version.

On the event stream, the demo handles seven `checktiv.idv.*` arms and none of the
`checktiv.fraud.*` arms. Unhandled and unmentioned elsewhere in this repo:
`checktiv.idv.ready`, `checktiv.idv.phase`, `checktiv.idv.coaching`,
`checktiv.idv.capture_superseded`, `checktiv.fraud.started`, `checktiv.fraud.error`.
`ChecktivError.recovery` (`retry` | `cross_device` | `refresh_session` | `contact_operator`)
is likewise never read here, though it is the SDK's own per-error hint about what to offer
the applicant next.

The staff reviewer embed mounts with `mount('reviewer', ...)` but supplies no `onEvent`, so
the whole `ChecktivWorkspaceEvent` union (navigation and reviewer-side error events) is
unwired in this demo.

## Deliberate omissions that are not gaps

- **`Checktiv.sessions.create`** - the demo calls `POST /v1/sessions` directly instead,
  because it needs the full session response (`id` / `status` / `short_code` /
  `applicant_url`) and the test-mode `expected_outcome` field. The rationale is in
  `src/worker/checktiv-proxy.ts`.
- **`onOpenCrossDevice`** - deliberately not passed. On the working-token plane the SDK
  self-mints the handoff link, which is what you want. Supply this hook only on the
  browser-token plane, where the SDK cannot self-mint.
- **First-party `{ region, mode }` scope** - the guest page must use the publishable-key
  scope so the request carries `X-Publishable-Key` and clears the origin allowlist from a
  third-party origin. See [`ARCHITECTURE.md`](ARCHITECTURE.md).
