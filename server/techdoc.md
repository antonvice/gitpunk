# Gitpunk server

Target server design. The local HTTP/SQLite prototype implements signed collaboration, Kafka publication, working commits, isolated Docker checks and ordered integration. The internal Workers/Artifacts bridge is deployed and live-verified. Production identity and cloud coordination remain open. Run instructions: [README.md](README.md). Client contract: [../techdoc.md](../techdoc.md).

## Responsibility

Cloudflare stores Git and runs our API. We implement identity, access, intents, WIP, pub/sub and integration.

```text
client → Workers API → branch coordinator → durable outbox → Kafka gateway → Kafka
              │               │                                  │
              D1              events/claims                 workers/consumers
              │               │                                  │
              └──── Artifacts: source + isolated forks ─── test runner
                              R2: private drafts/logs
```

Kafka is the event backbone. Clients publish/poll through our API; they never get Kafka credentials. The gateway runs as a small persistent service with a normal Kafka client. Do not assume Workers directly runs a Kafka broker or an unrestricted persistent consumer.

D1 stores accounts/access/repo metadata. A Durable Object per target branch owns claims, ordered events and integration state. R2 stores authorized content. Kafka carries accepted events to backend consumers. Each fact has one owner; Kafka is not another permission database.

## Models

| Model | Minimum fields |
|---|---|
| User | ID, verified auth identity, display name, state |
| Session | User, expiry, revocation |
| Team | ID, slug, owner |
| Membership | Team, user, owner/admin/member role |
| Invite | Team or repo, intended verified identity, role, hashed token, expiry, accepted/revoked |
| Repo | ID, slug, user-or-team owner, public/private, canonical Artifacts ID/name/namespace, state |
| Repo access | Repo, user, reader/contributor/maintainer/admin role |
| Agent | ID, human owner, label, state |
| Agent key | Agent, public signing key, key ID, expiry, revoked |
| Run | Agent, owner, repo, workspace/fork, delegated scope, expiry |
| Branch | Stable ID, repo, ref, current commit, policy revision |
| Intent | Signed revision, run, base, files, summary, criteria, sharing |
| Claim | Branch, intent, paths/operations, generation, expiry |
| Checkpoint | Intent/run, base/result hashes, permitted content references |
| Submission | Intent, source commit, target, acceptance sequence, state |
| Check/approval | Exact candidate, environment/policy, result, authorized actor |
| Event | ID, branch sequence, type, revision, permitted payload reference |
| Contribution | User/agent, intent and integrated commit; historical credit |
| Decision | Intent, author, exact revision, proposal/accepted/superseded state, content |
| Handoff | Sender/recipient run, immutable checkpoint, decisions, unfinished criteria, offered/accepted state |

Repo ownership and visibility are independent. Team repos are private by default. Private discovery, source, drafts, logs and history require access. Public source does not make raw prompts, WIP or team membership public.

A collaborator is someone with an explicit repo role. A contributor has accepted work in its history. A merge never grants access. Removal revokes future access while preserving contribution credit.

## Authentication and registration

Use configured OIDC for human signup/login. The local server implements browser login with PKCE, verified issuer/subject identity, expiring hashed sessions and origin-checked logout. [Setup](AUTH.md) requires an operator-owned provider client; live verification remains pending. CLI session exchange is later work.

The authenticated owner registers an agent's public key. Agent generates the private signing key locally and keeps it in OS-protected storage. A run gets an expiring credential scoped to repo, permitted operations and workspace. Authentication credentials and payload-signing keys are separate.

Owners can rotate/revoke agent keys and run credentials. Agents cannot invite members, alter visibility, edit policy or register other agents unless explicitly delegated within owner authority. Never trust claimed owner IDs or Git author strings as authentication.

Invites are single-use, expiring and bound to the intended verified identity. Creating an invite does not send email until email delivery is implemented and configured; a shareable invite link is enough for P0. Prevent removal of the last team owner.

## Access rules

| Role | Allowed |
|---|---|
| Reader | Read permitted source/history and explicitly shared drafts |
| Contributor | Reader + intents, working-fork uploads and submissions |
| Maintainer | Contributor + review/integrate under branch policy |
| Admin/owner | Manage membership, repo settings and policy |

Team membership supplies configured repo access; explicit repo grants can add external collaborators. Run permissions are the intersection of owner access, delegation and repo/branch policy. Public anonymous access is source-read only through the API, subject to limits.

Authorize every request and content fetch, including polling. Membership removal blocks API immediately; revoke minted Artifacts tokens and use short TTLs to limit residual direct Git access. Previously downloaded copies cannot be recalled. A visibility change does not erase previously public code.

## Pub/sub with Kafka

1. API authenticates, verifies signature, validates scope and routes to the branch coordinator.
2. Coordinator atomically stores domain mutation, event sequence and outbox record.
3. A scheduled/alarm-driven retry dispatcher sends outbox records to the authenticated gateway.
4. Gateway produces to Kafka and acknowledges broker acceptance.
5. Coordinator marks delivery complete. Lost acknowledgements cause safe duplicate delivery.
6. Independent backend consumer groups process events; client polling reads the authoritative branch event log.

Accepted means durably stored by Gitpunk, not necessarily delivered to Kafka yet. Expose delivery lag. Kafka downtime does not lose accepted events; bound backlog and apply backpressure when storage limits are approached.

