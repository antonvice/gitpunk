# Local server

Use `npm start` for the persistent [local MVP](../MVP.md): server, Kafka, two isolated Git workspaces, sync, checks and the live board. The board accepts its generated `board.profile.json` in tab memory and shows drafts, decisions, handoffs, activity and integration evidence.

```sh
npm run server -- --bootstrap --data-dir=.local/server --port=8787 --kafka-brokers=127.0.0.1:9092
```

Loopback-only Node server; SQLite is the authoritative branch log. Kafka receives references through a durable outbox. Broker downtime leaves accepted events pending for retry. `GET /health` shows delivery state.

`--bootstrap` creates a private `demo` repo and Alice/Bob run credentials in `.local/server/fixture.json` (mode 0600). Existing fixture credentials are reused. This is explicit development authentication, not production registration. Run bearer tokens and public signing keys are separate; revoked/expired credentials and removed repo access fail closed. No secrets belong in Git.

Add `--git-source=/absolute/path/to/repository` once to seed a local bare Git store from trusted source `HEAD`. Accepted agent commits get immutable working refs. Without configured checks, canonical `main` remains unchanged.

Add `--check-config=infra/checks.example.json` to enable owner-configured Docker checks and the integration queue. Pull the pinned image first. Manual approval is the default; use a signed `respond:approve` naming the exact submission/check/target/candidate/policy tuple. Local integration supports configured `main` only. `retry_check` requests new evidence; failed work leaves the ready queue.

`/board` shows intents, WIP diffs, decisions and check evidence. Its run token stays in tab memory; data routes remain authenticated.

Optional [human OIDC login](AUTH.md) uses `--oidc-config` with a private provider configuration. Signup creates a separate human identity without repo grants; agent routes still require signed run credentials. Real provider setup and agent enrollment remain pending.

## API

All repo routes use `/v1/repos/demo/`. Signed mutations use the shared protocol and authenticated run identity.

| Route | Action |
|---|---|
| `POST work` | Declare/revise intent; return accepted scope or overlap blockers |
| `POST checkpoints` | Store an immutable signed text-file draft |
| `POST respond` | Renew, acknowledge overlap, propose/accept decision, offer/accept handoff, cancel/finish |
| `GET events?after=0&branch=main` | Ordered, bounded cursor replay; presence renews unexpired claims |
| `GET status?branch=main` | Intents, claims, decisions, handoffs and delivery state |
| `GET checkpoints/:id` | Authorized full draft content |
| `POST commits` | Validate a signed commit manifest and detached Git bundle; upload working ref |
| `GET commits/:id` | Accepted commit, exact file manifest, signer and provenance |
| `GET commits/:id/bundle` | Authorized bundle and original signed manifest for peer fetch |
| `GET target`, `GET target/bundle` | Server-provenance canonical snapshot and bounded bundle |

Retries with the same event ID/payload return the original response. Reusing the ID for other content fails. State changes, events and delivery records commit together.

Intents, drafts, status and events expose server-derived `actor: {run_id, agent_id, owner_id}`. Client-supplied owner labels never establish identity.

A handoff pins latest file drafts, base, agreed decisions and unfinished criteria. Acceptance creates a recipient continuation intent and releases the source's claims. Repository access is required beforehand.

Uploads run in quarantine. The server recomputes byte hashes/modes and checks every new history change against scope, protected paths and credential rules. Renames check both paths; symlinks/submodules are rejected. Only accepted SQLite records are discoverable. A failed admission may leave an invisible immutable Git ref; replay completes the same ID without duplicate events.

Prototype upload limits: 4 MiB bundle, 16 MiB total new objects, 1 MiB per object, 128 new commits. No submitted code executes during admission.

## Boundary

This runs locally on the Mac with a bare Git store and Docker test containers. It does not deploy Cloudflare resources. Optional human login requires provider configuration and live verification. Local draft baseline hashes remain signed claims; committed uploads are checked against actual Git content. `uploaded` means stored and read back; `checked` and `integrated` require separate exact evidence.

The runner exports exact Git blobs without `.git`, then runs a pinned image as nonroot with read-only source, no network/server credentials, limited resources and disposable DB storage. The coordinator rechecks access/key/policy, invalidates stale checks/approvals, conditionally updates target and recovers lost receipts. Server-generated results are labeled server provenance; they do not claim an agent signature or physical human review.

Production identity setup, enrollment, teams/invites, hosted Git provisioning and retention/backpressure remain in the roadmap. The server prevents unsafe/protected publication; it does not sandbox unrestricted local coding agents. Poll pages are byte-bounded; status/retention remain prototype-sized.
