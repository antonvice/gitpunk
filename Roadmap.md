# Roadmap

Keep ordinary Git, three agent tools and one sync service per workspace. Finish each step with an end-to-end proof; add infrastructure only when the current step needs it.

## Working local MVP

Signed intents, path policy, automatic text WIP, overlap acknowledgement, durable cursor replay/Kafka, shared decisions, pinned handoffs, commit upload/fetch, Docker checks, exact approval, FIFO integration and the branch board work on the Mac. Restarts preserve credentials, drafts and history. Optional OIDC is tested with an offline provider.

The scaling slice adds checkout-free file/tree/diff/ancestry/history/blame APIs, sparse agent workspaces, bounded immutable server/node caches, server commits from signed drafts, selected check sources and concurrent exact checks. [SCALING.md](SCALING.md) records the matched Git baselines and remaining limits.

The separate Workers/Artifacts bridge passed real push/clone, fork isolation, binary read-back and token revocation. The optional R2/DO backend removes the full bare Git mirror: immutable objects, direct source reads, batched disposable Git inputs and recoverable conditional heads work in local workerd. Collaboration/auth remain on one SQLite gateway. Scripted MCP clients prove the workflow; real model execution is unverified.

## Next steps, in order

| Step | Build | Completion gate |
|---|---|---|
| 1. Competition release | Public licensed source, reproducible setup, real-agent walkthrough and 5–10 minute video | A fresh checkout runs; two agents collaborate; every demo claim matches evidence. See [submission](SUBMISSION.md). |
| 2. Artifacts transport | Connect working uploads/peer fetch and canonical integration to the existing Worker bridge; keep a local check mirror | The same collaboration demo uses Artifacts, preserves the exact checked target and retries without duplicate effects. Revoke test tokens and close endpoints. |
| 3. Real access | Live OIDC, human-owned agent enrollment, expiring scoped runs, key rotation and explicit repo grants | A new human enrolls an agent; wrong-repo, removed-member and revoked-key access fail. |
| 4. Private pilot | Repo creation, team invites, owner review; install MCP and intercept managed write tools | Two invited users finish a task without editing private JSON; pre-write checks run automatically and managed agents cannot write protected files. |
| 5. Hosted service | Workers API/UI, Durable Object branch ordering, Artifacts Git, D1/R2 only where needed, authenticated Kafka gateway | Two machines pass the existing flow, offline replay and stale-target tests within an approved monthly budget. |
| 6. Reliable product | Backups/restore, quotas, retention, pagination, audit/export and Git history refs for portable provenance | Restore recovers accepted work; a long-running repo stays bounded; manifests survive ordinary Git history operations. |
| 7. Agent-scale backend | R2 objects/DO heads implemented; next: cloud proof, regional readers, runner pools, large objects and path-history indexes | Test representative dense 100 GB history / 25 GB worktrees, sustained 30,000 checked merges/day, regional failures, revocation and overload. Local synthetic volume and short throughput trials do not close production qualification. |

Steps 1 and 2 form the submission gate. Step 4 is the first usable private product. Step 5 makes it a hosted product. There is no production deployment or agent-sandbox claim today.

Step 7 is a separate scale gate. The R2/DO option avoids a complete server Git copy; its adapter and native Git helper are tested in the real local runtime. The gateway remains a single authority and checks run on this Mac. [Backend limits](server/cloudflare/OBJECTS.md) and [measurements](SCALING.md) define the remaining qualification. A single Artifacts bridge test is insufficient evidence of production scale.

The local large trial passed: 100 GiB logical history/25 GiB worktree, 1 GiB dense data, 2,053 initial commits and 128 real checked integrations in 104.31 seconds. Physical R2 storage was 1.182 GB. This closes the synthetic local volume test; live cloud, representative dense history and daily production demand remain gates.

## Principles

- Git stores code; Gitpunk stores collaboration and verification evidence.
- Server policy is authoritative. Contribution credit never grants access.
- Upload, check, approval and integration are distinct states.
- Claims are expiring coordination notices; sharing files never silently overwrites another checkout.
- Summary sharing is the default. Private/encrypted transcript storage and portable prompt history remain future work.
- Keep [cost limits](COSTS.md): local by default, no continuous cloud traffic without an explicit budget. The daily cost automation stays deleted.

Defer semantic locks, reputation, cross-repo orchestration, rich search and additional commands. [Optional ideas](Suggestions.md) remain proposals.
