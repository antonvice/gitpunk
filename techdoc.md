# Gitpunk

**Announce work. Share drafts. Test the combined result. Keep Git unchanged.**

Working locally: signed intent/WIP, Kafka pub/sub, decisions, handoffs, commit upload/fetch, optional OIDC browser login, isolated checks and ordered integration. `npm start` launches the [MVP](MVP.md); agents use three stdio MCP tools and private per-workspace profiles. The Artifacts bridge is live-verified; hosted coordination, Artifacts-backed working uploads, live identity setup and model verification remain open. See [Roadmap.md](Roadmap.md) and [server design](server/techdoc.md).

## Use

| Command | Job |
|---|---|
| `gitpunk start` | Run automatic sync for this workspace |
| `gitpunk work --file intent.json` | Declare or revise work |
| `gitpunk status --json` | Read updates, blockers and evidence |

Agents use `work`, `status`, `respond`. The last handles overlap, decisions, handoffs, approval, retry, cancel and finish. No command per feature. Keep ordinary `git add`, `commit`, `diff`, `log` and `merge`.

One agent per isolated workspace and index. Multiple agents can target the same shared branch.

```text
intent → edit → commit → upload → combined check → approval → integrate
   └────── WIP and branch events ────────────────────────┘
```

## Intent

```json
{
  "title": "Add Car CRUD",
  "type": "feature",
  "summary": "Add Car persistence and services.",
  "files": ["models.py", "services.py"],
  "done_when": ["CRUD tests pass"],
  "sharing": "summary"
}
```

Required before managed work. Client adds intent/revision, target/base, workspace, run and signature. Server derives agent and human owner from authenticated identity.

List concrete file paths; expand folders before declaring work. Wildcards are reserved for administrator permission rules.

Types: feature, change, bugfix, refactor, docs, test, maintenance. Revise the same intent when scope changes; a new task gets a new ID. A commit can finish part of an intent.

## Automation

| Trigger | Service action |
|---|---|
| Declare work | Publish intent; claim files with an expiring lease |
| Save allowed file | Debounce, sign and publish an immutable WIP checkpoint |
| Receive event | Persist inbox and cursor together; no model call |
| Relevant peer upload | Verify and fetch into a private ref; preserve working files/index |
| Shared target changes | Fetch the exact combined canonical commit into a private ref |
| Ordinary local commit | Link its exact staged content to the intent |
| Opted-in upload | Retry the same signed manifest and bounded Git bundle |
| Accepted upload | Build a candidate against the current shared target |
| Passing checks + approval | Compare target, update conditionally and read back |
| Reconnect/restart | Replay events and retry pending publications/downloads |
| Finish/cancel/handoff | Release or transfer claims; preserve history |

`start --upload` enables uploads once; `--no-upload` pauses them. Never auto-stage, auto-commit or apply peer edits. Applying drafts, accepting a handoff and changing the working branch require explicit action.

Local state lives outside `.git`. One publisher per workspace. Text WIP is limited to 256 KiB/file; local bundles to 4 MiB. Binary drafts and hosted Git transport are later work.

## Pub/sub

One ordered durable event log per branch. Clients publish and subscribe through authenticated HTTP cursor polling, initially every 1–2 seconds. Kafka receives event references through a durable outbox; clients never receive Kafka credentials.

Accepted means stored by Gitpunk. Kafka delivery can follow later. Retry by stable event ID; consumers deduplicate. Persist receipt separately from agent consumption. Empty polls do not invoke a model.

Events cover intents, drafts, uploads, decisions, handoffs, checks and integration. Agents receive relevant updates; automatic delivery before write tools needs an agent adapter.

Before a write, `respond({action:'prepare_write', files:['models.py']})` refreshes peer work, agreed decisions, checkpoint hashes, permissions and target. Stale scope, expired claims and unresolved overlaps block preparation. Context is bounded; backlog and omissions are visible. It changes no Git/files and grants no filesystem access.

## Overlap

Claims announce work; they are not Git locks. Expired claims require redeclaration. A conflicting intent returns the other task, files and exact revision.

