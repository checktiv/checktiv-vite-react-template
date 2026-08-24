See [AGENTS.md](AGENTS.md) for how to work in and integrate from this repo, and
[docs/SCOPE.md](docs/SCOPE.md) for what this demo does and does not cover.

Three things to load before you write any integration code, because getting them wrong is
expensive and the rest of this repo will not stop you:

1. **Read the SDK's own steering contract first.** `@checktiv/sdk-web` ships
   `dist/agents/manifest.json` (import specifier `@checktiv/sdk-web/agents`) and
   `dist/agents/AGENTS.md` inside this repo's `node_modules`. That manifest is
   authoritative; this repo is one concrete wiring of it. If they disagree, the manifest
   wins.
2. **Completion is not a verdict.** `checktiv.idv.submitted` means the applicant finished
   capture, not that they passed. The outcome arrives on your server as a signed
   `kyc.session.*` webhook and the signature check is the only trust anchor. This demo has
   no webhook receiver and polls session status from the browser instead. Do not copy that.
3. **Run `pnpm db:migrate:local` before `pnpm dev`** on a fresh clone, or the first booking
   fails on a missing D1 table.

Also: the secret key lives in the visitor's browser in this demo (bring-your-own-key). That
is a demo affordance, not a pattern to copy. AGENTS.md "Security invariants" and
"Out of scope / do not copy" have the detail.