Start with one `gitpunk.events.v1` topic, fixed partitions and key `repo_id:branch_id`. Dispatch each branch in sequence. Preserve `event_id` and branch sequence; consumers deduplicate and reject/buffer gaps. Partition changes require an ordering migration. One shared consumer group load-balances work; different services need independent groups. Do not create a consumer group per polling client.

Keep raw prompts, secrets and full diffs out of Kafka. Events carry authorized content references; consumers must reauthorize reads. Production uses TLS, broker ACLs and service credentials. Local single-broker plaintext setup is development only.

## Handoffs and decisions

Initial scope: record signed decisions and offers through `/respond`, deliver them in the branch event stream, require authorized acceptance, and retain exact checkpoint/intent references. Receiving a handoff does not grant access or imply approval of its code.

## Small API

| Routes | Job |
|---|---|
| `/auth/*`, `/me` | Human login/session and identity |
| `/agents`, `/agents/:id/keys`, `/runs` | Agent enrollment, keys and delegated runs |
| `/teams`, `/teams/:id/members`, `/invites` | Team and repo invitations/access |
| `/repos`, `/repos/:id/access` | Create/import/discover repos and manage grants |
| `/repos/:id/git-access` | Mint short-lived authorized Git capability |
| `/repos/:id/work`, `/repos/:id/respond` | Intent/scope updates and blocker responses |
| `/repos/:id/checkpoints` | Upload signed WIP/content |
| `/repos/:id/events?after=...`, `/repos/:id/status` | Cursor polling and compact agent state |
| `/repos/:id/submissions` | Commit manifests and integration requests |
| `/internal/artifacts-events`, `/internal/runner-results` | Authenticated platform events/results |

Mutation bodies use versioned schemas, idempotency keys and expected revisions. Validate size/path/hash before storage. Poll responses contain events, next cursor, more flag and suggested delay. Status returns only actionable, authorized state; empty polls do not invoke an LLM.

## Artifacts integration

Use the documented Workers binding; generate types with Wrangler rather than inventing SDK types.

| Product action | Artifacts integration |
|---|---|
| Create repo | `create`; record returned ID/name/remote/default branch |
| Import Git repo | `import`; allowlisted validated source URLs and authorized source credentials |
| Inspect repo | `get` disposable handle, then `info` |
| Create isolated run | `fork`; map fork to run and canonical repo |
| Clone/fetch/push | Standard Git-over-HTTPS with short-lived token |
| Issue/revoke access | `createToken`, `listTokens`, `revokeToken` |
| Browse source/history | `readFile`, `readCommit`, `readTree`, `readBlob`, `log` |
| Observe commits | Artifacts push event subscription, plus periodic ref reconciliation |
| Archive/delete | Mark archived in Gitpunk first; explicit owner action for physical deletion |

Repo-private/public/team behavior is Gitpunk authorization, not an Artifacts namespace flag. Use opaque internal repository names; namespace is a routing boundary, not team authorization.

Artifacts tokens grant repo-level read/write. Agents get write tokens only for isolated forks; the integrator alone writes canonical repos. No path-level restriction is inferred from those tokens. Validate actual candidate diff before canonical admission.

Verify Artifacts callbacks through the documented subscription delivery trust mechanism. Deduplicate and verify the reported ref/commit from storage. Truncated push payloads need follow-up reads; never trust client “push succeeded” alone. Artifacts push events cover committed uploads, not local precommit saves.

Repository provisioning crosses services: reserve a Gitpunk ID, record provisioning state and stable internal name, create/import, then reconcile outcome on retry. Do not create duplicate forks/repos after lost responses. Token plaintext goes only to authorized recipients or secret storage, never logs or Kafka.

The binding exposes reads/forks/token management; do not invent a merge API. The integrator fetches with normal Git, builds/tests a candidate and performs a conditional Git ref update. Prove the exact Artifacts path before calling it working.

## Validation and integration

Earliest accepted eligible submission first, with dependency ordering. Failed work leaves the ready queue.

Runner tests untrusted code in an isolated environment without server secrets or production database access. Results bind candidate hash, environment and policy. Required human approval remains explicit; automated approval is opt-in policy.

One integrator per branch compares expected target, updates conditionally and reads back. If target moves, rebuild/recheck. Persist operation IDs and old/new refs to recover from crashes without duplicate integration. Repo permission and policy are checked again at final admission.

## What we set up now

One Git repository: `client/`, `server/`, `shared/`, `infra/`. No nested `.git` directories. Separate releases/deployment later; shared protocol changes remain one atomic code change.

Local Kafka configuration lives in `infra/compose.yaml`. Worker binding template lives in `server/wrangler.example.jsonc`. Neither is a deployed server. D1/R2 resources, identity provider, Kafka hosting, gateway, runners and Artifacts subscriptions must be provisioned during implementation.

[Internal Artifacts bridge](cloudflare/README.md): live create/fork/push/clone and exact binary reads passed. Read-only/fork permissions and token revocation were verified. The endpoint is disabled after testing; the full cloud coordinator remains planned.

## Sources

[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) · [Artifacts events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) · [Workers setup](https://developers.cloudflare.com/artifacts/get-started/workers/) · [Kafka quickstart](https://kafka.apache.org/quickstart/)