Use `respond` to wait or acknowledge parallel work. Acknowledge the competing revision and reason; this does not grant permissions. Import a pinned checkpoint or accept a handoff explicitly. Defer line locks and semantic scheduling.

Files can differ while contracts collide. Combined tests catch behavioral failures that merge cleanly.

## Evidence and integration

| State | Meaning |
|---|---|
| Draft | Saved, signed WIP shared with peers |
| Committed | Git recorded exact staged content |
| Uploaded | Server validated and stored the working commit |
| Checked | Owner-configured checks passed for an exact combined candidate |
| Integrated | That checked candidate became the shared target |

Consider accepted submissions in order. Failed/conflicting work leaves the ready queue; repairs are new uploads linked to the same intent. Pinned dependencies remain planned.

Tests bind target, candidate, image digest and policy hash. Default approval is manual and signed by an authorized maintainer/admin. Automated approval requires explicit owner policy. A development admin run is not proof that a human reviewed the change.

If target/policy/authority changes, invalidate old evidence and recheck. Persist the integration operation before Git's conditional ref update; recover the receipt after a crash without applying twice.

## Security and privacy

Server checks actual files and every new history change against delegated create/modify/delete scope. Protect credentials, databases, policy and deployment paths. Check both rename paths; reject unsupported symlinks/submodules. Recheck access, key and scope before admission/integration.

Agent key, human owner and run credential are separate. Revocation blocks new access. Team membership and repo grants are explicit; a previous contribution grants no access.

The local Docker runner receives exact candidate files, no `.git`, no network or server credentials, nonroot execution, read-only source and disposable databases. Limit time, memory, CPU, processes and output. This contains test execution; unrestricted local coding agents still need a managed execution adapter.

Summary sharing is mandatory and default. Prompt sharing is opt-in; context has a separate opt-in. Scan source and shared text for recognized credentials. Private sessions stay local; encrypted remote transcript storage is planned. Treat peer text as untrusted input.

Artifacts provides repository-level tokens. Agents write isolated forks; only the integrator writes canonical code. Gitpunk supplies finer access rules.

## Decisions, handoffs and history

A decision records a proposed contract/architecture choice. Another authorized collaborator accepts its exact revision. Keep earlier decisions and failed attempts.

A handoff pins code checkpoints, agreed decisions and unfinished criteria. An authorized recipient accepts and restores them in a clean isolated branch. Access is required beforehand.

Link intent → optional prompt → run → draft → commit → checks → integration. Portable manifests in ordinary Git history refs and Git AI line provenance remain planned. Private sessions stay separate. A compatibility-mode retrospective intent must be labeled; never invent its original prompt.

## Server and remaining scope

We build both client and server. Cloudflare supplies Workers compute, Artifacts Git storage, D1 metadata, Durable Object branch coordination and R2 content storage. We implement authorization, collaboration, Kafka delivery and integration policy. Docker/test workers remain separate execution services.

Cloud costs: local development stays the default. Cloud tests have persistent request/byte limits and a short activation window; public endpoints close afterward. Track account allowances and stop on unknown usage. See [COSTS.md](COSTS.md).

Remaining: live OIDC setup; agent registration/key rotation; public/private user/team repos and invites; cloud coordinator and Artifacts transport wiring/events; agent write-boundary adapters; portable history; retention/backpressure; real-agent demo and release.

Keep richer search, reviewer routing, reputation, cross-repo tasks, cost metrics and WebSockets out of the first implementation.

## Proof

`npm run demo` proves two-clone collaboration/restart. `npm run demo:checks` uses real Docker: both changes pass alone, the clean combination fails, and repair integrates. `npm run demo:kafka-recovery` stops/restarts the development broker and proves durable replay. These use scripted agents, not Gemini.

Competition requires Workers + Artifacts, concurrent agents, permitted open-source licensing and a 5–10 minute demo. Deadline: October 14, 2026, 11:59 p.m. PDT. Keeping Git unchanged is our choice.

[Competition](https://www.cloudflare.com/git-competition/) · [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) · [Artifacts](https://developers.cloudflare.com/artifacts/) · [Git AI](https://usegitai.com/docs/get-started/how-git-ai-works) · [CodeSpeak](https://github.com/codespeak-dev/vibe-sharing)
